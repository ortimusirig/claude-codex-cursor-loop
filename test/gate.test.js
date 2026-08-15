import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GATE_TAIL_LIMIT, runGate } from '../src/gate.js';
import { testCountFloorCommand, TEST_COUNT_FLOOR_BIN } from '../src/merge.js';

const ok = { bin: process.execPath, args: ['-e', 'process.exit(0)'] };
const bad = { bin: process.execPath, args: ['-e', 'process.exit(1)'] };

test('all-zero commands pass', async () => {
  const r = await runGate({ commands: [ok, ok], cwd: process.cwd() });
  assert.equal(r.passed, true);
  assert.equal(r.results.length, 2);
});

test('a non-zero command fails the gate and short-circuits', async () => {
  const r = await runGate({ commands: [ok, bad, ok], cwd: process.cwd() });
  assert.equal(r.passed, false);
  assert.equal(r.results.length, 2, 'stops at the first failure');
  assert.equal(r.results[1].code, 1);
});

test('only the failing command retains labelled tails from both stdout and stderr', async () => {
  const passing = {
    bin: process.execPath,
    args: ['-e', 'process.stdout.write("PASSING OUTPUT")'],
  };
  const failing = {
    bin: process.execPath,
    args: ['-e', 'process.stdout.write("STDOUT FAILURE DETAIL"); process.stderr.write("STDERR FAILURE DETAIL"); process.exit(7)'],
  };
  const r = await runGate({ commands: [passing, failing], cwd: process.cwd() });
  assert.equal(r.passed, false);
  assert.deepEqual(r.results[0], { ...passing, code: 0 });
  assert.equal(Object.hasOwn(r.results[0], 'outputTail'), false);
  assert.equal(r.results[1].code, 7);
  assert.match(r.results[1].outputTail, /stdout/i);
  assert.match(r.results[1].outputTail, /STDOUT FAILURE DETAIL/);
  assert.match(r.results[1].outputTail, /stderr/i);
  assert.match(r.results[1].outputTail, /STDERR FAILURE DETAIL/);
  assert.ok(r.results[1].outputTail.length <= GATE_TAIL_LIMIT);
});

test('failing output retention keeps stream endings rather than their heads', async () => {
  const failing = {
    bin: process.execPath,
    args: ['-e', [
      'process.stdout.write("STDOUT HEAD" + "o".repeat(5000) + "STDOUT TAIL")',
      'process.stderr.write("STDERR HEAD" + "e".repeat(5000) + "STDERR TAIL")',
      'process.exit(1)',
    ].join(';')],
  };
  const r = await runGate({ commands: [failing], cwd: process.cwd() });
  const tail = r.results[0].outputTail;
  assert.match(tail, /STDOUT TAIL/);
  assert.match(tail, /STDERR TAIL/);
  assert.doesNotMatch(tail, /STDOUT HEAD/);
  assert.doesNotMatch(tail, /STDERR HEAD/);
  assert.ok(tail.length <= GATE_TAIL_LIMIT);
});

test('an empty command list passes vacuously', async () => {
  const r = await runGate({ commands: [], cwd: process.cwd() });
  assert.equal(r.passed, true);
});

test('a derived test-count floor is enforced by its own exit code', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gate-count-'));
  const reportsSeven = {
    bin: process.execPath,
    args: ['-e', "process.stdout.write('ℹ tests 7\\n')"],
  };
  try {
    const r = await runGate({
      commands: [reportsSeven, testCountFloorCommand(8)],
      cwd,
    });
    assert.equal(r.testCount, 7);
    assert.equal(r.passed, false);
    assert.equal(r.results[1].harness, TEST_COUNT_FLOOR_BIN);
    assert.equal(r.results[1].code, 1);
    assert.match(r.results[1].outputTail, /actual=7 required=8/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a timed-out gate command fails with an explicit timeout marker', async () => {
  const slow = {
    bin: process.execPath,
    args: ['-e', 'process.stdout.write("gate started"); setTimeout(() => {}, 5000)'],
  };
  const r = await runGate({ commands: [slow], cwd: process.cwd(), timeoutMs: 300 });
  assert.equal(r.passed, false);
  assert.equal(r.results[0].timedOut, true);
  assert.equal(r.results[0].timeoutMs, 300);
  assert.notEqual(r.results[0].code, 0);
  assert.match(r.results[0].outputTail, /gate started/);
});
