import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCapture, commandExists } from '../src/spawn.js';

test('captures stdout and exit code 0', async () => {
  const r = await spawnCapture(process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hi');
});

test('captures a non-zero exit code without throwing', async () => {
  const r = await spawnCapture(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(r.code, 3);
});

test('feeds stdin when input is provided', async () => {
  const r = await spawnCapture(process.execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'echoed' });
  assert.equal(r.stdout, 'echoed');
});

test('rejects when the binary does not exist', async () => {
  await assert.rejects(() => spawnCapture('definitely-not-a-real-binary-xyz', []));
});

test('commandExists is true for node, false for nonsense', async () => {
  assert.equal(await commandExists(process.execPath), true);
  assert.equal(await commandExists('definitely-not-a-real-binary-xyz'), false);
});

test('captures multi-byte UTF-8 output without corruption', async () => {
  const s = 'café ☕ 🚀 日本語';
  const r = await spawnCapture(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(s)})`]);
  assert.equal(r.stdout, s);
});

test('returns a known NDJSON fixture stdout byte-identically in full', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/codex-stream-schema-sample.ndjson', import.meta.url));
  const expected = readFileSync(fixture);
  const r = await spawnCapture(process.execPath, [
    '-e',
    'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))',
    fixture,
  ]);
  assert.equal(r.code, 0);
  assert.ok(Buffer.from(r.stdout, 'utf8').equals(expected),
    'the complete returned stdout must retain every fixture byte');
});

test('runs a .cmd on Windows and preserves space-bearing args', { skip: process.platform !== 'win32' }, async () => {
  const cmd = fileURLToPath(new URL('../fixtures/echoargs.cmd', import.meta.url));
  const r = await spawnCapture(cmd, ['hello', 'a b c']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ARG=\[hello\]/);
  assert.match(r.stdout, /ARG=\[a b c\]/, 'space-bearing arg must survive as one arg');
});

test('a short timeout kills a clearly slower child and marks the result', async () => {
  const started = Date.now();
  const r = await spawnCapture(process.execPath, ['-e', [
    'process.stdout.write("started")',
    'process.stderr.write("warning")',
    'setTimeout(() => process.stdout.write("finished"), 5000)',
  ].join(';')], { timeoutMs: 500 });
  assert.equal(r.timedOut, true, 'returning alone is insufficient: the timeout must be marked');
  assert.equal(r.timeoutMs, 500);
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, 'started', 'partial output captured before termination must survive');
  assert.equal(r.stderr, 'warning', 'partial stderr captured before termination must survive');
  assert.ok(Date.now() - started < 4000, 'the five-second child must actually be terminated');
});

test('spawnCapture without a timeout remains unbounded', async () => {
  const started = Date.now();
  const r = await spawnCapture(process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write("completed"), 250)']);
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.timeoutMs, null);
  assert.equal(r.stdout, 'completed');
  assert.ok(Date.now() - started >= 200, 'the child must be allowed to finish on its own');
});

test('an abort signal uses process termination without masquerading as a timeout', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = spawnCapture(process.execPath, ['-e', [
    'process.stdout.write("started")',
    'setTimeout(() => process.stdout.write("finished"), 5000)',
  ].join(';')], { timeoutMs: 10_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false, 'stall restart accounting must stay separate from timeouts');
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, 'started');
  assert.ok(Date.now() - started < 4000, 'the slow child must actually be terminated');
});

test('a Windows .cmd timeout kills its underlying child process',
  { skip: process.platform !== 'win32' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-tree-'));
    const marker = join(dir, 'orphan-marker.txt');
    const cmd = fileURLToPath(new URL('../fixtures/timeout-tree.cmd', import.meta.url));
    try {
      const r = await spawnCapture(cmd, [process.execPath, marker], { timeoutMs: 300 });
      assert.equal(r.timedOut, true);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      assert.equal(existsSync(marker), false,
        'the node process behind cmd.exe must not survive long enough to write its marker');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
