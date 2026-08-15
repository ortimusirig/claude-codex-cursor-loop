import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

test('parses a full run invocation', () => {
  const r = parseArgs(['run', '--task', 'plan.md', '--target', 'C:/proj',
    '--gate', 'gate.json', '--gate-retries', '1', '--executor-model', 'executor-X',
    '--executor-effort', 'medium', '--verifier-model', 'verifier-Y']);
  assert.equal(r.command, 'run');
  assert.equal(r.task, 'plan.md');
  assert.equal(r.target, 'C:/proj');
  assert.equal(r.gate, 'gate.json');
  assert.equal(r.gateRetries, 1);
  assert.equal(r.executorModel, 'executor-X');
  assert.equal(r.executorEffort, 'medium');
  assert.equal(r.verifierModel, 'verifier-Y');
  assert.equal(Object.hasOwn(r, 'quiet'), false,
    'the default parse result keeps its existing shape for callers');
});

test('parses --quiet without changing run options', () => {
  const r = parseArgs(['run', '--task', 'p', '--target', 't', '--gate', 'g', '--quiet']);
  assert.equal(r.quiet, true);
  assert.equal(r.gateRetries, 2);
});

test('applies the retry default and leaves model defaults to run()', () => {
  const r = parseArgs(['run', '--task', 'p', '--target', 't', '--gate', 'g']);
  assert.equal(r.gateRetries, 2);
  assert.equal(r.executorModel, undefined);
  assert.equal(r.executorEffort, undefined);
  assert.equal(r.verifierModel, undefined);
  assert.equal(Object.hasOwn(r, 'maxIterations'), false);
});

test('rejects the removed --max-iterations option', () => {
  assert.throws(() => parseArgs(['run', '--task', 'p', '--target', 't', '--gate', 'g',
    '--max-iterations', '5']), /max-iterations/i);
});

test('rejects an invalid executor effort while accepting Codex effort values', () => {
  assert.throws(() => parseArgs(['run', '--task', 'p', '--target', 't', '--gate', 'g',
    '--executor-effort', 'extreme']), /executor-effort.*extreme/i);
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.equal(parseArgs(['run', '--task', 'p', '--target', 't', '--gate', 'g',
      '--executor-effort', effort]).executorEffort, effort);
  }
});

test('rejects an unknown command', () => {
  assert.throws(() => parseArgs(['frobnicate']), /unknown command/i);
});

test('parses status with exactly one run directory', () => {
  assert.deepEqual(parseArgs(['status', 'C:/ccc/w/run/w']), {
    command: 'status', runDirectory: 'C:/ccc/w/run/w',
  });
  assert.throws(() => parseArgs(['status']), /status <run-directory>/);
  assert.throws(() => parseArgs(['status', 'one', 'two']), /status <run-directory>/);
});

test('parses dashboard run, scratch-root, and port forms without ambiguity', () => {
  assert.deepEqual(parseArgs(['dashboard', 'C:/ccc/w/a', '--port', '8123']), {
    command: 'dashboard', runDirectory: 'C:/ccc/w/a', port: 8123,
  });
  assert.deepEqual(parseArgs(['dashboard', '--scratch-root', 'C:/ccc/w']), {
    command: 'dashboard', scratchRoot: 'C:/ccc/w',
  });
  assert.deepEqual(parseArgs(['dashboard', '--run', 'C:/ccc/w/a']), {
    command: 'dashboard', runDirectory: 'C:/ccc/w/a',
  });
  assert.deepEqual(parseArgs(['dashboard']), { command: 'dashboard' },
    'no source means the CLI-configured default scratch root');
  assert.throws(() => parseArgs(['dashboard', 'a', '--scratch-root', 'b']), /either.*run.*scratch/i);
  assert.throws(() => parseArgs(['dashboard', '--port', '65536']), /port/i);
  assert.throws(() => parseArgs(['dashboard', '--port', '12.5']), /port/i);
});

test('rejects a missing required option', () => {
  assert.throws(() => parseArgs(['run', '--task', 'p']), /--target/);
});

test('parses repeated batch plans with bounded concurrency, budget, and unit identity', () => {
  const parsed = parseArgs([
    'batch',
    '--task', 'candidate-a.md',
    '--task', 'candidate-b.md',
    '--target', 'C:/proj',
    '--gate', 'gate.json',
    '--concurrency', '2',
    '--token-budget', '9000',
    '--unit-kind', 'candidate',
    '--unit-kind', 'merge',
    '--quiet',
  ]);
  assert.equal(parsed.command, 'batch');
  assert.deepEqual(parsed.tasks, [
    { task: 'candidate-a.md', unitKind: 'candidate' },
    { task: 'candidate-b.md', unitKind: 'merge' },
  ]);
  assert.equal(parsed.concurrency, 2);
  assert.equal(parsed.tokenBudget, 9000);
  assert.equal(parsed.gateRetries, 2);
  assert.equal(parsed.quiet, true);
});

test('batch defaults concurrency to two and broadcasts the candidate unit kind', () => {
  const parsed = parseArgs([
    'batch', '--task', 'a', '--task', 'b', '--target', 't', '--gate', 'g',
  ]);
  assert.equal(parsed.concurrency, 2);
  assert.ok(parsed.tokenBudget > 0);
  assert.deepEqual(parsed.tasks.map((unit) => unit.unitKind), ['candidate', 'candidate']);
});

test('batch parses explicit unit ids and tree dependency edges', () => {
  const parsed = parseArgs([
    'batch',
    '--task', 'parent plan', '--unit-id', 'parent',
    '--task', 'child plan', '--unit-id', 'child',
    '--task', 'sibling plan', '--unit-id', 'sibling',
    '--depends-on', 'child=parent',
    '--depends-on', 'sibling=parent',
    '--target', 't', '--gate', 'g', '--unit-kind', 'node',
  ]);
  assert.deepEqual(parsed.tasks, [
    { task: 'parent plan', unitKind: 'node', unitId: 'parent' },
    { task: 'child plan', unitKind: 'node', unitId: 'child', dependsOn: 'parent' },
    { task: 'sibling plan', unitKind: 'node', unitId: 'sibling', dependsOn: 'parent' },
  ]);
});

test('batch dependency flags reject ambiguous or malformed edge declarations', () => {
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--task', 'b', '--unit-id', 'a',
    '--target', 't', '--gate', 'g',
  ]), /unit-id.*once per/i);
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--depends-on', 'a=b', '--target', 't', '--gate', 'g',
  ]), /depends-on requires.*unit-id/i);
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--unit-id', 'a', '--depends-on', 'not-an-edge',
    '--target', 't', '--gate', 'g',
  ]), /expected CHILD=PARENT/i);
});

test('batch rejects unsafe fan-out, bad kinds, and mismatched per-task kinds', () => {
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--target', 't', '--gate', 'g', '--concurrency', '17',
  ]), /range/i);
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--target', 't', '--gate', 'g', '--concurrency', '2.5',
  ]), /range/i);
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--target', 't', '--gate', 'g', '--unit-kind', 'planner',
  ]), /unit-kind.*planner/i);
  assert.throws(() => parseArgs([
    'batch', '--task', 'a', '--task', 'b', '--task', 'c', '--target', 't', '--gate', 'g',
    '--unit-kind', 'candidate', '--unit-kind', 'node',
  ]), /once.*all.*once per/i);
});
