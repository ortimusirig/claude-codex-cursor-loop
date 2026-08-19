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
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { startDashboard } from '../src/dashboard.js';
import { encodeRecordedText } from '../src/execution-record.js';
import {
  buildDashboardSnapshot,
  DEFAULT_SESSION_THRESHOLD_HOURS,
  extractTaskTitle,
  groupRunsByProject,
  inferSessions,
  MAX_RENDERED_DIFF_BYTES,
  renderDashboardPage,
  renderProjectList,
  renderRunDetail,
  renderSessionList,
  runNeedsAttention,
  snapshotForClient,
  vscodeFileHref,
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

function displayRunWithEvents(events) {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-execution-record-'));
  const runId = 'execution-record-run';
  try {
    const recorded = events.map((fields, index) => ({
      ts: `2026-08-19T00:00:${String(index).padStart(2, '0')}.000Z`,
      runId,
      ...fields,
    }));
    const run = makeRun(root, runId, recorded);
    return buildDashboardSnapshot({ runDirectory: run.directory }).runs[0];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function page(dashboard) {
  const response = await fetch(dashboard.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  return response.text();
}

function verifierBlock(html, passKey) {
  const marker = `<div id="detail-verifier-${passKey}"`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `expected the ${passKey} verifier block`);
  const nextVerifier = html.indexOf('<div id="detail-verifier-', start + marker.length);
  const sectionEnd = html.indexOf('</section>', start);
  const end = nextVerifier === -1 ? sectionEnd : Math.min(nextVerifier, sectionEnd);
  assert.notEqual(end, -1, `expected the end of the ${passKey} verifier block`);
  return html.slice(start, end);
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

test('TASK.md title extraction skips boilerplate and handles empty and long plans', () => {
  const realisticPlan = [
    '# Task',
    '',
    'Give dashboard passes and sessions useful titles',
    '',
    '## Required behavior',
    '',
    'Read the title without changing any run files.',
  ].join('\n');
  const extracted = extractTaskTitle(realisticPlan);
  assert.equal(extracted, 'Give dashboard passes and sessions useful titles');
  assert.notEqual(extracted, null, 'a realistic multi-paragraph plan must yield a title');
  assert.equal(extractTaskTitle('# Task\n\n'), null);
  assert.equal(extractTaskTitle(''), null);

  const longLine = 'x'.repeat(120);
  assert.equal(extractTaskTitle(`# Task\n\n${longLine}\n`), `${'x'.repeat(69)}…`);
});

test('an explicit TASK.md title takes precedence over differing body prose', () => {
  const body = 'Heuristic body prose that must only appear without an explicit title';
  const explicitPlan = `# Task\n\nTitle: Dashboard-ready summary\n\n${body}\n`;
  const extracted = extractTaskTitle(explicitPlan);
  assert.equal(extracted, 'Dashboard-ready summary');
  assert.doesNotMatch(extracted, /Heuristic body prose/,
    'body prose must not be consulted after an explicit title is found');

  const fallbackPlan = explicitPlan.replace('Title: Dashboard-ready summary\n\n', '');
  assert.equal(extractTaskTitle(fallbackPlan), body,
    'positive control: removing Title: must expose the differing fallback title');
});

test('TASK.md title extraction strips markdown noise on fallback and explicit paths', () => {
  assert.equal(
    extractTaskTitle('# Task — Update `src/dashboard-view.js` title extraction\n'),
    'Update src/dashboard-view.js title extraction',
  );
  assert.equal(
    extractTaskTitle('# Task\n\nFallback text without markdown noise\n'),
    'Fallback text without markdown noise',
    'positive control: clean fallback text must pass through unchanged',
  );
  assert.equal(
    extractTaskTitle('# Task\n\nTitle: Show `TASK.md` titles\n\nIgnored body prose\n'),
    'Show TASK.md titles',
    'explicit titles must use the same markdown normalization',
  );
});

test('TASK.md title truncation prefers punctuation, then a word boundary', () => {
  const sentenceBoundary = 'Summarize the first complete thought. Additional words keep this title well beyond the seventy character limit';
  assert.equal(
    extractTaskTitle(`# Task\n\n${sentenceBoundary}\n`),
    'Summarize the first complete thought.…',
  );

  const wordBoundary = 'Build dashboard titles using the last available word boundary deliberately preserving important terminology';
  assert.equal(
    extractTaskTitle(`# Task\n\n${wordBoundary}\n`),
    'Build dashboard titles using the last available word boundary…',
  );

  const shortTitle = 'A concise title stays exactly as written';
  assert.equal(extractTaskTitle(`# Task\n\n${shortTitle}\n`), shortTitle);
  assert.doesNotMatch(extractTaskTitle(`# Task\n\n${shortTitle}\n`), /…$/,
    'titles under 70 characters must not gain an ellipsis');
});

test('run titles are read from either TASK.md layout and rendered above the short pass id', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-title-layouts-'));
  const nested = makeRun(root, 'nested-task-run', [
    event('nested-task-run', 'report', 'finish', { ts: '2026-08-15T00:00:00.000Z' }),
  ]);
  const direct = makeRun(root, 'direct-task-run', [
    event('direct-task-run', 'report', 'finish', { ts: '2026-08-15T01:00:00.000Z' }),
  ]);
  writeFileSync(join(nested.work, 'TASK.md'), '# Task\n\nNested task title\n');
  writeFileSync(join(direct.directory, 'TASK.md'), '# Task\n\nDirect task title\n');
  try {
    const snapshot = buildDashboardSnapshot({ scratchRoot: root });
    assert.equal(snapshot.runs.find((run) => run.runId === 'nested-task-run').title,
      'Nested task title');
    assert.equal(snapshot.runs.find((run) => run.runId === 'direct-task-run').title,
      'Direct task title');
    const html = renderSessionList(snapshot.runs, 2, false);
    assert.match(html, /class="pass-identity"><b title="Direct task title">Direct task title<\/b><small><code title="direct-task-run">direct-task-run<\/code>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Detail shows the exact TASK.md in a collapsed plan and an honest missing-file message', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-task-body-'));
  const withTask = makeRun(root, 'run-with-task', [
    event('run-with-task', 'report', 'finish', { ts: '2026-08-15T01:00:00.000Z' }),
  ]);
  makeRun(root, 'run-without-task', [
    event('run-without-task', 'report', 'finish', { ts: '2026-08-15T00:00:00.000Z' }),
  ]);
  const taskBody = '# Task\r\n\r\nTitle: Show <actual> & "plan"\r\n\r\n- Keep  two spaces.\r\n';
  writeFileSync(join(withTask.work, 'TASK.md'), taskBody);
  try {
    const snapshot = buildDashboardSnapshot({ scratchRoot: root });
    const taskRun = snapshot.runs.find((run) => run.runId === 'run-with-task');
    const missingRun = snapshot.runs.find((run) => run.runId === 'run-without-task');
    assert.equal(taskRun.taskBody, taskBody, 'the digest must retain every TASK.md byte as text');
    assert.equal(missingRun.taskBody, null);

    const taskHtml = renderRunDetail(taskRun);
    const expectedPlan = '<details class="task-plan">'
      + '<summary>Show &lt;actual&gt; &amp; &quot;plan&quot;</summary>'
      + '<pre class="prose"># Task\r\n\r\nTitle: Show &lt;actual&gt; &amp; &quot;plan&quot;'
      + '\r\n\r\n- Keep  two spaces.\r\n</pre></details>';
    assert.ok(taskHtml.includes(expectedPlan),
      'Detail must escape markup while preserving the full TASK.md text verbatim');
    assert.doesNotMatch(expectedPlan, /<details[^>]*\sopen(?:\s|>)/,
      'the plan must be collapsed by default');
    assert.match(renderRunDetail({ ...taskRun, title: null }),
      /<details class="task-plan"><summary>The plan<\/summary>/,
      'a readable task without an extracted title must use the explicit fallback label');

    const missingHtml = renderRunDetail(missingRun);
    assert.match(missingHtml, /<h3>Plan<\/h3><p class="muted">TASK[.]md is not available for this pass[.]<\/p>/);
    assert.equal(missingHtml.includes(expectedPlan), false,
      'positive control: a run without TASK.md must not look like the populated fixture');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Detail renders a recorded command line and exit code', () => {
  const run = displayRunWithEvents([
    { stage: 'executor', type: 'item_completed', itemType: 'command_execution',
      command: 'node --test', exitCode: 1, output: 'boom', outputEncoding: 'plain' },
  ]);
  const html = renderRunDetail(run);
  assert.match(html, /node --test/);
  assert.match(html, /exit 1/);
  assert.match(html, /boom/);
});

test('Detail decodes compressed output rather than showing base64', () => {
  const big = 'z'.repeat(5000);
  const encoded = encodeRecordedText(big);
  const run = displayRunWithEvents([
    { stage: 'executor', type: 'item_completed', itemType: 'command_execution',
      command: 'noisy', exitCode: 0, output: encoded.text, outputEncoding: encoded.encoding },
  ]);
  const html = renderRunDetail(run);
  assert.ok(!html.includes(encoded.text), 'raw base64 must never be rendered');
  assert.match(html, /zzzz/);
});

test('Detail shows a recorded error message', () => {
  const run = displayRunWithEvents([
    { stage: 'executor', type: 'item_completed', itemType: 'error',
      errorMessage: 'rate limited' },
  ]);
  assert.match(renderRunDetail(run), /rate limited/);
});

test('Detail decodes recorded agent text', () => {
  const encoded = encodeRecordedText('agent result '.repeat(300));
  const run = displayRunWithEvents([
    { stage: 'executor', type: 'item_completed', itemType: 'agent_message',
      text: encoded.text, textEncoding: encoded.encoding },
  ]);
  const html = renderRunDetail(run);
  assert.ok(!html.includes(encoded.text), 'raw base64 must never be rendered');
  assert.match(html, /agent result/);
});

test('a corrupt encoded payload degrades to a message instead of throwing', () => {
  const run = displayRunWithEvents([
    { stage: 'executor', type: 'item_completed', itemType: 'command_execution',
      command: 'x', exitCode: 0, output: 'garbage', outputEncoding: 'br+b64' },
  ]);
  assert.doesNotThrow(() => renderRunDetail(run));
  assert.match(renderRunDetail(run), /could not be decoded/i);
});

test('dashboard serves only populated Triage and Detail views, with removed routes returning 404', async () => {
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
    assert.match(html, new RegExp(`data-run-id="${runId}"`),
      'positive control: Triage must still render the populated pass');
    assert.match(html, /data-view-panel="detail" hidden[\s\S]*class="run-card running"/,
      'positive control: Detail must still render the selected pass');
    assert.match(html, /new EventSource\('\/events'\)/);
    assert.equal((html.match(/<button type="button" data-view=/g) ?? []).length, 2);
    assert.match(html, /data-view="triage" aria-pressed="true">Triage<\/button>/);
    assert.match(html, /data-view="detail" aria-pressed="false">Detail<\/button>/);
    assert.doesNotMatch(html, /data-view="(?:live|logs|graph)"|data-view-panel="(?:live|logs|graph)"/);
    assert.doesNotMatch(html, /renderLive|refreshLogs|syncLogOptions|refreshGraph|\/logs\?|\/graph\?/);
    for (const removedRoute of ['logs', 'graph']) {
      const response = await fetch(new URL(removedRoute, dashboard.url));
      assert.equal(response.status, 404, `/${removedRoute} must be an unrecognized route`);
      assert.equal(await response.text(), 'Not found\n');
    }
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/i,
      'the page must make no external asset requests');
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the SSE client snapshot retains its exact on-demand-view-independent field set', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-snapshot-shape-'));
  const runId = 'snapshot-shape';
  const run = makeRun(root, runId, [
    event(runId, 'executor', 'file_change', { file: 'shape.js', attempt: 1 }),
  ]);
  try {
    const client = snapshotForClient(buildDashboardSnapshot({ runDirectory: run.directory }));
    assert.deepEqual(Object.keys(client).sort(), [
      'message', 'mode', 'observedAt', 'runs', 'sourcePath',
    ]);
    assert.deepEqual(Object.keys(client.runs[0]).sort(), [
      'correctsRunId', 'currentStage', 'currentType', 'endTs', 'files', 'filesChanged', 'lastEventTs',
      'message', 'needsAttention', 'projectPath', 'runId', 'startTs', 'state', 'timeline',
      'title', 'triage',
    ]);
    assert.equal(Object.hasOwn(client, 'logs'), false);
    assert.equal(Object.hasOwn(client, 'graph'), false);
    assert.equal(Object.hasOwn(client, 'campaigns'), false);
    assert.equal(Object.hasOwn(client, 'liveUnits'), false);
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

test('dashboard shows both labelled reviews, provenance, consistency, and rationale without an obsolete VS Code link', async () => {
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
    const correctnessBlock = verifierBlock(html, 'correctness');
    const correctnessReportAt = correctnessBlock.indexOf('<details class="verifier-findings">');
    assert.notEqual(correctnessReportAt, -1, 'the fail-safe report must be present and tucked');
    const correctnessVerdictRow = correctnessBlock.slice(0, correctnessReportAt);
    const correctnessReport = correctnessBlock.slice(correctnessReportAt);
    assert.match(correctnessVerdictRow, /No verdict — unknown/);
    assert.match(correctnessVerdictRow, /Recorded fail-safe value: ISSUES/);
    assert.match(correctnessVerdictRow, /verdictSource: none/);
    assert.match(correctnessVerdictRow, /Consistency: consistent/);
    assert.match(correctnessVerdictRow, /ISSUES is a fail-safe, not a reviewer finding/);
    assert.match(correctnessReport,
      /^<details class="verifier-findings"><summary>Correctness pass retained output \(not authoritative reviewer findings\)<\/summary>/);
    assert.match(correctnessReport,
      /<pre>Correctness output retained without a terminal marker[.]<\/pre>/,
      'positive control: the collapsed fail-safe report must retain its body');

    const intentBlock = verifierBlock(html, 'intent');
    const intentReportAt = intentBlock.indexOf('<details class="verifier-findings">');
    assert.notEqual(intentReportAt, -1, 'the ordinary report must be present and tucked');
    const intentVerdictRow = intentBlock.slice(0, intentReportAt);
    const intentReport = intentBlock.slice(intentReportAt);
    assert.match(intentVerdictRow, /<strong>ISSUES<\/strong>/);
    assert.match(intentVerdictRow, /verdictSource: assistant/);
    assert.match(intentVerdictRow, /Consistency: disagreement/);
    assert.match(intentVerdictRow, /Reviewer reported ISSUES — a real problem/);
    assert.match(intentReport,
      /^<details class="verifier-findings"><summary>Intent pass findings<\/summary>/);
    assert.match(intentReport, /<pre>Intent review found the requested failure path missing[.]<\/pre>/,
      'positive control: the collapsed ordinary report must retain its body');
    for (const report of [correctnessReport, intentReport]) {
      assert.doesNotMatch(report, /^<details class="verifier-findings"[^>]*\sopen(?:\s|>)/,
        'verifier reports must be collapsed by default');
    }
    assert.doesNotMatch(html, /<details class="verifier-process-trace">/,
      'findings-only reports have no distinct process trace to add');
    assert.match(html, /Correctness pass[\s\S]*Consistency: consistent/);
    assert.match(html, /Intent pass[\s\S]*Consistency: disagreement/);
    assert.match(html, /Executor rationale[\s\S]*Kept the local diff intact/);
    assert.doesNotMatch(html, /data-copy-command|Copy command|class="copy-row"/,
      'Detail must omit the retired copy-command box');
    assert.equal((html.match(/>Open in VS Code<\/a>/g) ?? []).length, 0,
      'a run without a diff must keep the plain message and build no per-file links');
    assert.doesNotMatch(html, /Open the worktree in VS Code/);
    assert.match(html, /Correctness[\s\S]*in 11/);
    assert.match(html, /Intent[\s\S]*out 7/);
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifier reports are collapsed and retain distinct nested process traces', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-verifier-plans-'));
  const runId = 'run-verifier-plans';
  const run = makeRun(root, runId, [
    event(runId, 'verify', 'finish', {
      pass: 'correctness', verdict: 'NO_BLOCKERS', source: 'assistant',
    }),
    event(runId, 'verify', 'finish', {
      pass: 'intent', verdict: 'ISSUES', source: 'none',
    }),
    event(runId, 'report', 'finish', { file: 'ccc-runfacts.json' }),
  ]);
  const correctnessPlan = '## Correctness\nSpecific <check> passed & stayed covered.\n\n## Verdict\nNO_BLOCKERS';
  const correctnessFindings = 'I will inspect CHANGES.diff before reviewing correctness.';
  const intentPlan = '## Intent\nA specific requirement was not met.\n\n## Verdict\nISSUES';
  const intentFindings = 'I will read TASK.md and narrate each intent-review step.';
  writeFileSync(join(run.work, 'ccc-runfacts.json'), JSON.stringify({
    runId,
    verdict: 'NO_BLOCKERS',
    verdictSource: 'assistant',
    verifierPlan: correctnessPlan,
    verifierFindings: correctnessFindings,
    intentVerdict: 'ISSUES',
    intentVerdictSource: 'none',
    intentVerifierPlan: intentPlan,
    intentVerifierFindings: intentFindings,
  }));
  try {
    const [digested] = buildDashboardSnapshot({ runDirectory: run.directory }).runs;
    assert.equal(digested.verifiers.correctness.plan, correctnessPlan);
    assert.equal(digested.verifiers.intent.plan, intentPlan);
    const html = renderRunDetail(digested);
    assert.match(html, /<section id="detail-gate"><h3>Gate commands<\/h3>/);
    const verifierOpenings = [...html.matchAll(
      /<div id="(detail-verifier-(?:correctness|intent))" class="verifier/g,
    )].map((match) => match[1]);
    assert.deepEqual(verifierOpenings, [
      'detail-verifier-correctness',
      'detail-verifier-intent',
    ], 'the stable verifier anchors must belong to two distinct verifier elements');
    const correctnessBlock = '<details class="verifier-findings"><summary>Correctness pass report</summary>'
      + '<pre>## Correctness\nSpecific &lt;check&gt; passed &amp; stayed covered.\n\n## Verdict\nNO_BLOCKERS</pre>'
      + '<details class="verifier-process-trace"><summary>Process trace</summary>'
      + `<pre>${correctnessFindings}</pre></details></details>`;
    assert.ok(html.includes(correctnessBlock),
      'ordinary rendering must tuck the report around its distinguishable process trace');

    const intentBlock = '<details class="verifier-findings">'
      + '<summary>Intent pass retained report (not authoritative reviewer findings)</summary>'
      + `<pre>${intentPlan}</pre>`
      + '<details class="verifier-process-trace"><summary>Process trace</summary>'
      + `<pre>${intentFindings}</pre></details></details>`;
    assert.ok(html.includes(intentBlock),
      'fail-safe rendering must tuck the report around its distinguishable process trace');
    assert.equal((html.match(/<details class="verifier-findings">/g) ?? []).length, 2);
    assert.doesNotMatch(html, /<details class="verifier-findings"[^>]*\sopen(?:\s|>)/,
      'both verifier reports must be collapsed by default');
    assert.equal((html.match(/<details class="verifier-process-trace">/g) ?? []).length, 2);
    assert.doesNotMatch(html, /<details class="verifier-process-trace"[^>]*\sopen(?:\s|>)/,
      'both process traces must be collapsed by default');
  } finally {
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
    const detail = await fetch(new URL(`detail?runId=${runId}`, dashboard.url));
    assert.equal(detail.status, 200);
    await detail.text();
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
    title: null,
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

function displayTriageRun(runId, startTs, overrides = {}) {
  const run = triageRun(runId, startTs, overrides);
  const displayVerdict = (review) => {
    if (review === null) return { kind: 'pending', text: 'Pending — unknown' };
    if (review.verdictSource === 'none') {
      return { kind: 'unknown', text: 'No verdict — unknown (ISSUES is a fail-safe, not a finding)' };
    }
    if (review.verdict === 'ISSUES') {
      return { kind: 'issues', text: 'ISSUES — reviewer found a problem' };
    }
    if (review.verdict === 'NO_BLOCKERS') return { kind: 'clean', text: 'NO_BLOCKERS — fine' };
    return { kind: 'pending', text: `${review.verdict ?? 'Pending'} — unknown` };
  };
  return {
    ...run,
    needsAttention: runNeedsAttention(run),
    filesChanged: [],
    triage: {
      gate: run.gateResult === 'passed'
        ? { kind: 'clean', text: 'Passed — fine' }
        : run.gateResult === 'failed'
          ? { kind: 'issues', text: 'Failed — needs attention' }
          : { kind: 'pending', text: 'Pending — not complete' },
      correctness: displayVerdict(run.verifiers.correctness),
      intent: displayVerdict(run.verifiers.intent),
    },
  };
}

function renderClientProjectList(runs, attentionOnly) {
  const shell = renderDashboardPage({
    sourcePath: 'portable-fixture', message: null, runs: [],
    mode: 'scratch', observedAt: '2026-08-15T00:00:00.000Z',
  });
  const script = shell.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'the dashboard page must include its executable inline client script');
  const sessionsElement = { innerHTML: '' };
  const elements = {
    connection: { textContent: '' },
    runs: { addEventListener() {} },
    sessions: sessionsElement,
    'attention-only': { checked: attentionOnly, addEventListener() {} },
    'initial-dashboard-data': { textContent: JSON.stringify({ runs }) },
  };
  class FakeEventSource {
    addEventListener() {}
  }
  const context = createContext({
    document: {
      getElementById(id) { return elements[id] ?? null; },
      querySelectorAll() { return []; },
    },
    EventSource: FakeEventSource,
    setInterval() {},
  });
  runInContext(script, context);
  const sessionHtml = runInContext(
    `state.attentionOnly=${JSON.stringify(attentionOnly)};renderSessionGroups(state.snapshot.runs)`,
    context,
  );
  runInContext('renderSessions()', context);
  return { html: sessionsElement.innerHTML, sessionHtml };
}

function projectCard(html, projectPath) {
  const marker = `<details class="project" data-project-path="${projectPath ?? ''}"`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `expected a project card for ${projectPath ?? 'Unknown project'}`);
  const next = html.indexOf('<details class="project"', start + marker.length);
  return html.slice(start, next === -1 ? html.length : next);
}

function projectOpeningTag(html, projectPath) {
  const card = projectCard(html, projectPath);
  return card.slice(0, card.indexOf('>') + 1);
}

function passRowHtml(html, runId) {
  const serverMarker = `data-run-id="${runId}"`;
  const clientMarker = `data-client-run-id="${runId}"`;
  const markerIndex = Math.max(html.indexOf(serverMarker), html.indexOf(clientMarker));
  assert.notEqual(markerIndex, -1, `expected a rendered row for ${runId}`);
  const start = html.lastIndexOf('<tr', markerIndex);
  const end = html.indexOf('</tr>', markerIndex);
  assert.notEqual(start, -1, `expected an opening row tag for ${runId}`);
  assert.notEqual(end, -1, `expected a closing row tag for ${runId}`);
  return html.slice(start, end + '</tr>'.length);
}

function triageBadges(rowHtml) {
  return [...rowHtml.matchAll(
    /<button class="result ([^"]+)" type="button" data-result-kind="([^"]+)" data-detail-run="([^"]+)" data-detail-section="([^"]+)" title="([^"]+)">([^<]+)<\/button>/g,
  )].map((match) => ({
    classKind: match[1],
    dataKind: match[2],
    runId: match[3],
    section: match[4],
    title: match[5],
    text: match[6],
  }));
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

test('an explicit inferSessions threshold still regroups the same passes', () => {
  const runs = [
    triageRun('three', '2026-08-15T04:00:00.000Z'),
    triageRun('two', '2026-08-15T02:00:01.000Z'),
    triageRun('one', '2026-08-14T23:59:59.000Z'),
  ];
  assert.deepEqual(inferSessions(runs, 2).map((session) => session.passCount), [2, 1]);
  assert.deepEqual(inferSessions(runs, 2.01).map((session) => session.passCount), [3],
    'an explicit threshold above both boundary gaps must combine the same passes');
});

test('session headers use the newest pass title and count other differing titles', () => {
  const shared = [
    displayTriageRun('shared-newest', '2026-08-15T01:00:00.000Z', { title: 'Shared work' }),
    displayTriageRun('shared-older', '2026-08-15T00:00:00.000Z', { title: 'Shared work' }),
  ];
  const sharedHtml = renderSessionList(shared, 2, false);
  assert.match(sharedHtml,
    /<summary><span><b title="Shared work">Shared work<\/b><small>2026-08-15 00:00:00[.]000 UTC · 1h 0m<\/small>/);
  assert.doesNotMatch(sharedHtml, /Shared work \+\d+ more/,
    'identical pass titles must not produce a mixed-session suffix');

  const mixed = [
    displayTriageRun('mixed-newest', '2026-08-15T01:00:00.000Z', { title: 'Newest task' }),
    displayTriageRun('mixed-older', '2026-08-15T00:00:00.000Z', { title: 'Older task' }),
  ];
  const mixedHtml = renderSessionList(mixed, 2, false);
  assert.match(mixedHtml, /<summary><span><b title="Newest task \+1 more">Newest task \+1 more<\/b>/,
    'one other run with a different non-null title must be counted');
});

test('full pass titles and computed session headlines are available on hover in both renderers', () => {
  const longTitle = 'Explain the complete migration sequence and preserve every compatibility detail across all supported execution modes';
  const olderTitle = 'A different session task';
  const runs = [
    displayTriageRun('long-title-newest', '2026-08-15T01:00:00.000Z', { title: longTitle }),
    displayTriageRun('long-title-older', '2026-08-15T00:30:00.000Z', { title: olderTitle }),
  ];
  const headline = `${longTitle} +1 more`;
  const renderings = [
    ['server', renderSessionList(runs, 2, false)],
    ['client', renderClientProjectList(runs, false).sessionHtml],
  ];

  for (const [name, html] of renderings) {
    assert.ok(html.includes(`<summary><span><b title="${headline}">${headline}</b>`),
      `${name}: the session tooltip must contain the full computed headline`);
    assert.ok(passRowHtml(html, 'long-title-newest')
      .includes(`<b title="${longTitle}">${longTitle}</b>`),
    `${name}: the pass tooltip must contain the full exact stored title`);
  }
});

test('triage result buttons identify their run and distinct Detail landing sections', () => {
  const runId = 'wired-result-run';
  const runs = [displayTriageRun(runId, '2026-08-15T01:00:00.000Z')];
  const renderings = [
    ['server', renderSessionList(runs, 2, false)],
    ['client', renderClientProjectList(runs, false).sessionHtml],
  ];

  for (const [name, html] of renderings) {
    const row = passRowHtml(html, runId);
    const badges = triageBadges(row);
    assert.equal(badges.length, 3, `${name}: all result cells must be buttons`);
    assert.deepEqual(badges.map((badge) => badge.runId), [runId, runId, runId],
      `${name}: every result button must target its own run`);
    assert.deepEqual(badges.map((badge) => badge.section), ['gate', 'correctness', 'intent'],
      `${name}: each result button must name its distinct Detail anchor`);

    const timeButton = row.match(/<button class="pass-detail"[^>]*>/)?.[0];
    assert.ok(timeButton, `${name}: the existing time-cell Detail button must remain`);
    assert.match(timeButton, new RegExp(`data-detail-run="${runId}"`));
    assert.doesNotMatch(timeButton, /data-detail-section=/,
      `${name}: the time button must not request a section reveal`);
  }
});

test('client reveals a requested Detail section only after its asynchronous fetch', async () => {
  const runId = 'async-detail-run';
  const shell = renderDashboardPage({
    sourcePath: 'portable-fixture', message: null, runs: [],
    mode: 'scratch', observedAt: '2026-08-15T00:00:00.000Z',
  });
  const script = shell.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'the dashboard page must include its executable inline client script');

  const listeners = {};
  const root = {
    addEventListener(type, listener) { listeners[type] = listener; },
  };
  const detailSelect = { value: 'initial-run' };
  let detailLoaded = false;
  let resolveInstalled;
  const detailBody = {
    value: '',
    set innerHTML(value) {
      this.value = value;
      detailLoaded = true;
      resolveInstalled?.();
    },
    get innerHTML() { return this.value; },
    setAttribute() {},
    removeAttribute() {},
  };
  const reports = {
    correctness: { open: false },
    intent: { open: false },
  };
  const scrolls = [];
  const highlightClasses = new Map();
  const anchorIds = {
    gate: 'detail-gate',
    correctness: 'detail-verifier-correctness',
    intent: 'detail-verifier-intent',
  };
  const anchors = Object.fromEntries(Object.entries(anchorIds).map(([section, id]) => {
    const classes = new Set();
    highlightClasses.set(section, classes);
    return [id, {
      querySelector(selector) {
        assert.equal(selector, 'details.verifier-findings');
        return reports[section] ?? null;
      },
      scrollIntoView(options) { scrolls.push({ section, options }); },
      classList: {
        add(value) { classes.add(value); },
        remove(value) { classes.delete(value); },
      },
    }];
  }));
  const elements = {
    connection: { textContent: '' },
    runs: root,
    'attention-only': { checked: true, addEventListener() {} },
    'detail-pass': detailSelect,
    'detail-body': detailBody,
    'initial-dashboard-data': { textContent: JSON.stringify({ runs: [] }) },
  };
  const fetchCalls = [];
  let resolveFetch;
  const timers = [];
  class FakeEventSource {
    addEventListener() {}
  }
  const context = createContext({
    document: {
      getElementById(id) {
        if (elements[id]) return elements[id];
        if (!detailLoaded) return null;
        return anchors[id] ?? null;
      },
      querySelectorAll() { return []; },
    },
    EventSource: FakeEventSource,
    fetch(url, options) {
      fetchCalls.push({ url, options });
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
    setInterval() {},
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
  });
  runInContext(script, context);

  const click = (section) => {
    detailLoaded = false;
    Object.values(reports).forEach((report) => { report.open = false; });
    const dataset = { detailRun: runId };
    if (section !== undefined) dataset.detailSection = section;
    const button = {
      dataset,
      closest(selector) {
        if (selector === '[data-detail-run]') return this;
        return null;
      },
    };
    listeners.click({ target: button });
  };
  const finishFetch = async () => {
    const installed = new Promise((resolve) => { resolveInstalled = resolve; });
    resolveFetch({ ok: true, async text() { return '<article>fresh detail</article>'; } });
    await installed;
    resolveInstalled = undefined;
  };

  for (const section of ['gate', 'correctness', 'intent']) {
    const scrollCount = scrolls.length;
    click(section);
    assert.equal(detailSelect.value, runId, `${section}: the selected run must switch immediately`);
    assert.equal(scrolls.length, scrollCount,
      `${section}: no stale pre-fetch anchor may be scrolled`);
    await finishFetch();
    const lastScroll = scrolls.at(-1);
    assert.equal(lastScroll.section, section,
      `${section}: the fresh anchor must be scrolled after the response is installed`);
    assert.equal(lastScroll.options.behavior, 'smooth');
    assert.equal(lastScroll.options.block, 'start');
    assert.equal(reports[section]?.open ?? false, section !== 'gate',
      `${section}: verifier reports open while Gate remains an ordinary section`);
    assert.ok(highlightClasses.get(section).has('detail-highlight'),
      `${section}: the destination must be highlighted`);
    assert.equal(timers.at(-1).delay, 1600);
    timers.at(-1).callback();
    assert.equal(highlightClasses.get(section).has('detail-highlight'), false,
      `${section}: the highlight must be temporary`);
  }

  const scrollCount = scrolls.length;
  click(undefined);
  await finishFetch();
  assert.equal(scrolls.length, scrollCount,
    'the existing time-cell path must load Detail without revealing a section');
  assert.equal(fetchCalls.length, 4);
  assert.ok(fetchCalls.every((call) => call.url === `/detail?runId=${runId}`));
});

test('every triage state has a type-specific plain-language hover explanation in both renderers', () => {
  const reviewStates = [
    { runId: 'review-pending', kind: 'pending', text: 'Pending — unknown' },
    {
      runId: 'review-no-result',
      kind: 'unknown',
      text: 'No verdict — unknown (ISSUES is a fail-safe, not a finding)',
    },
    { runId: 'review-issues', kind: 'issues', text: 'ISSUES — reviewer found a problem' },
    { runId: 'review-clean', kind: 'clean', text: 'NO_BLOCKERS — fine' },
    { runId: 'review-fallback', kind: 'pending', text: 'UNRECOGNIZED — unknown' },
  ];
  const gateStates = [
    { kind: 'clean', text: 'Passed — fine' },
    { kind: 'issues', text: 'Failed — needs attention' },
    { kind: 'pending', text: 'Pending — not complete' },
  ];
  const runs = reviewStates.map((review, index) => ({
    ...displayTriageRun(review.runId, `2026-08-15T00:${String(index).padStart(2, '0')}:00.000Z`),
    triage: {
      gate: gateStates[index] ?? gateStates[0],
      correctness: { kind: review.kind, text: review.text },
      intent: { kind: review.kind, text: review.text },
    },
  }));
  const renderings = [
    ['server', renderSessionList(runs, 2, false)],
    ['client', renderClientProjectList(runs, false).sessionHtml],
  ];

  for (const [name, html] of renderings) {
    gateStates.forEach((expected, index) => {
      const [gate] = triageBadges(passRowHtml(html, reviewStates[index].runId));
      assert.deepEqual({ kind: gate.dataKind, text: gate.text }, expected,
        `${name}: gate badge ${index + 1} must keep its existing kind and text`);
      assert.ok(gate.title.length > 0, `${name}: gate state ${expected.text} needs an explanation`);
    });

    for (const review of reviewStates) {
      const badges = triageBadges(passRowHtml(html, review.runId));
      assert.equal(badges.length, 3, `${name}: ${review.runId} must render all three triage badges`);
      const correctness = badges[1];
      const intent = badges[2];
      for (const [checkType, badge] of [['correctness', correctness], ['intent', intent]]) {
        assert.equal(badge.classKind, review.kind,
          `${name}: ${checkType} ${review.text} must keep its color classification`);
        assert.equal(badge.dataKind, review.kind,
          `${name}: ${checkType} ${review.text} must keep its data classification`);
        assert.equal(badge.text, review.text,
          `${name}: ${checkType} ${review.text} must keep its visible text`);
        assert.ok(badge.title.length > 0,
          `${name}: ${checkType} ${review.text} needs an explanation`);
      }
      assert.notEqual(correctness.title, intent.title,
        `${name}: correctness and intent must explain ${review.text} differently`);
    }

    assert.ok(triageBadges(passRowHtml(html, 'review-issues'))[1].title
      .includes('found a possible defect in the code'),
    `${name}: the correctness explanation must describe what the review found`);
    assert.ok(triageBadges(passRowHtml(html, 'review-no-result'))[0].title
      .includes('automated checks failed'),
    `${name}: the failed-gate explanation must describe the failure`);
  }
});

test('project grouping wraps multiple full paths and auto-collapses exactly one project', () => {
  const leftPath = join('fixture-targets', 'left', 'shared-repository');
  const rightPath = join('fixture-targets', 'right', 'shared-repository');
  const multiple = [
    displayTriageRun('left-new', '2026-08-15T06:00:00.000Z', { projectPath: leftPath }),
    displayTriageRun('left-old', '2026-08-15T03:00:00.000Z', { projectPath: leftPath }),
    displayTriageRun('right-new', '2026-08-15T05:00:00.000Z', { projectPath: rightPath }),
    displayTriageRun('right-old', '2026-08-15T02:00:00.000Z', { projectPath: rightPath }),
  ];
  assert.deepEqual(groupRunsByProject(multiple).map((project) => project.projectPath), [
    leftPath, rightPath,
  ], 'full paths sharing a basename must stay distinct and sort by newest pass');

  const single = [
    displayTriageRun('single-new', '2026-08-15T06:00:00.000Z', { projectPath: leftPath }),
    displayTriageRun('single-middle', '2026-08-15T03:00:00.000Z', { projectPath: leftPath }),
    displayTriageRun('single-old', '2026-08-15T00:00:00.000Z', { projectPath: leftPath }),
  ];
  const renderings = [
    {
      name: 'server',
      multipleHtml: renderProjectList(multiple, 2, false),
      singleHtml: renderProjectList(single, 2, false),
      directSessionHtml: renderSessionList(single, 2, false),
    },
    {
      name: 'client',
      multipleHtml: renderClientProjectList(multiple, false).html,
      singleHtml: renderClientProjectList(single, false).html,
      directSessionHtml: renderClientProjectList(single, false).sessionHtml,
    },
  ];

  for (const rendering of renderings) {
    assert.equal((rendering.multipleHtml.match(/<details class="project"/g) ?? []).length, 2,
      `${rendering.name}: multiple projects must produce two wrappers`);
    assert.ok(rendering.multipleHtml.indexOf(`data-project-path="${leftPath}"`)
      < rendering.multipleHtml.indexOf(`data-project-path="${rightPath}"`),
    `${rendering.name}: the newest project must render first`);
    const leftCard = projectCard(rendering.multipleHtml, leftPath);
    const rightCard = projectCard(rendering.multipleHtml, rightPath);
    assert.equal((leftCard.match(/class="session"/g) ?? []).length, 2,
      `${rendering.name}: the left project must have two sessions`);
    assert.equal((rightCard.match(/class="session"/g) ?? []).length, 2,
      `${rendering.name}: the right project must have two sessions`);
    assert.ok(leftCard.includes('left-new') && leftCard.includes('left-old'));
    assert.ok(!leftCard.includes('right-new') && !leftCard.includes('right-old'));
    assert.ok(rightCard.includes('right-new') && rightCard.includes('right-old'));
    assert.ok(!rightCard.includes('left-new') && !rightCard.includes('left-old'));
    assert.ok(leftCard.includes(`<b>${basename(leftPath)}</b><small>${leftPath}</small>`),
      `${rendering.name}: the project headline must pair basename and full path`);

    assert.doesNotMatch(rendering.singleHtml, /<details class="project"/,
      `${rendering.name}: one project must not gain a wrapper`);
    assert.equal(rendering.singleHtml, rendering.directSessionHtml,
      `${rendering.name}: one project must preserve the session renderer byte-for-byte`);
    assert.match(rendering.singleHtml, /<details class="session"/,
      `${rendering.name}: the positive single-project fixture must still render sessions`);
  }
});

test('isolate start sources form real and Unknown project buckets in both renderers', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-project-path-'));
  const knownPath = join(root, 'targets', 'known-project');
  makeRun(root, 'known-run', [
    event('known-run', 'isolate', 'start', { ts: '2026-08-15T00:00:00.000Z', source: 42 }),
    event('known-run', 'isolate', 'start', {
      ts: '2026-08-15T00:00:01.000Z', source: knownPath,
    }),
    event('known-run', 'isolate', 'start', {
      ts: '2026-08-15T00:00:02.000Z', source: join(root, 'ignored-later-source'),
    }),
    event('known-run', 'report', 'finish', { ts: '2026-08-15T00:01:00.000Z' }),
  ]);
  makeRun(root, 'unknown-run', [
    event('unknown-run', 'executor', 'start', { ts: '2026-08-15T04:00:00.000Z' }),
    event('unknown-run', 'report', 'finish', { ts: '2026-08-15T04:01:00.000Z' }),
  ]);
  try {
    const snapshot = buildDashboardSnapshot({ scratchRoot: root });
    assert.equal(snapshot.runs.find((run) => run.runId === 'known-run').projectPath, knownPath,
      'the first isolate/start event with a string source must win');
    assert.equal(snapshot.runs.find((run) => run.runId === 'unknown-run').projectPath, null);
    const renderings = [
      ['server', renderProjectList(snapshot.runs, 2, false)],
      ['client', renderClientProjectList(snapshot.runs, false).html],
    ];
    for (const [name, html] of renderings) {
      assert.equal((html.match(/<details class="project"/g) ?? []).length, 2,
        `${name}: real and unknown paths must make two project wrappers`);
      const unknownCard = projectCard(html, null);
      const knownCard = projectCard(html, knownPath);
      assert.ok(unknownCard.includes('<b>Unknown project</b><small>Unknown project</small>'));
      assert.ok(unknownCard.includes('title="unknown-run"')
        && !unknownCard.includes('title="known-run"'));
      assert.ok(knownCard.includes('title="known-run"')
        && !knownCard.includes('title="unknown-run"'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dashboard extracts the first string correction id and defaults it to null', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-corrects-extraction-'));
  makeRun(root, 'corrected-run', [
    event('corrected-run', 'isolate', 'start', { correctsRunId: 42 }),
    event('corrected-run', 'isolate', 'start', { correctsRunId: 'parent-run' }),
    event('corrected-run', 'isolate', 'start', { correctsRunId: 'ignored-later-parent' }),
  ]);
  makeRun(root, 'ordinary-run', [event('ordinary-run', 'executor', 'start')]);
  try {
    const snapshot = buildDashboardSnapshot({ scratchRoot: root });
    assert.equal(snapshot.runs.find((run) => run.runId === 'corrected-run').correctsRunId,
      'parent-run');
    assert.equal(snapshot.runs.find((run) => run.runId === 'ordinary-run').correctsRunId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function renderedCorrectionRows(html) {
  return [...html.matchAll(
    /<tr class="pass-row[^"]*" data-(?:client-)?run-id="([^"]+)" data-correction-depth="(\d+)"/g,
  )].map((match) => ({ runId: match[1], depth: Number(match[2]) }));
}

test('a three-run correction chain renders parent-first at increasing depths', () => {
  const runs = [
    displayTriageRun('A', '2026-08-15T00:00:00.000Z'),
    displayTriageRun('B', '2026-08-15T00:30:00.000Z', { correctsRunId: 'A' }),
    displayTriageRun('C', '2026-08-15T01:00:00.000Z', { correctsRunId: 'B' }),
  ];
  const renderings = [
    ['server', renderSessionList(runs, 2, false)],
    ['client', renderClientProjectList(runs, false).sessionHtml],
  ];
  for (const [name, html] of renderings) {
    assert.deepEqual(renderedCorrectionRows(html), [
      { runId: 'A', depth: 0 },
      { runId: 'B', depth: 1 },
      { runId: 'C', depth: 2 },
    ], `${name}: the chain must differ from the plain newest-first C, B, A order`);
    assert.match(html, /correction-note">corrects <code title="A">A<\/code>/,
      `${name}: B must explicitly identify A`);
    assert.match(html, /correction-note">corrects <code title="B">B<\/code>/,
      `${name}: C must explicitly identify B`);
  }
});

test('a correction whose parent is in another session stays unindented and annotated', () => {
  const runs = [
    displayTriageRun('parent', '2026-08-15T00:00:00.000Z'),
    displayTriageRun('correction', '2026-08-15T04:00:00.000Z', {
      correctsRunId: 'parent',
    }),
  ];
  const renderings = [
    ['server', renderSessionList(runs, 2, false)],
    ['client', renderClientProjectList(runs, false).sessionHtml],
  ];
  for (const [name, html] of renderings) {
    const correction = renderedCorrectionRows(html).find((row) => row.runId === 'correction');
    assert.deepEqual(correction, { runId: 'correction', depth: 0 },
      `${name}: a cross-session parent must not create visual nesting`);
    assert.match(html, /correction-note">corrects <code title="parent">parent<\/code>/,
      `${name}: the cross-session fallback must retain its explicit annotation`);
  }
});

test('a correction cycle renders every involved run once and unindented', () => {
  const runs = [
    displayTriageRun('cycle-a', '2026-08-15T00:00:00.000Z', { correctsRunId: 'cycle-b' }),
    displayTriageRun('cycle-b', '2026-08-15T01:00:00.000Z', { correctsRunId: 'cycle-a' }),
  ];
  const renderings = [
    ['server', renderSessionList(runs, 2, false)],
    ['client', renderClientProjectList(runs, false).sessionHtml],
  ];
  for (const [name, html] of renderings) {
    const rows = renderedCorrectionRows(html);
    assert.equal(rows.length, 2, `${name}: cycle rendering must return exactly two rows`);
    assert.deepEqual(new Set(rows.map((row) => row.runId)), new Set(['cycle-a', 'cycle-b']));
    assert.ok(rows.every((row) => row.depth === 0),
      `${name}: cycle members must fall back to ordinary unindented rows`);
  }
});

test('attention-only filtering hides a project whose every session is clean', () => {
  const cleanPath = join('fixture-targets', 'clean-project');
  const attentionPath = join('fixture-targets', 'attention-project');
  const runs = [
    displayTriageRun('clean-new', '2026-08-15T05:00:00.000Z', { projectPath: cleanPath }),
    displayTriageRun('clean-old', '2026-08-15T01:00:00.000Z', { projectPath: cleanPath }),
    displayTriageRun('failed-pass', '2026-08-15T04:00:00.000Z', {
      projectPath: attentionPath, gateResult: 'failed',
    }),
  ];
  const renderings = [
    ['server', renderProjectList(runs, 2, true)],
    ['client', renderClientProjectList(runs, true).html],
  ];
  for (const [name, html] of renderings) {
    assert.match(projectOpeningTag(html, cleanPath), / hidden>/,
      `${name}: the all-clean project must be hidden`);
    assert.doesNotMatch(projectOpeningTag(html, attentionPath), / hidden>/,
      `${name}: a project with an attention pass must remain visible`);
    assert.ok(projectCard(html, attentionPath).includes('failed-pass'));
  }
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
  const displayRuns = runs.map((run) => displayTriageRun(run.runId, run.startTs, run));
  const html = renderSessionList(displayRuns, 2, false);
  assert.match(html, />3 passes</);
  assert.match(html, />2 need attention</,
    'the rendered session summary must report the computed attention count');
});

test('triage keeps fixed session grouping without the editable heuristic control', () => {
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
    }], mode: 'scratch', observedAt: run.startTs,
  };
  const html = renderDashboardPage(snapshot);
  assert.match(html, /data-view="triage" aria-pressed="true"/);
  assert.match(html, /data-view-panel="triage">/);
  assert.match(html, /data-view-panel="detail" hidden/);
  assert.equal((html.match(/<button type="button" data-view=/g) ?? []).length, 2);
  assert.doesNotMatch(html, /data-view-panel="(?:live|logs|graph)"/);
  assert.doesNotMatch(html, /id="session-threshold"/);
  assert.doesNotMatch(html, /Heuristic only/);
  assert.match(html, /id="attention-only" type="checkbox" checked/);
  assert.match(html, /<details class="session"[^>]*>/,
    'fixed-default session grouping must remain after removing the input');
  assert.doesNotMatch(html, /<details class="session"[^>]*\sopen(?:\s|>)/,
    'sessions must be collapsed by default');
});

test('VS Code file URIs preserve Windows path syntax while encoding real special characters', () => {
  const windowsPath = String.raw`C:\ccc\w\Demo Run\w\src\value.js`;
  const expected = `vscode://file${pathToFileURL(windowsPath).pathname}`;
  const actual = vscodeFileHref(windowsPath);
  const previousBrokenHref = `vscode://file/${encodeURIComponent(windowsPath)}`;

  assert.equal(actual, expected,
    'the link helper must use the platform conversion supplied by pathToFileURL');
  assert.match(actual, /^vscode:\/\/file\/C:\/ccc\/w\/Demo%20Run\/w\/src\/value[.]js$/);
  assert.doesNotMatch(actual, /%3A|%5C/i,
    'the drive-letter colon and Windows separators must not be percent-encoded');
  assert.notEqual(actual, previousBrokenHref,
    'the regression control must prove raw-path encodeURIComponent is observably different');
});

test('unified diff renders one collapsed, linked section per modified, new, and deleted file', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc dashboard diff #-'));
  const runId = 'run-real-diff';
  const run = makeRun(root, runId, [
    event(runId, 'report', 'finish', { ts: '2026-08-15T00:00:00.000Z' }),
  ]);
  writeFileSync(join(run.work, 'CHANGES.diff'), [
    'diff --git a/src/value.js b/src/value.js',
    'index 1111111..2222222 100644',
    '--- a/src/value.js',
    '+++ b/src/value.js',
    '@@ -1 +1 @@',
    '-const value = "before";',
    '+const value = "after";',
    'diff --git a/src/new file.js b/src/new file.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new file.js',
    '@@ -0,0 +1 @@',
    '+export const created = true;',
    'diff --git a/src/removed.js b/src/removed.js',
    'deleted file mode 100644',
    '--- a/src/removed.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-export const removed = true;',
    '',
  ].join('\n'));
  try {
    const snapshot = buildDashboardSnapshot({ runDirectory: run.directory });
    const html = renderRunDetail(snapshot.runs[0]);
    const sections = html.match(/<details class="diff-file">[\s\S]*?<\/details>/g) ?? [];
    assert.equal(sections.length, 3);
    assert.ok(sections.every((section) => !/<details[^>]*\sopen(?:\s|>)/.test(section)),
      'every file section must be collapsed by default');

    const expectedFiles = [
      ['b/src/value.js', 'src/value.js'],
      ['b/src/new file.js', 'src/new file.js'],
      ['a/src/removed.js', 'src/removed.js'],
    ];
    expectedFiles.forEach(([displayPath, relativePath], index) => {
      const expectedHref = `vscode://file${pathToFileURL(join(run.work, relativePath)).pathname}`;
      assert.ok(sections[index].includes(`<summary><code>${displayPath}</code></summary>`));
      assert.ok(sections[index].includes(`href="${expectedHref}">Open in VS Code</a>`),
        `${displayPath} must link to its actual worktree file`);
      assert.equal((sections[index].match(/>Open in VS Code<\/a>/g) ?? []).length, 1);
    });

    const wholeDiffHref = `vscode://file${pathToFileURL(join(run.work, 'CHANGES.diff')).pathname}`;
    assert.ok(!html.includes(`href="${wholeDiffHref}"`),
      'the whole CHANGES.diff link must be removed');
    assert.doesNotMatch(html, /Open the worktree in VS Code/);
    assert.match(html, /data-diff-line="removed">-const value = &quot;before&quot;;/);
    assert.match(html, /data-diff-line="added">\+const value = &quot;after&quot;;/);
    assert.match(html, /\.diff-add\{background:var\(--add\);color:var\(--ok\)\}|class="diff-line diff-add"/);
    assert.match(html, /class="diff-line diff-remove"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a diff capped mid-hunk keeps earlier file sections and shows one link-free notice', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-diff-cap-'));
  const runId = 'run-large-diff';
  const run = makeRun(root, runId, [event(runId, 'report', 'finish')]);
  const completeFile = [
    'diff --git a/src/complete.js b/src/complete.js',
    '--- a/src/complete.js',
    '+++ b/src/complete.js',
    '@@ -1 +1 @@',
    '-export const state = "before";',
    '+export const state = "after";',
    '',
  ].join('\n');
  const finalFileStart = [
    'diff --git a/src/truncated.js b/src/truncated.js',
    '--- a/src/truncated.js',
    '+++ b/src/truncated.js',
    '@@ -0,0 +1 @@',
  ].join('\n') + '\n';
  const diff = completeFile + finalFileStart + `+${'x'.repeat(MAX_RENDERED_DIFF_BYTES)}`;
  writeFileSync(join(run.work, 'CHANGES.diff'), diff);
  try {
    const snapshot = buildDashboardSnapshot({ runDirectory: run.directory });
    const rendered = snapshot.runs[0].diff;
    assert.equal(rendered.capped, true);
    assert.equal(rendered.renderedByteCount, MAX_RENDERED_DIFF_BYTES);
    assert.equal(rendered.byteCount, Buffer.byteLength(diff));
    assert.equal(rendered.text.endsWith('\n'), false,
      'the fixture must exercise a raw byte cut in the final file hunk');
    const html = renderRunDetail(snapshot.runs[0]);
    assert.match(html, /Diff rendering capped[\s\S]*Showing 131,072 of [\d,]+ bytes/);
    assert.equal((html.match(/<p class="diff-capped">/g) ?? []).length, 1);
    const cappedNotice = html.match(/<p class="diff-capped">([\s\S]*?)<\/p>/)?.[1] ?? '';
    assert.doesNotMatch(cappedNotice, /href=|Open in VS Code/,
      'the one overall cap notice must not contain its own VS Code affordance');
    const sections = html.match(/<details class="diff-file">[\s\S]*?<\/details>/g) ?? [];
    assert.equal(sections.length, 2);
    assert.match(sections[0], /<summary><code>b\/src\/complete[.]js<\/code><\/summary>/);
    assert.match(sections[0], /data-diff-line="added">\+export const state = &quot;after&quot;;/);
    assert.match(sections[1], /<summary><code>b\/src\/truncated[.]js<\/code><\/summary>/);
    assert.equal((html.match(/>Open in VS Code<\/a>/g) ?? []).length, 2);
    const wholeDiffHref = `vscode://file${pathToFileURL(join(run.work, 'CHANGES.diff')).pathname}`;
    assert.ok(!html.includes(`href="${wholeDiffHref}"`));
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
