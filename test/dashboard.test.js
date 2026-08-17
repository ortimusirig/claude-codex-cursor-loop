import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDashboard } from '../src/dashboard.js';
import {
  buildDashboardSnapshot,
  DEFAULT_SESSION_THRESHOLD_HOURS,
  inferSessions,
  MAX_RENDERED_DIFF_BYTES,
  renderDashboardPage,
  renderLogRows,
  renderRunDetail,
  renderSessionList,
  runNeedsAttention,
  snapshotForClient,
} from '../src/dashboard-view.js';
import { spawnCapture } from '../src/spawn.js';

const cli = fileURLToPath(new URL('../bin/loop.js', import.meta.url));

function event(runId, stage, type, fields = {}) {
  return { ts: new Date().toISOString(), runId, stage, type, ...fields };
}

function makeRun(root, runId, events, suffix = '') {
  const directory = join(root, runId);
  const work = join(directory, 'w');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'events.jsonl'), `${events.map(JSON.stringify).join('\n')}`
    + (events.length > 0 ? '\n' : '') + suffix);
  return { directory, work, eventsPath: join(work, 'events.jsonl') };
}

async function page(dashboard) {
  const response = await fetch(dashboard.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  return response.text();
}

async function openSse(url) {
  return new Promise((resolve, reject) => {
    const request = get(new URL('events', url), (response) => {
      response.setEncoding('utf8');
      let body = '';
      const waiters = new Set();
      response.on('data', (chunk) => {
        body += chunk;
        for (const waiter of waiters) {
          if (waiter.pattern.test(body)) {
            clearTimeout(waiter.timeout);
            waiters.delete(waiter);
            waiter.resolve(body);
          }
        }
      });
      response.on('error', reject);
      resolve({
        response,
        request,
        waitFor(pattern, timeoutMs = 4000) {
          if (pattern.test(body)) return Promise.resolve(body);
          return new Promise((accept, fail) => {
            const waiter = { pattern, resolve: accept, timeout: null };
            waiter.timeout = setTimeout(() => {
              waiters.delete(waiter);
              fail(new Error(`SSE did not contain ${pattern}; received ${body}`));
            }, timeoutMs);
            waiters.add(waiter);
          });
        },
        close() {
          response.destroy();
          request.destroy();
        },
      });
    });
    request.once('error', reject);
  });
}

function snapshotContents(directory) {
  const rows = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      const name = relative(directory, path).split(sep).join('/');
      if (entry.isDirectory()) {
        rows.push({ name: `${name}/`, kind: 'directory' });
        walk(path);
      } else {
        const content = readFileSync(path);
        rows.push({
          name,
          kind: 'file',
          bytes: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
          mtimeMs: statSync(path).mtimeMs,
        });
      }
    }
  };
  walk(directory);
  return rows;
}

