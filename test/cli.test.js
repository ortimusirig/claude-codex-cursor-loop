import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCapture } from '../src/spawn.js';
import { startDashboard } from '../src/dashboard.js';

const cli = fileURLToPath(new URL('../bin/loop.js', import.meta.url));
const fakeCodex = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
const fakeAgent = fileURLToPath(new URL('../fixtures/fake-agent.mjs', import.meta.url));
const SAFE_SCRATCH_BASE = process.env.CCC_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function writeFakeBin(dir, name, script, extra = []) {
  if (process.platform === 'win32') {
    const path = join(dir, `${name}.cmd`);
    const quoted = [process.execPath, script, ...extra].map((value) => `"${value}"`).join(' ');
    writeFileSync(path, `@echo off\r\n${quoted} %*\r\n`);
    return;
  }
  const path = join(dir, name);
  const command = [process.execPath, script, ...extra].map(shellQuote).join(' ');
  writeFileSync(path, `#!/bin/sh\nexec ${command} "$@"\n`);
  chmodSync(path, 0o755);
}

function cliFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cli-events-'));
  const target = join(root, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'seed.txt'), 'seed\n');
  const gate = join(root, 'gate.json');
  writeFileSync(gate, '[]');
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  const scratchRoot = mkdtempSync(join(SAFE_SCRATCH_BASE, '.cli-'));
  const shims = join(scratchRoot, 'cli-bin');
  mkdirSync(shims);
  writeFakeBin(shims, 'codex', fakeCodex);
  writeFakeBin(shims, 'agent', fakeAgent, ['clean']);
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const env = {
    ...process.env,
    [pathKey]: `${shims}${delimiter}${process.env[pathKey] ?? ''}`,
    CCC_SCRATCH_ROOT: scratchRoot,
    CCC_NO_DASHBOARD: '1',
  };
  const args = [cli, 'run', '--task', 'Make no real change.', '--target', target,
    '--gate', gate, '--gate-retries', '0'];
  return { root, scratchRoot, env, args };
}

