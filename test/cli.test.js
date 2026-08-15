import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  };
  const args = [cli, 'run', '--task', 'Make no real change.', '--target', target,
    '--gate', gate, '--gate-retries', '0'];
  return { root, scratchRoot, env, args };
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

test('a real CLI run keeps stdout to one JSON document while heartbeats use stderr', async () => {
  const fixture = cliFixture();
  try {
    const r = await spawnCapture(process.execPath, fixture.args, { env: fixture.env });
    assert.equal(r.code, 0, r.stderr);
    const facts = JSON.parse(r.stdout);
    assert.equal(r.stdout, `${JSON.stringify(facts, null, 2)}\n`,
      'stdout must contain exactly the one formatted run-facts document');
    assert.equal(facts.outcome, 'no-op');
    assert.match(r.stderr, /^\[ccc\].*isolate\/start/m,
      'positive control: the heartbeat must actually be emitted');
    assert.match(r.stderr, /^\[ccc\].*executor\/file_change/m);
    for (const line of r.stderr.trim().split(/\r?\n/)) {
      assert.ok(line.length <= 300, `heartbeat exceeded its bound: ${line.length}`);
      assert.match(line, /^\[ccc\] /);
    }
    const eventPath = join(facts.dir, 'events.jsonl');
    assert.ok(existsSync(eventPath));
    const events = readFileSync(eventPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(events.some((event) => event.type === 'file_change'));
    assert.ok(events.every((event) => event.runId === facts.runId));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.scratchRoot, { recursive: true, force: true });
  }
});

test('--quiet suppresses stderr heartbeats but still writes events.jsonl', async () => {
  const fixture = cliFixture();
  try {
    const r = await spawnCapture(process.execPath, [...fixture.args, '--quiet'], { env: fixture.env });
    assert.equal(r.code, 0, r.stderr);
    const facts = JSON.parse(r.stdout);
    assert.equal(r.stderr, '');
    const eventPath = join(facts.dir, 'events.jsonl');
    assert.ok(existsSync(eventPath));
    const events = readFileSync(eventPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(events.length > 0);
    assert.ok(events.some((event) => event.stage === 'report' && event.type === 'finish'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.scratchRoot, { recursive: true, force: true });
  }
});
