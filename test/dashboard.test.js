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
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { startDashboard } from '../src/dashboard.js';
import {
  buildDashboardSnapshot,
  DEFAULT_SESSION_THRESHOLD_HOURS,
  extractTaskTitle,
  groupRunsByProject,
  inferSessions,
  liveUnitFromRun,
  MAX_RENDERED_DIFF_BYTES,
  renderDashboardPage,
  renderLogRows,
  renderProjectList,
  renderRunDetail,
  renderSessionList,
  runNeedsAttention,
  snapshotForClient,
} from '../src/dashboard-view.js';
import { spawnCapture } from '../src/spawn.js';
import {
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  DEFAULT_GATE_TIMEOUT_MS,
  DEFAULT_VERIFIER_TIMEOUT_MS,
} from '../src/timeouts.js';

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

function makeCampaign(root, campaignId, units, events = [], suffix = '') {
  const directory = join(root, campaignId);
  mkdirSync(directory, { recursive: true });
  const start = {
    ts: '2026-08-15T00:00:00.000Z', runId: campaignId, campaignId, round: 1,
    unitId: null, unitKind: null, stage: 'campaign', type: 'start',
    topology: {
      units,
      edges: units.flatMap((unit) => unit.parents.map((parentUnitId) => ({
        parentUnitId, childUnitId: unit.unitId,
      }))),
    },
  };
  const records = [start, ...events];
  writeFileSync(join(directory, 'campaign-events.jsonl'),
    `${records.map(JSON.stringify).join('\n')}\n${suffix}`);
  return directory;
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
    assert.match(html, /class="pass-identity"><b>Direct task title<\/b><small><code title="direct-task-run">direct-task-run<\/code>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    assert.match(html, /data-view="graph" aria-pressed="false">Graph<\/button>/);
    assert.match(html, /data-view-panel="graph" hidden/);
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

test('Graph is a fifth on-demand view with campaign selection, live stage enrichment, and 404s', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-graph-'));
  makeCampaign(root, 'campaign-a', [
    { unitId: 'a-root', unitKind: 'node', parents: [] },
  ]);
  makeCampaign(root, 'campaign-b', [
    { unitId: 'b-parent', unitKind: 'node', parents: [] },
    { unitId: 'b-child', unitKind: 'node', parents: ['b-parent'] },
  ], [], '{"stage":"unit","type":"start"');
  makeRun(root, 'b-child', [
    event('b-child', 'gate', 'start', {
      ts: '2026-08-15T00:00:02.000Z', campaignId: 'campaign-b', round: 1,
      unitId: 'b-child', unitKind: 'node', attempt: 1,
    }),
  ]);
  let dashboard;
  try {
    dashboard = await startDashboard({ scratchRoot: root, port: 0 });
    const html = await page(dashboard);
    assert.match(html, /data-view="graph" aria-pressed="false">Graph<\/button>/);
    assert.match(html, /data-view-panel="graph" hidden/);
    assert.match(html, /<select id="graph-campaign">[\s\S]*campaign-a[\s\S]*campaign-b/);
    assert.match(html, /fetch\('\/graph\?campaignId='/,
      'the graph must be fetched only after the view is opened');
    assert.doesNotMatch(html, /class="campaign-graph"/,
      'the initial dashboard response must not inline graph data');

    const response = await fetch(new URL('graph?campaignId=campaign-b', dashboard.url));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    const graphHtml = await response.text();
    assert.match(graphHtml, /class="campaign-graph"/);
    assert.match(graphHtml,
      /data-parent-unit-id="b-parent" data-child-unit-id="b-child"/);
    assert.match(graphHtml, /data-unit-id="b-child"[\s\S]*Running . gate/,
      'the on-demand read may enrich orchestration state from the unit stream');
    assert.doesNotMatch(graphHtml, /stage&quot;:|events\.jsonl/,
      'the SVG should expose the graph model, not raw event records');

    const missing = await fetch(new URL('graph?campaignId=not-a-campaign', dashboard.url));
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), 'Campaign not found\n');
  } finally {
    await dashboard?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Graph explains empty scratch roots and single-run dashboards', async () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), 'ccc-dashboard-empty-graph-'));
  const runRoot = mkdtempSync(join(tmpdir(), 'ccc-dashboard-run-graph-'));
  const run = makeRun(runRoot, 'single-run', [event('single-run', 'executor', 'start')]);
  let emptyDashboard;
  let runDashboard;
  try {
    emptyDashboard = await startDashboard({ scratchRoot: emptyRoot, port: 0 });
    const emptyPage = await page(emptyDashboard);
    assert.match(emptyPage, /No campaigns are available in this scratch root yet/);
    const emptyGraph = await fetch(new URL('graph', emptyDashboard.url));
    assert.equal(emptyGraph.status, 200);
    assert.match(await emptyGraph.text(), /No campaigns are available in this scratch root yet/);

    runDashboard = await startDashboard({ runDirectory: run.directory, port: 0 });
    const runPage = await page(runDashboard);
    assert.match(runPage, /single-run dashboard has no campaign topology/);
    const runGraph = await fetch(new URL('graph', runDashboard.url));
    assert.equal(runGraph.status, 200);
    assert.match(await runGraph.text(), /single-run dashboard has no campaign topology/);
    const unknown = await fetch(new URL('graph?campaignId=unknown', runDashboard.url));
    assert.equal(unknown.status, 404);
  } finally {
    await emptyDashboard?.close();
    await runDashboard?.close();
    rmSync(emptyRoot, { recursive: true, force: true });
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('serving a campaign graph leaves every observed byte unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-dashboard-graph-readonly-'));
  makeCampaign(root, 'readonly-campaign', [
    { unitId: 'readonly-unit', unitKind: 'node', parents: [] },
  ]);
  makeRun(root, 'readonly-unit', [event('readonly-unit', 'executor', 'start', {
    campaignId: 'readonly-campaign', round: 1, unitId: 'readonly-unit', unitKind: 'node',
  })]);
  const before = snapshotContents(root);
  let dashboard;
  try {
    dashboard = await startDashboard({ scratchRoot: root, port: 0, pollIntervalMs: 25 });
    const response = await fetch(new URL('graph?campaignId=readonly-campaign', dashboard.url));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /readonly-unit/);
  } finally {
    await dashboard?.close();
  }
  assert.deepEqual(snapshotContents(root), before);
  rmSync(root, { recursive: true, force: true });
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

test('the SSE client snapshot retains its exact on-demand-view-independent field set', () => {
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
      'correctsRunId', 'currentStage', 'currentType', 'endTs', 'files', 'filesChanged', 'lastEventTs',
      'message', 'needsAttention', 'projectPath', 'runId', 'startTs', 'state', 'timeline',
      'title', 'triage',
    ]);
    assert.equal(Object.hasOwn(client, 'logs'), false);
    assert.equal(Object.hasOwn(client, 'graph'), false);
    assert.equal(Object.hasOwn(client, 'campaigns'), false);
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
  return {
    ...run,
    needsAttention: runNeedsAttention(run),
    filesChanged: [],
    triage: {
      gate: { kind: run.gateResult === 'failed' ? 'issues' : 'clean', text: run.gateResult },
      correctness: { kind: 'clean', text: run.verifiers.correctness.verdict },
      intent: { kind: 'clean', text: run.verifiers.intent.verdict },
    },
  };
}

function renderClientProjectList(runs, attentionOnly) {
  const shell = renderDashboardPage({
    sourcePath: 'portable-fixture', message: null, runs: [], liveUnits: [], campaigns: [],
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
    'initial-dashboard-data': { textContent: JSON.stringify({ runs, liveUnits: [] }) },
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
    /<summary><span><b>Shared work<\/b><small>2026-08-15 00:00:00[.]000 UTC · 1h 0m<\/small>/);
  assert.doesNotMatch(sharedHtml, /Shared work \+\d+ more/,
    'identical pass titles must not produce a mixed-session suffix');

  const mixed = [
    displayTriageRun('mixed-newest', '2026-08-15T01:00:00.000Z', { title: 'Newest task' }),
    displayTriageRun('mixed-older', '2026-08-15T00:00:00.000Z', { title: 'Older task' }),
  ];
  const mixedHtml = renderSessionList(mixed, 2, false);
  assert.match(mixedHtml, /<summary><span><b>Newest task \+1 more<\/b>/,
    'one other run with a different non-null title must be counted');
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
    }], liveUnits: [], mode: 'scratch', observedAt: run.startTs,
  };
  const html = renderDashboardPage(snapshot);
  assert.match(html, /data-view="triage" aria-pressed="true"/);
  assert.match(html, /data-view-panel="triage">/);
  assert.match(html, /data-view-panel="live" hidden/);
  assert.match(html, /data-view-panel="detail" hidden/);
  assert.match(html, /data-view-panel="logs" hidden/);
  assert.doesNotMatch(html, /id="session-threshold"/);
  assert.doesNotMatch(html, /Heuristic only/);
  assert.match(html, /id="attention-only" type="checkbox" checked/);
  assert.match(html, /<details class="session"[^>]*>/,
    'fixed-default session grouping must remain after removing the input');
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