function withDashboardEnabled(env) {
  const enabled = { ...env };
  delete enabled.CCC_NO_DASHBOARD;
  return enabled;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

test('exit code 2 and coded reason on preflight failure (missing target)', async () => {
  const r = await spawnCapture(process.execPath,
    [cli, 'run', '--task', 'x', '--target', 'C:/nope/xyz', '--gate', 'C:/nope/g.json']);
  assert.equal(r.code, 2);
  assert.match(r.stdout + r.stderr, /target/i);
});

test('unknown command exits non-zero', async () => {
  const r = await spawnCapture(process.execPath, [cli, 'frobnicate']);
  assert.notEqual(r.code, 0);
});

test('removed --max-iterations is an argument error with exit code 2', async () => {
  const r = await spawnCapture(process.execPath, [cli, 'run', '--task', 'p', '--target', 't',
    '--gate', 'g', '--max-iterations', '5']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /arg error:.*max-iterations/i);
});

test('invalid --executor-effort is an argument error with exit code 2', async () => {
  const r = await spawnCapture(process.execPath, [cli, 'run', '--task', 'p', '--target', 't',
    '--gate', 'g', '--executor-effort', 'extreme']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /arg error:.*executor-effort.*extreme/i);
});

test('missing path-like --task fails preflight with exit code 2 and names the path', async () => {
  const target = mkdtempSync(join(tmpdir(), 'cli-task-'));
  const gate = join(target, 'gate.json');
  const missing = join(target, 'missing-task.txt');
  writeFileSync(gate, '[]');
  const r = await spawnCapture(process.execPath,
    [cli, 'run', '--task', missing, '--target', target, '--gate', gate]);
  assert.equal(r.code, 2);
  assert.ok((r.stdout + r.stderr).includes(missing));
  assert.match(r.stdout + r.stderr, /task file not found/i);
});

test('a real CLI run announces a read-only dashboard before executor events and keeps stdout JSON-only', async () => {
  const fixture = cliFixture();
  let dashboard;
  try {
    dashboard = await startDashboard({ scratchRoot: fixture.scratchRoot, port: 0 });
    const r = await spawnCapture(process.execPath,
      [...fixture.args, '--port', String(dashboard.port)],
      { env: withDashboardEnabled(fixture.env) });
    assert.equal(r.code, 0, r.stderr);
    const facts = JSON.parse(r.stdout);
    assert.equal(r.stdout, `${JSON.stringify(facts, null, 2)}\n`,
      'stdout must contain exactly the one formatted run-facts document');
    assert.equal(facts.outcome, 'no-op');
    assert.match(r.stderr, /^\[ccc\].*isolate\/start/m,
      'positive control: the heartbeat must actually be emitted');
    assert.match(r.stderr, /^\[ccc\].*executor\/file_change/m);
    assert.match(r.stderr, new RegExp(`Watch live: ${dashboard.url.replaceAll('.', '[.]')}`));
    assert.match(r.stderr, /read-only/i);
    // indexOf returns -1 when the banner is absent, and -1 < <any positive index> is true,
    // so comparing them directly FAILS OPEN: the ordering check passed with no banner at
    // all. Require both positions to exist before comparing them.
    const bannerAt = r.stderr.indexOf('=== CCC DASHBOARD ===');
    const executorAt = r.stderr.search(/^\[ccc\].*executor\/start/m);
    assert.ok(bannerAt >= 0, 'the prominent dashboard banner must be printed');
    assert.ok(executorAt >= 0, 'positive control: the executor event must be in the stream');
    assert.ok(bannerAt < executorAt,
      'the prominent dashboard announcement must precede executor launch');
    const eventLines = r.stderr.trim().split(/\r?\n/).filter((line) => line.startsWith('[ccc]'));
    assert.ok(eventLines.length > 0);
    for (const line of eventLines) {
      assert.ok(line.length <= 300, `heartbeat exceeded its bound: ${line.length}`);
      assert.match(line, /^\[ccc\] /);
    }
    const eventPath = join(facts.dir, 'events.jsonl');
    assert.ok(existsSync(eventPath));
    const events = readFileSync(eventPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(events.some((event) => event.type === 'file_change'));
    assert.ok(events.every((event) => event.runId === facts.runId));
  } finally {
    await dashboard?.close();
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.scratchRoot, { recursive: true, force: true });
  }
});

test('--quiet suppresses stderr chatter while dashboard probing and events still happen', async () => {
  const fixture = cliFixture();
  let requests = 0;
  const existing = createServer((_request, response) => {
    requests += 1;
    response.end('<h1>CCC live run dashboard</h1>');
  });
  const port = await listen(existing);
  try {
    const r = await spawnCapture(process.execPath,
      [...fixture.args, '--quiet', '--port', String(port)],
      { env: withDashboardEnabled(fixture.env) });
    assert.equal(r.code, 0, r.stderr);
    const facts = JSON.parse(r.stdout);
    assert.equal(r.stderr, '');
    assert.ok(requests > 0, 'quiet must hide the announcement without disabling the dashboard');
    const eventPath = join(facts.dir, 'events.jsonl');
    assert.ok(existsSync(eventPath));
    const events = readFileSync(eventPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(events.length > 0);
    assert.ok(events.some((event) => event.stage === 'report' && event.type === 'finish'));
  } finally {
    await closeServer(existing);
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.scratchRoot, { recursive: true, force: true });
  }
});

test('--no-dashboard performs no HTTP probe and announces no dashboard URL', async () => {
  const fixture = cliFixture();
  let requests = 0;
  const markerServer = createServer((_request, response) => {
    requests += 1;
    response.end('<h1>CCC live run dashboard</h1>');
  });
  const port = await listen(markerServer);
  try {
    const r = await spawnCapture(process.execPath,
      [...fixture.args, '--no-dashboard', '--port', String(port)],
      { env: withDashboardEnabled(fixture.env) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).outcome, 'no-op');
    assert.equal(requests, 0, 'the opt-out must skip even the initial port probe');
    assert.doesNotMatch(r.stderr, /CCC DASHBOARD|Watch live:|127[.]0[.]0[.]1/);
    assert.match(r.stderr, /^\[ccc\].*executor\/start/m,
      'positive control: this run did execute and emit normal event chatter');
  } finally {
    await closeServer(markerServer);
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.scratchRoot, { recursive: true, force: true });
  }
});

test('a foreign dashboard port reports the conflict but cannot change run outcome or exit code', async () => {
  const fixture = cliFixture();
  const foreign = createServer((_request, response) => {
    response.end('<h1>unrelated local service</h1>');
  });
  const port = await listen(foreign);
  try {
    const r = await spawnCapture(process.execPath,
      [...fixture.args, '--port', String(port)],
      { env: withDashboardEnabled(fixture.env) });
    assert.equal(r.code, 0, r.stderr);
    const facts = JSON.parse(r.stdout);
    assert.equal(facts.outcome, 'no-op');
    assert.equal(r.stdout, `${JSON.stringify(facts, null, 2)}\n`);
    assert.match(r.stderr, new RegExp(`port ${port}.*other than a CCC dashboard`, 'i'));
    assert.match(r.stderr, /Start it manually:/);
    assert.doesNotMatch(r.stderr, new RegExp(`Watch live: http://127[.]0[.]0[.]1:${port}/`),
      'the foreign listener URL must not be claimed as a dashboard');
    assert.match(r.stderr, /^\[ccc\].*executor\/start/m,
      'the run must proceed normally after dashboard failure');
  } finally {
    await closeServer(foreign);
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.scratchRoot, { recursive: true, force: true });
  }
});

