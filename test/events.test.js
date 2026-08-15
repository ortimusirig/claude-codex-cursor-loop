import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertEventConformance,
  createEvent,
  EVENT_PAIRS,
  EVENT_STAGES,
  formatEventSummary,
  MAX_EVENT_SUMMARY_LENGTH,
  reportEvent,
} from '../src/events.js';
import { runCampaign } from '../src/campaign.js';
import { runExecutor as realExecutor } from '../src/executor.js';
import { runGate as realGate } from '../src/gate.js';
import { run } from '../src/run.js';
import { runVerifier as realVerifier } from '../src/verifier.js';

const fakeWriter = fileURLToPath(new URL('../fixtures/fake-codex-writer.mjs', import.meta.url));
const fakeAgent = fileURLToPath(new URL('../fixtures/fake-agent.mjs', import.meta.url));
const SAFE_SCRATCH_BASE = process.env.CCC_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));

function scratch() {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  return mkdtempSync(join(SAFE_SCRATCH_BASE, '.run-'));
}

function target() {
  const dir = mkdtempSync(join(tmpdir(), 'events-target-'));
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  return dir;
}

test('event construction protects the envelope and summaries stay bounded to one line', () => {
  const event = createEvent({
    runId: 'run-1',
    stage: 'gate',
    type: 'gate_command',
    fields: {
      ts: 'shadow', stage: 'shadow', type: 'shadow', runId: 'shadow',
      bin: 'node', args: ['line one\nline two', 'x'.repeat(1000)], code: 1,
      outputTail: 'must never be rendered'.repeat(100),
    },
    now: () => new Date('2026-08-15T00:00:00.000Z'),
  });
  assert.deepEqual(
    { ts: event.ts, runId: event.runId, stage: event.stage, type: event.type },
    { ts: '2026-08-15T00:00:00.000Z', runId: 'run-1', stage: 'gate', type: 'gate_command' },
  );
  const summary = formatEventSummary(event);
  assert.ok(summary.length <= MAX_EVENT_SUMMARY_LENGTH);
  assert.doesNotMatch(summary, /[\r\n]/);
  assert.doesNotMatch(summary, /must never be rendered/);
});

test('event construction validates declared pairs and campaign identity vocabulary', () => {
  assert.throws(() => createEvent({
    runId: 'bad-pair', stage: 'campaign', type: 'file_change',
  }), /unknown event pair/i);
  assert.throws(() => createEvent({
    runId: 'bad-kind', campaignId: 'campaign', round: 1,
    unitId: 'unit', unitKind: 'planner', stage: 'unit', type: 'start',
  }), /unit kind/i);
  const event = createEvent({
    runId: 'unit', campaignId: 'campaign', round: 1,
    unitId: 'unit', unitKind: 'node', stage: 'unit', type: 'start',
  });
  assert.deepEqual({
    campaignId: event.campaignId,
    round: event.round,
    unitId: event.unitId,
    unitKind: event.unitKind,
  }, { campaignId: 'campaign', round: 1, unitId: 'unit', unitKind: 'node' });
});

