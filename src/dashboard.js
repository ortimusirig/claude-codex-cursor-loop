import { readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { readEventStream } from './event-stream.js';
import { addUsage, EMPTY_USAGE } from './usage.js';

export const DEFAULT_DASHBOARD_PORT = 7331;
export const DASHBOARD_HOST = '127.0.0.1';

function emptyUsage() {
  return { ...EMPTY_USAGE };
}

function emptyRun(directory, overrides = {}) {
  return {
    directory,
    eventsPath: null,
    runId: basename(directory),
    state: 'waiting',
    message: 'Waiting for the event stream to appear.',
    currentStage: null,
    currentType: null,
    lastEventTs: null,
    timeline: [],
    verifiers: { correctness: null, intent: null },
    files: [],
    gateCommands: [],
    tokens: {
      executor: emptyUsage(),
      correctness: emptyUsage(),
      intent: emptyUsage(),
    },
    stalls: [],
    ...overrides,
  };
}

function digestRunDirectory(runDirectory) {
  const directory = resolve(runDirectory);
  let stream;
  try {
    stream = readEventStream(directory, { allowMissing: true });
  } catch (error) {
    return emptyRun(directory, {
      state: 'error',
      message: `Cannot read event stream: ${error.message}`,
    });
  }

  if (!stream.directoryExists) {
    return emptyRun(directory, {
      runId: stream.runId,
      message: `Run directory does not exist yet: ${directory}`,
    });
  }
  if (stream.eventsPath === null) {
    return emptyRun(directory, {
      runId: stream.runId,
      message: `Run directory exists; waiting for events.jsonl: ${directory}`,
    });
  }

  const events = stream.events.filter((event) => event?.runId === stream.runId);
  const tokens = {
    executor: emptyUsage(),
    correctness: emptyUsage(),
    intent: emptyUsage(),
  };
  const verifiers = { correctness: null, intent: null };
  const files = [];
  const gateCommands = [];
  const stalls = [];

  for (const event of events) {
    if (event.stage === 'executor' && event.type === 'finish') {
      tokens.executor = addUsage(tokens.executor, event.tokens);
    }
    if (event.stage === 'verify' && event.type === 'finish'
      && (event.pass === 'correctness' || event.pass === 'intent')) {
      tokens[event.pass] = addUsage(tokens[event.pass], event.tokens);
      verifiers[event.pass] = {
        verdict: event.verdict ?? null,
        verdictSource: event.source ?? event.verdictSource ?? null,
        code: event.code ?? null,
        timedOut: event.timedOut === true,
        ts: event.ts ?? null,
      };
    }
    if (event.stage === 'executor' && event.type === 'file_change'
      && typeof event.file === 'string') {
      files.push({ file: event.file, attempt: event.attempt ?? null, ts: event.ts ?? null });
    }
    if (event.stage === 'gate' && event.type === 'gate_command') {
      gateCommands.push({
        bin: event.bin ?? '',
        args: Array.isArray(event.args) ? event.args : [],
        code: event.code ?? null,
        attempt: event.attempt ?? null,
        timedOut: event.timedOut === true,
        ts: event.ts ?? null,
      });
    }
    if (event.type === 'stalled') stalls.push(event);
  }

  const lastEvent = events.at(-1) ?? null;
  const finished = events.some((event) => event.stage === 'report' && event.type === 'finish');
  return {
    directory,
    eventsPath: stream.eventsPath,
    runId: stream.runId,
    state: finished ? 'finished' : events.length > 0 ? 'running' : 'waiting',
    message: events.length > 0 ? null : 'Event stream is empty; waiting for the first event.',
    currentStage: lastEvent?.stage ?? null,
    currentType: lastEvent?.type ?? null,
    lastEventTs: lastEvent?.ts ?? null,
    timeline: events.map((event) => ({
      ts: event.ts ?? null,
      stage: event.stage ?? 'unknown',
      type: event.type ?? 'unknown',
      attempt: event.attempt ?? null,
      pass: event.pass ?? null,
      verdict: event.verdict ?? null,
    })),
    verifiers,
    files,
    gateCommands,
    tokens,
    stalls,
  };
}

export function buildDashboardSnapshot({ runDirectory, scratchRoot } = {}) {
  if (Boolean(runDirectory) === Boolean(scratchRoot)) {
    throw new TypeError('dashboard requires exactly one of runDirectory or scratchRoot');
  }
  const observedAt = new Date().toISOString();
  if (runDirectory) {
    const sourcePath = resolve(runDirectory);
    return {
      mode: 'run', sourcePath, observedAt, message: null,
      runs: [digestRunDirectory(sourcePath)],
    };
  }

  const sourcePath = resolve(scratchRoot);
  let entries;
  try {
    const stat = statSync(sourcePath);
    if (!stat.isDirectory()) {
      return {
        mode: 'scratch', sourcePath, observedAt,
        message: `Scratch root is not a directory: ${sourcePath}`,
        runs: [],
      };
    }
    // Newest first. Run directory names are ISO-8601 timestamps, so a reverse
    // lexicographic sort is a reverse chronological sort. Oldest-first buries the run
    // you actually opened the page for beneath every historical one — a scratch root
    // that has accumulated a dozen old runs shows a dozen empty cards before the
    // current one.
    entries = readdirSync(sourcePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        mode: 'scratch', sourcePath, observedAt,
        message: `Scratch root does not exist yet: ${sourcePath}`,
        runs: [],
      };
    }
    return {
      mode: 'scratch', sourcePath, observedAt,
      message: `Cannot read scratch root: ${error.message}`,
      runs: [],
    };
  }
  return {
    mode: 'scratch',
    sourcePath,
    observedAt,
    message: entries.length === 0 ? 'No run directories found yet.' : null,
    runs: entries.map((entry) => digestRunDirectory(join(sourcePath, entry.name))),
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const safe = Math.max(0, Math.floor(ms));
  if (safe < 1000) return `${safe} ms`;
  const seconds = Math.floor(safe / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function shortTime(ts) {
  if (typeof ts !== 'string') return '--:--:--';
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(11, 19) : ts;
}

function attempt(value) {
  return value === null || value === undefined ? '' : ` · attempt ${escapeHtml(value)}`;
}

function usageText(usage) {
  return `in ${usage.inputTokens} · cached ${usage.cachedInputTokens} · out ${usage.outputTokens}`
    + ` · reasoning ${usage.reasoningOutputTokens} · cache write ${usage.cacheWriteTokens}`;
}

function renderVerifier(name, verifier) {
  if (verifier === null) {
    return `<div class="verifier pending"><b>${escapeHtml(name)}</b><span>Pending</span></div>`;
  }
  const source = verifier.verdictSource ?? 'unknown';
  if (source === 'none') {
    return `<div class="verifier fail-safe" data-verdict-kind="fail-safe">`
      + `<b>${escapeHtml(name)}</b><strong>${escapeHtml(verifier.verdict ?? 'ISSUES')}</strong>`
      + `<span>verdictSource: none</span>`
      + `<em>No verdict marker found — ISSUES is a fail-safe, not a reviewer finding.</em></div>`;
  }
  const finding = verifier.verdict === 'ISSUES' ? 'Reviewer reported ISSUES' : 'Reviewer verdict';
  return `<div class="verifier reviewer" data-verdict-kind="reviewer">`
    + `<b>${escapeHtml(name)}</b><strong>${escapeHtml(verifier.verdict ?? 'unknown')}</strong>`
    + `<span>verdictSource: ${escapeHtml(source)}</span><em>${finding}</em></div>`;
}

function renderTimeline(timeline) {
  if (timeline.length === 0) return '<p class="muted">No stages emitted yet.</p>';
  return `<ol class="timeline">${timeline.map((event) => {
    const details = [
      event.pass ? `pass ${escapeHtml(event.pass)}` : '',
      event.verdict ? `verdict ${escapeHtml(event.verdict)}` : '',
      event.attempt === null ? '' : `attempt ${escapeHtml(event.attempt)}`,
    ].filter(Boolean).join(' · ');
    return `<li><time>${escapeHtml(shortTime(event.ts))}</time>`
      + `<b>${escapeHtml(event.stage)}</b><span>${escapeHtml(event.type)}</span>`
      + (details ? `<small>${details}</small>` : '') + '</li>';
  }).join('')}</ol>`;
}

function renderRun(run) {
  const age = run.lastEventTs === null
    ? 'no events yet'
    : formatDuration(Date.now() - Date.parse(run.lastEventTs));
  const stateLabel = run.state === 'finished' ? 'Finished' : run.state === 'running'
    ? 'Live' : run.state === 'error' ? 'Read error' : 'Waiting';
  const files = run.files.length === 0 ? '<p class="muted">No files reported.</p>'
    : `<ul class="rows">${run.files.map((file) => `<li><code>${escapeHtml(file.file)}</code>`
      + `<span>attempt ${escapeHtml(file.attempt ?? '?')}</span></li>`).join('')}</ul>`;
  const gates = run.gateCommands.length === 0 ? '<p class="muted">No gate commands reported.</p>'
    : `<ul class="rows">${run.gateCommands.map((command) => {
      const line = [command.bin, ...command.args].filter(Boolean).join(' ');
      const exitClass = command.code === 0 ? 'exit-ok' : 'exit-fail';
      return `<li><code>${escapeHtml(line)}</code><span class="${exitClass}">exit `
        + `${escapeHtml(command.code ?? '?')}${attempt(command.attempt)}`
        + `${command.timedOut ? ' · timed out' : ''}</span></li>`;
    }).join('')}</ul>`;
  const stalls = run.stalls.length === 0 ? '<p class="muted">No stalls.</p>'
    : `<ul class="stalls">${run.stalls.map((stall) => {
      const last = stall.lastEvent ?? {};
      return `<li><strong>STALL</strong><span>${escapeHtml(formatDuration(stall.gapMs))}`
        + ` after ${escapeHtml(last.stage ?? 'unknown')}/${escapeHtml(last.type ?? 'unknown')}</span></li>`;
    }).join('')}</ul>`;

  return `<article class="run-card ${escapeHtml(run.state)}" data-run-id="${escapeHtml(run.runId)}">`
    + `<header><div><h2>${escapeHtml(run.runId)}</h2><p title="${escapeHtml(run.directory)}">`
    + `${escapeHtml(run.directory)}</p></div><span class="state ${escapeHtml(run.state)}">${stateLabel}</span></header>`
    + (run.message ? `<p class="notice">${escapeHtml(run.message)}</p>` : '')
    + `<div class="current"><span>Current stage</span><strong>${escapeHtml(run.currentStage ?? 'not started')}</strong>`
    + `<small>${escapeHtml(run.currentType ?? '')}</small><span>Last event</span>`
    + `<strong class="age" data-last-event-ts="${escapeHtml(run.lastEventTs ?? '')}">${escapeHtml(age)}</strong></div>`
    + '<section><h3>Verifier seats</h3>'
    + renderVerifier('Correctness pass', run.verifiers.correctness)
    + renderVerifier('Intent pass', run.verifiers.intent) + '</section>'
    + '<section><h3>Token usage by seat</h3><dl class="tokens">'
    + `<dt>Executor</dt><dd>${escapeHtml(usageText(run.tokens.executor))}</dd>`
    + `<dt>Correctness</dt><dd>${escapeHtml(usageText(run.tokens.correctness))}</dd>`
    + `<dt>Intent</dt><dd>${escapeHtml(usageText(run.tokens.intent))}</dd></dl></section>`
    + `<section><h3>Files as landed</h3>${files}</section>`
    + `<section><h3>Gate commands</h3>${gates}</section>`
    + `<section><h3>Stalls</h3>${stalls}</section>`
    + `<section><h3>Full stage timeline</h3>${renderTimeline(run.timeline)}</section></article>`;
}

export function renderDashboardContent(snapshot) {
  const message = snapshot.message ? `<section class="empty">${escapeHtml(snapshot.message)}</section>` : '';
  return `${message}${snapshot.runs.map(renderRun).join('')}`;
}

function renderPage(snapshot) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CCC run dashboard</title>
<style>
:root{color-scheme:light dark;--bg:#f4f5f2;--card:#fff;--ink:#18201d;--muted:#65716b;--line:#d9dedb;--ok:#197047;--warn:#9c5a08;--bad:#a32828;--soft:#eef1ef}
@media(prefers-color-scheme:dark){:root{--bg:#111513;--card:#19201d;--ink:#edf2ef;--muted:#a5b0aa;--line:#35403a;--soft:#222b27;--ok:#6ed39e;--warn:#f0ae59;--bad:#ff8b8b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif}body>header{padding:1rem 1.25rem;border-bottom:1px solid var(--line);display:flex;gap:1rem;align-items:end;justify-content:space-between}h1{font-size:1.15rem;margin:0}body>header p{margin:.15rem 0 0;color:var(--muted);word-break:break-all}.connection{white-space:nowrap;color:var(--ok)}main{display:flex;align-items:flex-start;gap:1rem;padding:1rem;overflow-x:auto;min-height:calc(100vh - 70px)}.run-card{background:var(--card);border:1px solid var(--line);border-top:4px solid var(--warn);border-radius:7px;padding:1rem;flex:1 0 360px;min-width:360px;max-width:560px}.run-card.finished{border-top-color:var(--ok)}.run-card.error{border-top-color:var(--bad)}.run-card>header{display:flex;justify-content:space-between;gap:.8rem}.run-card h2{font-size:1rem;margin:0;overflow-wrap:anywhere}.run-card header p{font-size:.72rem;color:var(--muted);margin:.2rem 0;overflow-wrap:anywhere}.state{border:1px solid currentColor;border-radius:999px;padding:.15rem .55rem;height:max-content;font-size:.75rem}.state.finished{color:var(--ok)}.state.error{color:var(--bad)}.state.running{color:var(--warn)}.notice,.empty{padding:.7rem;background:var(--soft);border-radius:5px}.empty{min-width:320px}.current{display:grid;grid-template-columns:auto 1fr;gap:.2rem .65rem;background:var(--soft);padding:.7rem;margin:.8rem 0;border-radius:5px}.current span{color:var(--muted)}.current small{grid-column:2;color:var(--muted)}section{margin-top:1rem}h3{font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 .45rem}.verifier{display:grid;grid-template-columns:1fr auto;gap:.1rem .6rem;border-left:3px solid var(--line);padding:.45rem .6rem;margin:.35rem 0;background:var(--soft)}.verifier span,.verifier em{font-size:.75rem;color:var(--muted)}.verifier em{grid-column:1/-1}.verifier.fail-safe{border-color:var(--warn)}.verifier.reviewer:has(strong:first-of-type){border-color:var(--line)}.tokens{display:grid;grid-template-columns:auto 1fr;gap:.25rem .6rem;margin:0}.tokens dt{font-weight:650}.tokens dd{margin:0;color:var(--muted);font-variant-numeric:tabular-nums}.rows,.stalls{list-style:none;margin:0;padding:0}.rows li,.stalls li{display:flex;justify-content:space-between;gap:.7rem;border-top:1px solid var(--line);padding:.35rem 0}.rows code{overflow-wrap:anywhere}.rows span{white-space:nowrap;color:var(--muted)}.exit-ok{color:var(--ok)!important}.exit-fail{color:var(--bad)!important}.stalls li{justify-content:flex-start;color:var(--bad)}.timeline{list-style:none;margin:0;padding:0;max-height:280px;overflow:auto}.timeline li{display:grid;grid-template-columns:4.8rem 5.5rem 1fr;gap:.35rem;border-left:2px solid var(--line);padding:.25rem .5rem}.timeline time,.timeline span,.timeline small{color:var(--muted)}.timeline small{grid-column:2/-1}.muted{color:var(--muted);margin:.25rem 0}@media(max-width:500px){main{padding:.5rem}.run-card{min-width:calc(100vw - 1rem);flex-basis:calc(100vw - 1rem)}body>header{align-items:start;flex-direction:column}}
</style>
</head>
<body>
<header><div><h1>CCC live run dashboard</h1><p>${escapeHtml(snapshot.sourcePath)}</p></div><span id="connection" class="connection">Connecting…</span></header>
<main id="runs">${renderDashboardContent(snapshot)}</main>
<script>
const connection=document.getElementById('connection');
const runs=document.getElementById('runs');
function duration(ms){ms=Math.max(0,Math.floor(ms));if(ms<1000)return ms+' ms';const s=Math.floor(ms/1000);if(s<60)return s+'s';const m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m'}
function refreshAges(){document.querySelectorAll('[data-last-event-ts]').forEach(function(el){const ts=Date.parse(el.dataset.lastEventTs);if(Number.isFinite(ts))el.textContent=duration(Date.now()-ts)})}
const stream=new EventSource('/events');
stream.addEventListener('snapshot',function(event){const payload=JSON.parse(event.data);runs.innerHTML=payload.html;connection.textContent='Live';refreshAges()});
stream.onopen=function(){connection.textContent='Live'};
stream.onerror=function(){connection.textContent='Reconnecting…'};
setInterval(refreshAges,1000);refreshAges();
</script>
</body>
</html>`;
}

function fingerprint(snapshot) {
  return JSON.stringify({
    mode: snapshot.mode,
    sourcePath: snapshot.sourcePath,
    message: snapshot.message,
    runs: snapshot.runs,
  });
}

function createObserver(options, pollIntervalMs) {
  const clients = new Set();
  let snapshot = buildDashboardSnapshot(options);
  let currentFingerprint = fingerprint(snapshot);
  let disposed = false;

  const send = (response) => {
    const payload = JSON.stringify({ snapshot, html: renderDashboardContent(snapshot) });
    try {
      response.write(`event: snapshot\ndata: ${payload}\n\n`);
    } catch {
      clients.delete(response);
    }
  };
  const refresh = (broadcast = true) => {
    if (disposed) return snapshot;
    const next = buildDashboardSnapshot(options);
    const nextFingerprint = fingerprint(next);
    snapshot = next;
    if (nextFingerprint !== currentFingerprint) {
      currentFingerprint = nextFingerprint;
      if (broadcast) for (const client of clients) send(client);
    }
    return snapshot;
  };
  const poll = setInterval(refresh, pollIntervalMs);
  poll.unref();
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try { client.write(': keepalive\n\n'); } catch { clients.delete(client); }
    }
  }, 15000);
  heartbeat.unref();

  return {
    page() {
      return renderPage(refresh());
    },
    connect(request, response) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
      });
      response.flushHeaders?.();
      // Refresh before registering this response: existing clients receive a newly
      // discovered append, while this client receives exactly one initial snapshot below.
      refresh();
      clients.add(response);
      send(response);
      request.once('close', () => clients.delete(response));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}

export async function startDashboard({
  runDirectory,
  scratchRoot,
  port = DEFAULT_DASHBOARD_PORT,
  pollIntervalMs = 250,
} = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('dashboard port must be an integer from 0 to 65535');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10) {
    throw new TypeError('dashboard poll interval must be an integer of at least 10 ms');
  }
  const options = { runDirectory, scratchRoot };
  // Validate source selection synchronously before occupying a port.
  buildDashboardSnapshot(options);
  const observer = createObserver(options, pollIntervalMs);
  const server = createServer((request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Bad request\n');
      return;
    }
    if (request.method === 'GET' && pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(observer.page());
      return;
    }
    if (request.method === 'GET' && pathname === '/events') {
      observer.connect(request, response);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found\n');
  });
  server.once('close', () => observer.dispose());

  await new Promise((accept, reject) => {
    const onError = (error) => {
      observer.dispose();
      if (error?.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} is already in use on localhost`));
      } else {
        reject(error);
      }
    };
    server.once('error', onError);
    server.listen(port, DASHBOARD_HOST, () => {
      server.off('error', onError);
      accept();
    });
  });

  const actualPort = server.address().port;
  const close = async () => {
    observer.dispose();
    if (!server.listening) return;
    await new Promise((accept, reject) => {
      server.close((error) => error ? reject(error) : accept());
    });
  };
  return {
    server,
    host: DASHBOARD_HOST,
    port: actualPort,
    url: `http://${DASHBOARD_HOST}:${actualPort}/`,
    close,
  };
}
