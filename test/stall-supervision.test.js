import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportEvent } from '../src/events.js';
import { exitCodeFor } from '../src/exit.js';
import { run } from '../src/run.js';

const SAFE_SCRATCH_BASE = process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));

function scratch() {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  return mkdtempSync(join(SAFE_SCRATCH_BASE, '.stall-'));
}

function target() {
  const directory = mkdtempSync(join(tmpdir(), 'stall-target-'));
  writeFileSync(join(directory, 'seed.txt'), 'seed\n');
  return directory;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function executorEvent(opts, type, fields = {}) {
  reportEvent(opts.reporter, opts.runId, 'executor', type, {
    attempt: opts.attempt, ...fields,
  });
}

test('report policy records a real stall, never supplies a kill signal, and keeps normal outcome',
  async () => {
    const scr = scratch();
    const tgt = target();
    const events = [];
    try {
      const facts = await run({
        task: 'Think, then make no change.', target: tgt, gate: [], gateRetries: 0,
        scratchRoot: scr, runId: 'report-stall', reporter: (event) => events.push(event),
        stallPolicy: 'report', stallThresholdMs: 25, stallRestartLimit: 1,
        adapters: {
          runExecutor: async (opts) => {
            assert.equal(opts.signal, undefined, 'report policy must allocate no kill signal');
            executorEvent(opts, 'start');
            await delay(70);
            executorEvent(opts, 'finish', { code: 0 });
            return { changedFiles: [], lastMessage: 'finished after thinking', timedOut: false };
          },
          runGate: async () => ({ passed: true, results: [] }),
          runVerifier: async () => { throw new Error('a no-op must not verify'); },
        },
      });
      assert.equal(facts.outcome, 'no-op');
      assert.equal(facts.retryCounts.stall, 0);
      assert.ok(facts.stallEvents.some((event) => event.stage === 'executor'));
      assert.ok(events.some((event) => event.stage === 'executor' && event.type === 'stalled'),
        'positive control: report behavior must be proved with a stall that actually fired');
      assert.match(readFileSync(join(facts.dir, 'uro-report.md'), 'utf8'), /## Stalls/);
    } finally {
      rmSync(tgt, { recursive: true, force: true });
      rmSync(scr, { recursive: true, force: true });
    }
  });

test('restart kills the stalled attempt, augments its replacement plan, and stops at its bound',
  async () => {
    const scr = scratch();
    const tgt = target();
    const plans = [];
    const killed = [];
    let calls = 0;
    try {
      const facts = await run({
        task: 'Complete the original task.', target: tgt, gate: [], gateRetries: 0,
        scratchRoot: scr, runId: 'restart-stall', reporter: () => {},
        stallPolicy: 'restart', stallThresholdMs: 25, stallRestartLimit: 1,
        adapters: {
          runExecutor: async (opts) => {
            plans.push(opts.plan);
            executorEvent(opts, 'start');
            calls++;
            if (calls === 1) {
              assert.ok(opts.signal, 'restart policy needs a signal while budget remains');
              await new Promise((resolve) => opts.signal.addEventListener('abort', resolve,
                { once: true }));
              killed.push(opts.signal.aborted);
              executorEvent(opts, 'finish', { code: -1 });
              return { changedFiles: [], lastMessage: 'stopped', aborted: true };
            }
            assert.equal(opts.signal, undefined,
              'the exhausted restart budget must not arm another destructive action');
            await delay(70);
            executorEvent(opts, 'finish', { code: 0 });
            return { changedFiles: [], lastMessage: 'completed', timedOut: false };
          },
          runGate: async () => ({ passed: true, results: [] }),
          runVerifier: async () => { throw new Error('a no-op must not verify'); },
        },
      });
      assert.deepEqual(killed, [true], 'the first stalled launch must actually receive abort');
      assert.equal(calls, 2, 'one allowed restart means exactly two executor launches');
      assert.equal(plans[0], 'Complete the original task.');
      assert.ok(plans[1].startsWith(plans[0]));
      assert.match(plans[1], /Previous executor attempt stalled/);
      assert.match(plans[1], /Last event: executor\/start/);
      assert.equal(facts.retryCounts.stall, 1);
      assert.equal(facts.limits.stall.restartLimit, 1);
      assert.ok(facts.stallEvents.some((event) => event.action === 'restart'));
      assert.ok(facts.stallEvents.some((event) => event.stage === 'executor'
        && event.action === 'report'),
      'positive control: the second silence is observed but cannot exceed the kill bound');
      assert.equal(facts.outcome, 'no-op');
    } finally {
      rmSync(tgt, { recursive: true, force: true });
      rmSync(scr, { recursive: true, force: true });
    }
  });

test('stall restarts and gate retries have independent counters with different values', async () => {
  const scr = scratch();
  const tgt = target();
  let executorCalls = 0;
  let gateCalls = 0;
  try {
    const facts = await run({
      task: 'Make a gated change.', target: tgt, gate: [], gateRetries: 2,
      scratchRoot: scr, runId: 'separate-retries', reporter: () => {},
      stallPolicy: 'restart', stallThresholdMs: 25, stallRestartLimit: 1,
      adapters: {
        runExecutor: async (opts) => {
          executorCalls++;
          executorEvent(opts, 'start');
          if (executorCalls === 1) {
            await new Promise((resolve) => opts.signal.addEventListener('abort', resolve,
              { once: true }));
            executorEvent(opts, 'finish', { code: -1 });
            return { changedFiles: [], lastMessage: 'stopped', aborted: true };
          }
          writeFileSync(join(opts.cwd, 'changed.txt'), `attempt ${executorCalls}\n`);
          executorEvent(opts, 'file_change', { file: 'changed.txt' });
          executorEvent(opts, 'finish', { code: 0 });
          return { changedFiles: ['changed.txt'], lastMessage: 'changed', timedOut: false };
        },
        runGate: async () => ++gateCalls <= 2
          ? { passed: false, results: [{ bin: 'node', args: ['--test'], code: 9,
              outputTail: 'still red' }] }
          : { passed: true, results: [] },
        runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
      },
    });
    assert.equal(facts.outcome, 'review-ready');
    assert.deepEqual(facts.retryCounts, { gate: 2, stall: 1 },
      'a shared retry counter could not produce these distinct values');
    assert.equal(facts.limits.gateRetries, 2);
    assert.equal(facts.limits.stall.restartLimit, 1);
    assert.equal(executorCalls, 4, 'killed launch + replacement + two gate-driven launches');
    assert.equal(gateCalls, 3);
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('a run that remains stalled until its stage timeout has a non-zero outcome', async () => {
  const scr = scratch();
  const tgt = target();
  try {
    const facts = await run({
      task: 'Do not report a stalled timeout as success.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'stalled-timeout', reporter: () => {},
      stallPolicy: 'report', stallThresholdMs: 25,
      adapters: {
        runExecutor: async (opts) => {
          executorEvent(opts, 'start');
          await delay(70);
          executorEvent(opts, 'finish', { code: -1, timedOut: true });
          return { changedFiles: [], lastMessage: 'timed out', timedOut: true,
            timeoutMs: 70, exitCode: -1 };
        },
        runGate: async () => { throw new Error('timed-out executor must not reach the gate'); },
        runVerifier: async () => { throw new Error('timed-out executor must not verify'); },
      },
    });
    assert.ok(facts.stallEvents.some((event) => event.stage === 'executor'),
      'positive control: this timeout must also have crossed the stall threshold');
    assert.equal(facts.outcome, 'timed-out');
    assert.notEqual(exitCodeFor(facts.outcome), 0);
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('without a reporter even invalid watchdog settings are never resolved', async () => {
  const scr = scratch();
  const tgt = target();
  try {
    const facts = await run({
      task: 'No observer means no watchdog.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'no-watchdog', env: { URO_STALL_POLICY: 'invalid' },
      adapters: {
        runExecutor: async (opts) => {
          assert.equal(opts.signal, undefined);
          return { changedFiles: [], lastMessage: 'unchanged' };
        },
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => { throw new Error('no-op must not verify'); },
      },
    });
    assert.equal(facts.outcome, 'no-op');
    assert.equal(Object.hasOwn(facts, 'stallEvents'), false);
    assert.equal(Object.hasOwn(facts, 'retryCounts'), false);
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});