test('stage transitions and executor file changes reach the reporter in order', async () => {
  const scr = scratch();
  const tgt = target();
  const events = [];
  try {
    const facts = await run({
      task: 'Write observed.txt.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'ordered-events', reporter: (event) => events.push(event),
      adapters: {
        runExecutor: (opts) => realExecutor({
          ...opts, bin: process.execPath, extraArgv: [fakeWriter],
        }),
        runGate: realGate,
        runVerifier: (opts) => realVerifier({
          ...opts, bin: process.execPath, extraArgv: [fakeAgent, 'clean'],
        }),
      },
    });
    assert.equal(facts.outcome, 'review-ready');
    assert.deepEqual(events.map((event) => `${event.stage}/${event.type}${event.pass ? `:${event.pass}` : ''}`), [
      'isolate/start',
      'isolate/finish',
      'executor/start',
      'executor/file_change',
      'executor/item_completed',
      'executor/finish',
      'gate/start',
      'gate/finish',
      'diff/start',
      'diff/finish',
      'verify/start:correctness',
      'verify/finish:correctness',
      'verify/start:intent',
      'verify/finish:intent',
      'verify/verdict',
      'report/start',
      'report/finish',
    ]);
    const fileChange = events.find((event) => event.type === 'file_change');
    assert.equal(fileChange.file, 'observed.txt');
    assert.equal(fileChange.runId, 'ordered-events');
    const isolateFinish = events.find((event) => (
      event.stage === 'isolate' && event.type === 'finish'
    ));
    assert.equal(isolateFinish.baseRef, 'HEAD');
    assert.equal(isolateFinish.branch, 'ccc/ordered-events');
    assert.match(isolateFinish.baseCommit, /^[0-9a-f]{40,64}$/);
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('each gate command reports its exit code without its output tail', async () => {
  const events = [];
  const result = await realGate({
    cwd: tmpdir(), runId: 'gate-events', reporter: (event) => events.push(event),
    commands: [
      { bin: process.execPath, args: ['-e', 'process.exit(0)'] },
      { bin: process.execPath, args: ['-e', 'process.stderr.write("huge details");process.exit(7)'] },
    ],
  });
  assert.equal(result.passed, false);
  const commands = events.filter((event) => event.type === 'gate_command');
  assert.deepEqual(commands.map((event) => event.code), [0, 7]);
  assert.ok(commands.every((event) => !Object.hasOwn(event, 'outputTail')));
});

test('a retry event says which gate failure started the next attempt', async () => {
  const scr = scratch();
  const tgt = target();
  const events = [];
  let gateAttempt = 0;
  try {
    const facts = await run({
      task: 'Repair the gate.', target: tgt, gate: [], gateRetries: 1,
      scratchRoot: scr, runId: 'retry-event', reporter: (event) => events.push(event),
      adapters: {
        runExecutor: async ({ cwd }) => {
          writeFileSync(join(cwd, 'repair.txt'), 'repaired\n');
          return { changedFiles: ['repair.txt'], lastMessage: 'repaired' };
        },
        runGate: async () => gateAttempt++ === 0
          ? { passed: false, results: [{ bin: 'node', args: ['--test'], code: 9,
              outputTail: 'details intentionally absent from the event' }] }
          : { passed: true, results: [] },
        runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
      },
    });
    assert.equal(facts.outcome, 'review-ready');
    const retry = events.find((event) => event.type === 'retry');
    assert.deepEqual({
      stage: retry.stage,
      attempt: retry.attempt,
      source: retry.source,
      reason: retry.reason,
      bin: retry.bin,
      args: retry.args,
      code: retry.code,
    }, {
      stage: 'executor',
      attempt: 2,
      source: 'gate',
      reason: 'gate command exited 9',
      bin: 'node',
      args: ['--test'],
      code: 9,
    });
    assert.equal(Object.hasOwn(retry, 'outputTail'), false);
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('omitting reporter emits nothing and creates no events artifact', async () => {
  const scr = scratch();
  const tgt = target();
  try {
    const facts = await run({
      task: 'Do nothing.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'no-reporter',
      adapters: {
        runExecutor: async () => ({ changedFiles: [], lastMessage: 'no changes' }),
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => { throw new Error('no-op must not verify'); },
      },
    });
    assert.equal(facts.outcome, 'no-op');
    assert.equal(existsSync(join(facts.dir, 'events.jsonl')), false);
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('a throwing reporter cannot change a run outcome', async () => {
  const scr = scratch();
  const tgt = target();
  try {
    const facts = await run({
      task: 'Do nothing.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'throwing-reporter',
      reporter: () => { throw new Error('logging is broken'); },
      adapters: {
        runExecutor: async () => ({ changedFiles: [], lastMessage: 'no changes' }),
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => { throw new Error('no-op must not verify'); },
      },
    });
    assert.equal(facts.outcome, 'no-op');
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('events.jsonl is excluded from CHANGES.diff while a real changed file remains', async () => {
  const scr = scratch();
  const tgt = target();
  const eventPath = join(scr, 'artifact-exclusion', 'w', 'events.jsonl');
  const reporter = (event) => {
    if (!existsSync(dirname(eventPath))) return;
    appendFileSync(eventPath, `${JSON.stringify(event)}\n`);
  };
  try {
    const facts = await run({
      task: 'Add new.txt.', target: tgt, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'artifact-exclusion', reporter,
      adapters: {
        runExecutor: async ({ cwd }) => {
          writeFileSync(join(cwd, 'new.txt'), 'real change\n');
          return { changedFiles: ['new.txt'], lastMessage: 'added new.txt' };
        },
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
      },
    });
    const diff = readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8');
    assert.match(diff, /new[.]txt/, 'positive control: a real change must remain in the diff');
    assert.doesNotMatch(diff, /events[.]jsonl/);
    assert.ok(readFileSync(eventPath, 'utf8').trim().split('\n').length > 1,
      'the excluded event artifact must actually exist and contain events');
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});

test('reportEvent also swallows an asynchronous reporter rejection', async () => {
  reportEvent(async () => { throw new Error('async logging failure'); },
    'async-reporter', 'report', 'finish', { file: 'x' });
  await new Promise((resolve) => setImmediate(resolve));
});

test('fully exercised campaign emissions have set equality with the declared event vocabulary', async () => {
  const scr = scratch();
  const tgt = target();
  const events = [];
  try {
    const result = await runCampaign({
      campaignId: 'event-conformance',
      tasks: [
        { task: 'Write observed.txt.', unitKind: 'node', unitId: 'conformance-parent' },
        {
          task: 'Observe the predecessor result.',
          unitKind: 'node',
          unitId: 'conformance-child',
          dependsOn: 'conformance-parent',
        },
      ],
      target: tgt,
      gate: [{
        bin: process.execPath,
        args: ['-e', [
          "const fs = require('node:fs');",
          "if (fs.existsSync('.conformance-gate')) process.exit(0);",
          "fs.writeFileSync('.conformance-gate', 'retry\\n');",
          'process.exit(1);',
        ].join('')],
      }],
      concurrency: 1,
      tokenBudget: 1000,
      scratchRoot: scr,
      reporter: (event) => events.push(event),
      unitReporterFactory: () => (event) => events.push(event),
      runOptions: {
        gateRetries: 1,
        adapters: {
          runExecutor: (opts) => realExecutor({
            ...opts, bin: process.execPath, extraArgv: [fakeWriter],
          }),
          runGate: realGate,
          runVerifier: (opts) => realVerifier({
            ...opts, bin: process.execPath, extraArgv: [fakeAgent, 'clean'],
          }),
        },
      },
    });
    assert.equal(result.rollup.outcome, 'review-ready');

    const UNEMITTED_IN_HEALTHY_RETRY_CAMPAIGN = [
      // The budget is deliberately ample, so every planned unit dispatches.
      'unit/not_dispatched',
      // Both predecessor runs succeed, so the dependent is released rather than skipped.
      'unit/skipped',
      // Each watchdog pair needs a real period of silence longer than its threshold. Injecting
      // those gaps would turn this healthy, fully exercised retry path into timeout scenarios.
      'isolate/stalled',
      'executor/stalled',
      'gate/stalled',
      'diff/stalled',
      'verify/stalled',
      'report/stalled',
    ];
    assert.doesNotThrow(() => assertEventConformance(events, {
      allowUnemitted: UNEMITTED_IN_HEALTHY_RETRY_CAMPAIGN,
    }));

    // Demonstrate the ratchet firing: this temporary declaration has no emitter in the
    // exercised campaign, so equality must reject it as missing.
    assert.throws(() => assertEventConformance(events, {
      declaredStages: [...EVENT_STAGES, 'planner'],
      declaredPairs: [...EVENT_PAIRS, 'planner/start'],
      allowUnemitted: UNEMITTED_IN_HEALTHY_RETRY_CAMPAIGN,
    }), /missing:.*planner\/start/);
  } finally {
    rmSync(tgt, { recursive: true, force: true });
    rmSync(scr, { recursive: true, force: true });
  }
});