test('dashboard starts on loopback, serves one self-contained page, and shows current stage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-page-'));
  const runId = 'run-current-stage';
  const run = makeRun(root, runId, [event(runId, 'executor', 'start', { attempt: 1 })]);
  let dashboard;
  try {
    dashboard = await startDashboard({ runDirectory: run.directory, port: 0 });
    assert.equal(dashboard.host, '127.0.0.1');
    assert.match(dashboard.url, /^http:\/\/127[.]0[.]0[.]1:\d+\/$/);
    const html = await page(dashboard);
    assert.match(html, /CCC live run dashboard/);
    assert.match(html, /Current stage<\/span><strong>executor<\/strong>/,
      'the served document itself must carry the current stage');
    assert.match(html, /new EventSource\('\/events'\)/);
    assert.match(html, /data-view="logs" aria-pressed="false">Logs<\/button>/);
    assert.match(html, /data-view-panel="logs" hidden/);
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/i,
      'the page must make no external asset requests');
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Logs fetches raw cross-run rows on demand, filters problems, and rejects an unknown run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-logs-'));
  const first = 'logs-run-a';
  const second = 'logs-run-b';
  makeRun(root, first, [
    event(first, 'executor', 'item_completed', {
      ts: '2026-08-15T00:00:01.000Z', itemType: 'reasoning', file: 'raw-a.js',
    }),
    event(first, 'executor', 'item_completed', {
      ts: '2026-08-15T00:00:02.000Z', itemType: 'message', tokens: { outputTokens: 9 },
    }),
  ]);
  makeRun(root, second, [
    event(second, 'gate', 'gate_command', {
      ts: '2026-08-15T00:00:03.000Z', bin: 'npm', args: ['test'], code: 0,
    }),
    event(second, 'gate', 'gate_command', {
      ts: '2026-08-15T00:00:04.000Z', bin: 'npm', args: ['run', 'lint'], code: 5,
    }),
  ]);
  let dashboard;
  try {
    dashboard = await startDashboard({ scratchRoot: root, port: 0 });
    const all = await fetch(new URL('logs?runId=all&problemsOnly=false', dashboard.url));
    assert.equal(all.status, 200);
    assert.match(all.headers.get('content-type'), /^text\/html/);
    const allHtml = await all.text();
    assert.match(allHtml, /data-collapsed-count="2"/);
    assert.match(allHtml, /2 executor\/item_completed events/);
    assert.match(allHtml, /raw-a[.]js/,
      'the collapsed children retain raw-only fields and are not discarded');
    assert.match(allHtml, /&quot;outputTokens&quot;: 9/);
    assert.match(allHtml, /data-log-run-id="logs-run-a"/);
    assert.match(allHtml, /data-log-run-id="logs-run-b"/);
    assert.match(allHtml, /npm run lint code=5/,
      'the view uses the shared stage-aware event phrasing');

    const problems = await fetch(new URL('logs?runId=all&problemsOnly=true', dashboard.url));
    assert.equal(problems.status, 200);
    const problemsHtml = await problems.text();
    assert.match(problemsHtml, /npm run lint code=5/);
    assert.doesNotMatch(problemsHtml, /npm test code=0/);
    assert.doesNotMatch(problemsHtml, /raw-a[.]js/);

    const selected = await fetch(new URL(`logs?runId=${first}`, dashboard.url));
    const selectedHtml = await selected.text();
    assert.match(selectedHtml, /data-log-run-id="logs-run-a"/);
    assert.doesNotMatch(selectedHtml, /data-log-run-id="logs-run-b"/);

    const missing = await fetch(new URL('logs?runId=not-a-run', dashboard.url));
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), 'Pass not found\n');
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('log row rendering exposes every folded record when expanded', () => {
  const records = [1, 2].map((index) => ({
    ts: `2026-08-15T00:00:0${index}.000Z`, runId: 'render-group',
    stage: 'executor', type: 'item_completed', itemType: `raw-${index}`,
  }));
  const rows = records.map((record) => ({
    ...record, kind: 'event', sourceRunId: record.runId,
    detail: `item=${record.itemType}`, event: record,
  }));
  const html = renderLogRows([{
    kind: 'group', groupType: 'executor/item_completed', count: 2,
    runId: 'render-group', runIds: ['render-group'], rows, records,
  }]);
  assert.match(html, /data-collapsed-count="2"/);
  assert.equal((html.match(/class="log-row"/g) ?? []).length, 2);
  assert.match(html, /raw-1/);
  assert.match(html, /raw-2/);
});