test('batch stdout is one aggregate JSON document while heartbeats remain on stderr', async () => {
  const fixture = cliFixture();
  let dashboard;
  const batchArgs = [
    cli,
    'batch',
    '--task', 'Make no real change for candidate one.',
    '--task', 'Make no real change for candidate two.',
    '--target', fixture.args[fixture.args.indexOf('--target') + 1],
    '--gate', fixture.args[fixture.args.indexOf('--gate') + 1],
    '--gate-retries', '0',
    '--concurrency', '2',
    '--token-budget', '1000',
  ];
  try {
    dashboard = await startDashboard({ scratchRoot: fixture.scratchRoot, port: 0 });
    const r = await spawnCapture(process.execPath,
      [...batchArgs, '--port', String(dashboard.port)],
      { env: withDashboardEnabled(fixture.env) });
    assert.equal(r.code, 0, r.stderr);
    const aggregate = JSON.parse(r.stdout);
    assert.equal(r.stdout, `${JSON.stringify(aggregate, null, 2)}\n`,
      'stdout must contain exactly one formatted campaign aggregate');
    assert.equal(aggregate.units.length, 2);
    assert.equal(aggregate.rollup.counts.completed, 2);
    assert.match(r.stderr, /^\[ccc\].*campaign\/start/m,
      'positive control: campaign heartbeat must actually be emitted');
    assert.match(r.stderr, /^\[ccc\].*executor\/file_change/m,
      'positive control: concurrent unit heartbeats must actually be emitted');
    assert.match(r.stderr, new RegExp(`Watch live: ${dashboard.url.replaceAll('.', '[.]')}`));
    assert.match(r.stderr, /read-only/i);
    // indexOf returns -1 when the banner is absent, and -1 < <any positive index> is true,
    // so comparing them directly FAILS OPEN: the ordering check passed with no banner at
    // all. Require both positions to exist before comparing them.
    const bannerAt = r.stderr.indexOf('=== CCC DASHBOARD ===');
    const campaignAt = r.stderr.search(/^\[ccc\].*campaign\/start/m);
    assert.ok(bannerAt >= 0, 'the prominent dashboard banner must be printed');
    assert.ok(campaignAt >= 0, 'positive control: the campaign event must be in the stream');
    assert.ok(bannerAt < campaignAt,
      'the dashboard announcement must precede campaign work');

    const campaignLines = readFileSync(aggregate.campaignEventsPath, 'utf8')
      .trim().split(/\r?\n/);
    assert.ok(campaignLines.length >= 8);
    const campaignEvents = campaignLines.map((line, index) => {
      assert.doesNotThrow(() => JSON.parse(line), `campaign event line ${index + 1}`);
      return JSON.parse(line);
    });
    assert.ok(campaignEvents.every((event) => event.campaignId === aggregate.campaignId));
    for (const unit of aggregate.units) {
      const unitEvents = readFileSync(join(unit.facts.dir, 'events.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(JSON.parse);
      assert.ok(unitEvents.length > 0);
      assert.ok(unitEvents.every((event) => event.unitId === unit.unitId));
      assert.ok(unitEvents.every((event) => event.campaignId === aggregate.campaignId));
    }
  } finally {
    await dashboard?.close();
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.scratchRoot, { recursive: true, force: true });
  }
});

test('iterative batch CLI emits one grouped aggregate and ordered round boundaries', async () => {
  const fixture = cliFixture();
  const batchArgs = [
    cli,
    'batch',
    '--task', 'Round one candidate.', '--round', '1', '--unit-id', 'cli-r1',
    '--task', 'Round two informed candidate.', '--round', '2', '--unit-id', 'cli-r2',
    '--perspective', 'minimal-change', '--perspective', 'review-informed',
    '--rounds', '2',
    '--target', fixture.args[fixture.args.indexOf('--target') + 1],
    '--gate', fixture.args[fixture.args.indexOf('--gate') + 1],
    '--gate-retries', '0',
    '--token-budget', '1000',
    '--quiet',
  ];
  try {
    const result = await spawnCapture(process.execPath, batchArgs, { env: fixture.env });
    assert.equal(result.code, 0, result.stderr);
    const aggregate = JSON.parse(result.stdout);
    assert.equal(result.stdout, `${JSON.stringify(aggregate, null, 2)}\n`);
    assert.equal(result.stderr, '');
    assert.deepEqual(aggregate.rounds.map((round) => [
      round.round, ...round.units.map((unit) => unit.unitId),
    ]), [[1, 'cli-r1'], [2, 'cli-r2']]);
    assert.equal(aggregate.stopReason, 'max-rounds-reached');

    const events = readFileSync(aggregate.campaignEventsPath, 'utf8')
      .trim().split(/\r?\n/).map(JSON.parse);
    const boundaries = events.filter((event) => event.stage === 'round')
      .map((event) => `${event.round}:${event.type}`);
    assert.deepEqual(boundaries, ['1:start', '1:finish', '2:start', '2:finish']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.scratchRoot, { recursive: true, force: true });
  }
});