test('live units become stale only after a deadline-owning stage timeout', (t) => {
  const now = Date.parse('2026-08-18T20:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const unitFor = (stage, lastEventMs) => liveUnitFromRun({
    campaignId: null,
    runId: `run-${stage}`,
    state: 'running',
    currentStage: stage,
    currentType: 'start',
    lastEventTs: new Date(lastEventMs).toISOString(),
    timeline: [],
  });
  const timeouts = {
    executor: DEFAULT_EXECUTOR_TIMEOUT_MS,
    gate: DEFAULT_GATE_TIMEOUT_MS,
    verify: DEFAULT_VERIFIER_TIMEOUT_MS,
  };

  for (const [stage, timeoutMs] of Object.entries(timeouts)) {
    const stale = unitFor(stage, now - timeoutMs - 1);
    assert.equal(stale.status, 'stale', `${stage} must become stale after its timeout`);
    assert.equal(stale.statusText, 'Stale — no recent events');
    assert.equal(unitFor(stage, now - timeoutMs + 1).status, 'active',
      `${stage} must remain active just under its timeout`);
  }

  const farPast = now - Math.max(...Object.values(timeouts)) * 10;
  assert.equal(unitFor('isolate', farPast).status, 'active',
    'undeadlined Git isolation work must never be age-labelled stale');
  const staleExecutor = unitFor('executor', farPast);
  assert.equal(staleExecutor.status, 'stale',
    'the same old timestamp must detect staleness on an allowlisted stage');

  const html = renderDashboardPage({
    sourcePath: 'portable-fixture', message: null, runs: [], liveUnits: [staleExecutor],
    campaigns: [], mode: 'run', observedAt: new Date(now).toISOString(),
  });
  assert.match(html, /class="live-unit stale"[\s\S]*Stale — no recent events/);
  assert.match(html, /[.]live-unit[.]stale\{border-top-color:var\(--stale\)\}/,
    'stale units must have their own visual status class');
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