test('the SSE client snapshot retains its exact pre-Logs field set', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-snapshot-shape-'));
  const runId = 'snapshot-shape';
  const run = makeRun(root, runId, [
    event(runId, 'executor', 'file_change', { file: 'shape.js', attempt: 1 }),
  ]);
  try {
    const client = snapshotForClient(buildDashboardSnapshot({ runDirectory: run.directory }));
    assert.deepEqual(Object.keys(client).sort(), [
      'liveUnits', 'message', 'mode', 'observedAt', 'runs', 'sourcePath',
    ]);
    assert.deepEqual(Object.keys(client.runs[0]).sort(), [
      'currentStage', 'currentType', 'endTs', 'files', 'filesChanged', 'lastEventTs',
      'message', 'needsAttention', 'runId', 'startTs', 'state', 'timeline', 'triage',
    ]);
    assert.equal(Object.hasOwn(client, 'logs'), false);
    assert.equal(Object.hasOwn(client.runs[0], 'events'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an event appended after SSE connects is delivered without a reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-sse-'));
  const runId = 'run-live-append';
  const run = makeRun(root, runId, [event(runId, 'executor', 'start', { attempt: 1 })]);
  let dashboard;
  let stream;
  try {
    dashboard = await startDashboard({ runDirectory: run.directory, port: 0, pollIntervalMs: 25 });
    stream = await openSse(dashboard.url);
    await stream.waitFor(/event: snapshot/);
    appendFileSync(run.eventsPath, `${JSON.stringify(event(runId, 'executor', 'file_change', {
      file: 'src/arrived-live.js', attempt: 2,
    }))}\n`);
    const delivered = await stream.waitFor(/src\/arrived-live[.]js/);
    assert.match(delivered, /attempt 2/,
      'the live payload must include the executor attempt, not only the file name');
  } finally {
    stream?.close();
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a final event truncated mid-write is ignored and does not crash the server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-partial-'));
  const runId = 'run-partial';
  const run = makeRun(root, runId, [event(runId, 'gate', 'start', { attempt: 1 })],
    '{"ts":"2026-08-15T00:00:00.000Z","runId":"run-partial","stage":"executor","type":"file_change","file":"HALF_RECORD');
  let dashboard;
  try {
    dashboard = await startDashboard({ runDirectory: run.directory, port: 0, pollIntervalMs: 25 });
    const first = await page(dashboard);
    assert.match(first, /Current stage<\/span><strong>gate<\/strong>/);
    assert.doesNotMatch(first, /HALF_RECORD/, 'partial JSON must never reach rendered output');
    const second = await page(dashboard);
    assert.doesNotMatch(second, /Read error|HALF_RECORD/,
      'a repeated read proves the server remained healthy');
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing not-yet-created run directory is a clear waiting state and is not created', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-missing-'));
  const missing = join(root, 'future-run');
  let dashboard;
  try {
    dashboard = await startDashboard({ runDirectory: missing, port: 0 });
    const html = await page(dashboard);
    assert.match(html, /Run directory does not exist yet/);
    assert.match(html, /not started/);
    assert.equal(existsSync(missing), false, 'observing a future run must not create it');
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('scratch-root mode represents several runs side by side', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-campaign-'));
  makeRun(root, 'campaign-run-a', [event('campaign-run-a', 'executor', 'start')]);
  makeRun(root, 'campaign-run-b', [event('campaign-run-b', 'gate', 'finish', { verdict: 'passed' })]);
  let dashboard;
  try {
    dashboard = await startDashboard({ scratchRoot: root, port: 0 });
    const html = await page(dashboard);
    assert.match(html, /data-run-id="campaign-run-a"/);
    assert.match(html, /data-run-id="campaign-run-b"/);
    // Newest first: run directories are ISO timestamps, so reverse lexicographic is
    // reverse chronological. 'campaign-run-b' sorts after 'campaign-run-a', so it leads.
    assert.match(html, /<main id="runs">[\s\S]*campaign-run-b[\s\S]*campaign-run-a/);
    assert.match(html, /main\{display:flex/,
      'campaign cards must use a horizontal side-by-side layout');
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('scratch-root lists the newest run first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-order-'));
  // Real run-directory names: ISO-8601 timestamps. Deliberately created oldest-first so
  // a listing that simply preserves readdir/ascending order fails this test.
  const oldest = '2026-08-05T04-19-31-854Z-aaaaaaaa';
  const middle = '2026-08-15T02-12-37-942Z-bbbbbbbb';
  const newest = '2026-08-15T08-10-09-664Z-cccccccc';
  for (const id of [oldest, middle, newest]) {
    makeRun(root, id, [event(id, 'executor', 'start')]);
  }
  let dashboard;
  try {
    dashboard = await startDashboard({ scratchRoot: root, port: 0 });
    const html = await page(dashboard);
    const order = [...html.matchAll(/data-run-id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(order, [newest, middle, oldest],
      'the run you opened the page for must not be buried beneath historical runs');
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('dashboard shows both labelled reviews, provenance, consistency, rationale, and VS Code command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-verdict-'));
  const runId = 'run-verdict-source';
  const run = makeRun(root, runId, [
    event(runId, 'verify', 'finish', {
      pass: 'correctness', verdict: 'ISSUES', source: 'none', tokens: { inputTokens: 11 },
    }),
    event(runId, 'verify', 'finish', {
      pass: 'intent', verdict: 'ISSUES', source: 'assistant', tokens: { outputTokens: 7 },
    }),
    event(runId, 'report', 'finish', { file: 'ccc-runfacts.json' }),
  ]);
  writeFileSync(join(run.work, 'ccc-runfacts.json'), JSON.stringify({
    runId,
    verdict: 'ISSUES',
    verdictSource: 'none',
    verifierFindings: 'Correctness output retained without a terminal marker.',
    verifierConsistency: { status: 'consistent' },
    intentVerdict: 'ISSUES',
    intentVerdictSource: 'assistant',
    intentVerifierFindings: 'Intent review found the requested failure path missing.',
    intentVerifierConsistency: { status: 'disagreement' },
    iterations: [{
      lastMessage: 'Kept the local diff intact so the human can inspect every changed line.',
      verifier: {
        verdict: 'ISSUES', verdictSource: 'none',
        verdictConsistency: { status: 'consistent' },
      },
      intentVerifier: {
        verdict: 'ISSUES', verdictSource: 'assistant',
        verdictConsistency: { status: 'disagreement' },
      },
    }],
  }));
  let dashboard;
  try {
    dashboard = await startDashboard({ runDirectory: run.directory, port: 0 });
    const html = await page(dashboard);
    assert.match(html, /data-verdict-kind="fail-safe"[\s\S]*verdictSource: none[\s\S]*ISSUES is a fail-safe, not a reviewer finding/);
    assert.match(html, /data-verdict-kind="reviewer"[\s\S]*verdictSource: assistant[\s\S]*Reviewer reported ISSUES/);
    assert.match(html, /Correctness pass retained output \(not authoritative reviewer findings\)[\s\S]*Correctness output retained without a terminal marker/,
      'the correctness pass must be labelled and include its retained text');
    assert.match(html, /Intent pass findings[\s\S]*Intent review found the requested failure path missing/,
      'the intent pass must be labelled and include its findings');
    assert.match(html, /Correctness pass[\s\S]*Consistency: consistent/);
    assert.match(html, /Intent pass[\s\S]*Consistency: disagreement/);
    assert.match(html, /Executor rationale[\s\S]*Kept the local diff intact/);
    assert.ok(html.includes(`code &quot;${run.work}&quot;`),
      `VS Code command must use the actual worktree directory ${run.work}`);
    assert.match(html, /Correctness[\s\S]*in 11/);
    assert.match(html, /Intent[\s\S]*out 7/);
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the run card renders completion, ordered stages, gate exits, seat tokens, and stalls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-details-'));
  const runId = 'run-full-details';
  const run = makeRun(root, runId, [
    event(runId, 'executor', 'finish', {
      attempt: 1, code: 0, tokens: { inputTokens: 20, outputTokens: 4 },
    }),
    event(runId, 'executor', 'file_change', { file: 'src/detail.js', attempt: 1 }),
    event(runId, 'gate', 'gate_command', {
      bin: 'node', args: ['--test', 'test/detail.test.js'], code: 7, attempt: 1,
    }),
    event(runId, 'executor', 'stalled', {
      gapMs: 61000, lastEvent: { stage: 'gate', type: 'gate_command' },
    }),
    event(runId, 'verify', 'finish', {
      pass: 'correctness', verdict: 'NO_BLOCKERS', source: 'result',
      tokens: { cachedInputTokens: 3, reasoningOutputTokens: 2 },
    }),
    event(runId, 'report', 'finish', { file: 'ccc-runfacts.json' }),
  ]);
  let dashboard;
  try {
    dashboard = await startDashboard({ runDirectory: run.directory, port: 0 });
    const html = await page(dashboard);
    assert.match(html, /class="state finished">Finished/,
      'report/finish must turn the card into an explicit finished state');
    assert.match(html, /src\/detail[.]js<\/code><span>attempt 1/);
    assert.match(html, /node --test test\/detail[.]test[.]js<\/code><span class="exit-fail">exit 7/);
    assert.match(html, /Executor<\/dt><dd>in 20 · cached 0 · out 4/);
    assert.match(html, /Correctness<\/dt><dd>in 0 · cached 3 · out 0 · reasoning 2/);
    assert.match(html, /<strong>STALL<\/strong><span>1m 1s after gate\/gate_command/);
    const timeline = html.slice(html.indexOf('Full stage timeline'));
    const orderedStages = ['executor</b><span>finish', 'executor</b><span>file_change',
      'gate</b><span>gate_command', 'executor</b><span>stalled',
      'verify</b><span>finish', 'report</b><span>finish'];
    let cursor = -1;
    for (const stage of orderedStages) {
      const next = timeline.indexOf(stage, cursor + 1);
      assert.ok(next > cursor, `timeline is missing or reordered at ${stage}`);
      cursor = next;
    }
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('dashboard serving and SSE observation leave every run byte unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-readonly-'));
  const runId = 'run-readonly';
  const run = makeRun(root, runId, [
    event(runId, 'executor', 'file_change', { file: 'src/a.js', attempt: 1 }),
    event(runId, 'report', 'finish', { file: 'ccc-runfacts.json' }),
  ], '{"unfinished":');
  writeFileSync(join(run.work, 'operator-note.txt'), 'must remain byte-for-byte identical\n');
  writeFileSync(join(run.work, 'CHANGES.diff'), '--- a/src/a.js\n+++ b/src/a.js\n-old\n+new\n');
  writeFileSync(join(run.work, 'ccc-runfacts.json'), JSON.stringify({
    runId,
    verdict: 'NO_BLOCKERS',
    verdictSource: 'result',
    verifierFindings: 'No correctness blockers.',
    verifierConsistency: { status: 'consistent' },
    intentVerdict: 'NO_BLOCKERS',
    intentVerdictSource: 'assistant',
    intentVerifierFindings: 'The implementation matches the task.',
    intentVerifierConsistency: { status: 'consistent' },
    iterations: [{ lastMessage: 'Implemented the reviewed change.' }],
  }));
  mkdirSync(join(run.work, 'nested'));
  writeFileSync(join(run.work, 'nested', 'binary.bin'), Buffer.from([0, 1, 2, 255]));
  const before = snapshotContents(run.directory);
  let dashboard;
  let stream;
  try {
    dashboard = await startDashboard({ runDirectory: run.directory, port: 0, pollIntervalMs: 25 });
    const html = await page(dashboard);
    assert.match(html, /class="state finished">Finished/);
    const logs = await fetch(new URL('logs?runId=all', dashboard.url));
    assert.equal(logs.status, 200);
    await logs.text();
    stream = await openSse(dashboard.url);
    await stream.waitFor(/event: snapshot/);
  } finally {
    stream?.close();
    await dashboard?.close();
  }
  try {
    assert.deepEqual(snapshotContents(run.directory), before,
      'names, bytes, hashes, and mtimes must remain identical after HTTP and SSE reads');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the dashboard command reports an occupied fixed port instead of rebinding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-port-'));
  const run = makeRun(root, 'run-port', [event('run-port', 'isolate', 'start')]);
  let occupying;
  try {
    occupying = await startDashboard({ runDirectory: run.directory, port: 0 });
    const result = await spawnCapture(process.execPath, [
      cli, 'dashboard', run.directory, '--port', String(occupying.port),
    ]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '', 'a failed start must not print a misleading URL');
    assert.match(result.stderr, new RegExp(`dashboard failed: port ${occupying.port} is already in use on localhost`));
  } finally {
    await occupying?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function triageRun(runId, startTs, overrides = {}) {
  return {
    runId,
    startTs,
    endTs: startTs,
    gateResult: 'passed',
    verifiers: {
      correctness: { verdict: 'NO_BLOCKERS', verdictSource: 'result' },
      intent: { verdict: 'NO_BLOCKERS', verdictSource: 'assistant' },
    },
    ...overrides,
  };
}

test('session inference groups the just-under gap and splits the just-over gap', () => {
  const newest = triageRun('newest', '2026-08-15T04:00:00.000Z');
  const justUnder = triageRun('just-under', '2026-08-15T02:00:01.000Z');
  const justOver = triageRun('just-over', '2026-08-14T23:59:59.000Z');
  const sessions = inferSessions([justUnder, justOver, newest], DEFAULT_SESSION_THRESHOLD_HOURS);
  assert.deepEqual(sessions.map((session) => session.runs.map((run) => run.runId)), [
    ['newest', 'just-under'],
    ['just-over'],
  ], '1:59:59 must stay in one session while the consecutive 2:00:02 gap starts another');
});

test('changing the heuristic threshold regroups the same passes', () => {
  const runs = [
    triageRun('three', '2026-08-15T04:00:00.000Z'),
    triageRun('two', '2026-08-15T02:00:01.000Z'),
    triageRun('one', '2026-08-14T23:59:59.000Z'),
  ];
  assert.deepEqual(inferSessions(runs, 2).map((session) => session.passCount), [2, 1]);
  assert.deepEqual(inferSessions(runs, 2.01).map((session) => session.passCount), [3],
    'raising the on-page threshold above both boundary gaps must combine the same passes');
});

test('needs-attention includes every qualifying seat and excludes a clean pass', () => {
  const clean = triageRun('clean', '2026-08-15T00:00:00.000Z');
  const cases = [
    ['failed gate', { gateResult: 'failed' }],
    ['correctness issues', {
      verifiers: { ...clean.verifiers, correctness: { verdict: 'ISSUES', verdictSource: 'assistant' } },
    }],
    ['intent issues', {
      verifiers: { ...clean.verifiers, intent: { verdict: 'ISSUES', verdictSource: 'assistant' } },
    }],
    ['correctness no verdict', {
      verifiers: { ...clean.verifiers, correctness: { verdict: 'ISSUES', verdictSource: 'none' } },
    }],
    ['intent no verdict', {
      verifiers: { ...clean.verifiers, intent: { verdict: 'ISSUES', verdictSource: 'none' } },
    }],
  ];
  for (const [name, fields] of cases) {
    assert.equal(runNeedsAttention({ ...clean, ...fields }), true, `${name} must need attention`);
  }
  assert.equal(runNeedsAttention(clean), false, 'a passed gate and two clean verdicts must be excluded');
});

test('session rows count all and attention-needing passes independently', () => {
  const runs = [
    triageRun('failed', '2026-08-15T01:00:00.000Z', { gateResult: 'failed' }),
    triageRun('clean', '2026-08-15T00:30:00.000Z'),
    triageRun('unknown', '2026-08-15T00:00:00.000Z', {
      verifiers: {
        correctness: { verdict: 'ISSUES', verdictSource: 'none' },
        intent: { verdict: 'NO_BLOCKERS', verdictSource: 'assistant' },
      },
    }),
  ];
  const [session] = inferSessions(runs, 2);
  assert.equal(session.passCount, 3);
  assert.equal(session.attentionCount, 2);
  const displayRuns = runs.map((run) => ({
    ...run,
    needsAttention: runNeedsAttention(run),
    filesChanged: [],
    triage: {
      gate: { kind: run.gateResult === 'failed' ? 'issues' : 'clean', text: run.gateResult },
      correctness: { kind: 'clean', text: run.verifiers.correctness.verdict },
      intent: { kind: 'clean', text: run.verifiers.intent.verdict },
    },
  }));
  const html = renderSessionList(displayRuns, 2, false);
  assert.match(html, />3 passes</);
  assert.match(html, />2 need attention</,
    'the rendered session summary must report the computed attention count');
});

test('triage is the default collapsed view with visible heuristic and attention controls', () => {
  const run = triageRun('default-triage', '2026-08-15T00:00:00.000Z');
  const snapshot = {
    sourcePath: 'portable-fixture', message: null, runs: [{
      ...run,
      state: 'finished', message: null, endTs: run.startTs, currentStage: 'report',
      currentType: 'finish', lastEventTs: run.startTs, timeline: [], files: [],
      filesChanged: [], triage: {
        gate: { kind: 'clean', text: 'Passed — fine' },
        correctness: { kind: 'clean', text: 'NO_BLOCKERS — fine' },
        intent: { kind: 'clean', text: 'NO_BLOCKERS — fine' },
      }, needsAttention: false, directory: 'portable-fixture', worktreeDirectory: 'portable-fixture',
      verifiers: run.verifiers, tokens: { executor: {}, correctness: {}, intent: {} },
      gateCommands: [], stalls: [], executorRationale: null,
      diff: { message: 'not available', text: '', byteCount: 0, renderedByteCount: 0, capped: false },
    }], liveUnits: [], mode: 'scratch', observedAt: run.startTs,
  };
  const html = renderDashboardPage(snapshot);
  assert.match(html, /data-view="triage" aria-pressed="true"/);
  assert.match(html, /data-view-panel="triage">/);
  assert.match(html, /data-view-panel="live" hidden/);
  assert.match(html, /data-view-panel="detail" hidden/);
  assert.match(html, /data-view-panel="logs" hidden/);
  assert.match(html, /Inferred session gap threshold[\s\S]*value="2"[\s\S]*Heuristic only/);
  assert.match(html, /id="attention-only" type="checkbox" checked/);
  assert.match(html, /<details class="session"[^>]*>/);
  assert.doesNotMatch(html, /<details class="session"[^>]*\sopen(?:\s|>)/,
    'sessions must be collapsed by default');
});

test('unified diff renders additions and removals with distinct line meanings', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-diff-'));
  const runId = 'run-real-diff';
  const run = makeRun(root, runId, [
    event(runId, 'report', 'finish', { ts: '2026-08-15T00:00:00.000Z' }),
  ]);
  writeFileSync(join(run.work, 'CHANGES.diff'), [
    '--- a/src/value.js',
    '+++ b/src/value.js',
    '@@ -1 +1 @@',
    '-const value = "before";',
    '+const value = "after";',
    '',
  ].join('\n'));
  try {
    const snapshot = buildDashboardSnapshot({ runDirectory: run.directory });
    const html = renderRunDetail(snapshot.runs[0]);
    assert.match(html, /data-diff-line="removed">-const value = &quot;before&quot;;/);
    assert.match(html, /data-diff-line="added">\+const value = &quot;after&quot;;/);
    assert.match(html, /\.diff-add\{background:var\(--add\);color:var\(--ok\)\}|class="diff-line diff-add"/);
    assert.match(html, /class="diff-line diff-remove"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('oversized unified diff is byte-capped and says so plainly', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-diff-cap-'));
  const runId = 'run-large-diff';
  const run = makeRun(root, runId, [event(runId, 'report', 'finish')]);
  const diff = '-removed line\n+added line\n'.repeat(Math.ceil(MAX_RENDERED_DIFF_BYTES / 8));
  writeFileSync(join(run.work, 'CHANGES.diff'), diff);
  try {
    const snapshot = buildDashboardSnapshot({ runDirectory: run.directory });
    const rendered = snapshot.runs[0].diff;
    assert.equal(rendered.capped, true);
    assert.equal(rendered.renderedByteCount, MAX_RENDERED_DIFF_BYTES);
    assert.equal(rendered.byteCount, Buffer.byteLength(diff));
    const html = renderRunDetail(snapshot.runs[0]);
    assert.match(html, /Diff rendering capped[\s\S]*Showing 131,072 of [\d,]+ bytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live view distinguishes predecessor waiting from an emitted stall', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-live-states-'));
  const campaignDirectory = join(root, 'campaign-live');
  mkdirSync(campaignDirectory);
  writeFileSync(join(campaignDirectory, 'campaign-events.jsonl'), `${JSON.stringify({
    ts: '2026-08-15T00:00:00.000Z', runId: 'waiting-child', campaignId: 'campaign-live',
    round: 1, unitId: 'waiting-child', unitKind: 'node', stage: 'unit', type: 'waiting',
    predecessorUnitId: 'parent-unit',
  })}\n`);
  makeRun(root, 'stalled-unit', [
    event('stalled-unit', 'executor', 'start', { ts: '2026-08-15T00:00:00.000Z' }),
    event('stalled-unit', 'executor', 'stalled', {
      ts: '2026-08-15T00:01:01.000Z', gapMs: 61000,
      lastEvent: { stage: 'executor', type: 'start' },
    }),
  ]);
  try {
    const html = renderDashboardPage(buildDashboardSnapshot({ scratchRoot: root }));
    assert.match(html, /waiting-predecessor[\s\S]*Waiting on predecessor: parent-unit/);
    assert.match(html, /class="live-unit stalled"[\s\S]*Stalled — watchdog reported no progress/);
    assert.doesNotMatch(html, /waiting-predecessor[\s\S]{0,200}watchdog reported no progress/,
      'declared dependency waiting must not be labelled as a stall');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dashboard serves an empty scratch root without inventing a run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-empty-root-'));
  let dashboard;
  try {
    dashboard = await startDashboard({ scratchRoot: root, port: 0 });
    const html = await page(dashboard);
    assert.match(html, /No run directories found yet/);
    assert.match(html, /No passes to group into sessions/);
    assert.doesNotMatch(html, /data-run-id="/);
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
