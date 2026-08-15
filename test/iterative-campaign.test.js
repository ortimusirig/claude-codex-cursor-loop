import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAMPAIGN_STOP_REASONS,
  runCampaign,
} from '../src/campaign.js';
import { createEvent } from '../src/events.js';
import { exitCodeFor } from '../src/exit.js';

const SAFE_SCRATCH_BASE = process.env.CCC_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));

const usage = (tokens) => ({
  inputTokens: tokens,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  cacheWriteTokens: 0,
});

function candidateFacts(runId, outcome = 'review-ready', tokens = 1) {
  const failed = outcome !== 'review-ready' && outcome !== 'no-op';
  return {
    runId,
    outcome,
    gateStatus: outcome === 'gate-failed' ? 'failed' : 'passed',
    verdict: failed ? null : 'NO_BLOCKERS',
    verdictSource: failed ? null : 'result',
    verifierConsistency: failed ? null : { status: 'consistent' },
    intentVerdict: failed ? null : 'NO_BLOCKERS',
    intentVerdictSource: failed ? null : 'assistant',
    intentVerifierConsistency: failed ? null : { status: 'consistent' },
    gateFailure: outcome === 'gate-failed'
      ? { bin: 'node', args: ['--test'], code: 1 }
      : null,
    branch: `ccc/${runId}`,
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    tokens: { total: usage(tokens) },
  };
}

function candidate(task, unitId, perspective) {
  return { task, unitId, unitKind: 'candidate', perspective };
}

function emitUnitEvent(reporter, runId, type) {
  reporter?.(createEvent({ runId, stage: 'executor', type, fields: { attempt: 0 } }));
}

test('caller-supplied round 2 starts after round 1 and all results and events stay attributed', async () => {
  const campaignEvents = [];
  const unitEvents = new Map();
  const executionOrder = [];
  const roundOne = [
    candidate('first minimal plan', 'r1-minimal', 'minimal-change'),
    candidate('first test plan', 'r1-tests', 'test-first'),
  ];
  const roundTwo = [
    candidate('refined minimal plan', 'r2-minimal', 'minimal-change'),
    candidate('refined refactor plan', 'r2-refactor', 'refactor-first'),
    candidate('refined test plan', 'r2-tests', 'test-first'),
  ];

  const result = await runCampaign({
    campaignId: 'iterative-ordering',
    tasks: roundOne,
    candidateSet: true,
    maxRounds: 2,
    target: 'adapter-target',
    gate: [],
    concurrency: 2,
    tokenBudget: 100,
    reporter: (event) => campaignEvents.push(event),
    unitReporterFactory: ({ unitId }) => {
      const events = [];
      unitEvents.set(unitId, events);
      return (event) => events.push(event);
    },
    runUnit: async ({ runId, round, baseRef, reporter }) => {
      assert.equal(baseRef, undefined,
        'a later alternative must not inherit an earlier candidate branch');
      executionOrder.push(`${runId}:start:${round}`);
      emitUnitEvent(reporter, runId, 'start');
      await new Promise((resolve) => setImmediate(resolve));
      emitUnitEvent(reporter, runId, 'finish');
      executionOrder.push(`${runId}:finish:${round}`);
      return candidateFacts(runId, runId === 'r1-tests' ? 'gate-failed' : 'review-ready');
    },
    nextRound: ({ round, result: completed }) => {
      executionOrder.push(`next-round:${round}`);
      assert.equal(round, 1);
      assert.deepEqual(completed.units.map((entry) => entry.unitId), ['r1-minimal', 'r1-tests']);
      assert.equal(completed.alternatives.candidates[1].status, 'failed');
      return { tasks: roundTwo };
    },
  });

  const roundOneFinishes = executionOrder
    .map((value, index) => value.startsWith('r1-') && value.includes(':finish:') ? index : -1)
    .filter((index) => index >= 0);
  const firstRoundTwoStart = executionOrder.findIndex((value) => value.startsWith('r2-'));
  assert.equal(roundOneFinishes.length, 2, 'both first-round candidates must finish');
  assert.ok(firstRoundTwoStart > Math.max(...roundOneFinishes), executionOrder.join(', '));
  assert.ok(executionOrder.indexOf('next-round:1') > Math.max(...roundOneFinishes),
    'the caller receives completed reviews before supplying the next plans');

  assert.deepEqual(result.rounds.map((round) => ({
    round: round.round,
    units: round.units.map((entry) => entry.unitId),
  })), [
    { round: 1, units: ['r1-minimal', 'r1-tests'] },
    { round: 2, units: ['r2-minimal', 'r2-refactor', 'r2-tests'] },
  ]);
  assert.equal(result.stopReason, CAMPAIGN_STOP_REASONS.MAX_ROUNDS_REACHED);
  assert.equal(result.rollup.counts.planned, 5);
  assert.equal(result.rollup.counts.failed, 1);
  assert.equal(result.rounds[0].alternatives.candidates[1].outcome, 'gate-failed');
  assert.deepEqual(result.alternatives.candidates.map((entry) => entry.round), [1, 1, 2, 2, 2]);

  const unitStarts = campaignEvents.filter((event) => (
    event.stage === 'unit' && event.type === 'start'
  ));
  assert.deepEqual(unitStarts.filter((event) => event.round === 1).map((event) => event.unitId),
    ['r1-minimal', 'r1-tests']);
  assert.deepEqual(unitStarts.filter((event) => event.round === 2).map((event) => event.unitId),
    ['r2-minimal', 'r2-refactor', 'r2-tests']);
  const firstRoundFinishBoundary = campaignEvents.findIndex((event) => (
    event.stage === 'round' && event.type === 'finish' && event.round === 1
  ));
  const secondRoundStartBoundary = campaignEvents.findIndex((event) => (
    event.stage === 'round' && event.type === 'start' && event.round === 2
  ));
  assert.ok(firstRoundFinishBoundary >= 0 && secondRoundStartBoundary > firstRoundFinishBoundary);

  assert.deepEqual([...unitEvents.keys()], [
    'r1-minimal', 'r1-tests', 'r2-minimal', 'r2-refactor', 'r2-tests',
  ]);
  for (const [unitId, events] of unitEvents) {
    const expectedRound = unitId.startsWith('r1-') ? 1 : 2;
    assert.equal(events.length, 2, `${unitId} must have a non-vacuous unit stream`);
    assert.ok(events.every((event) => event.unitId === unitId));
    assert.ok(events.every((event) => event.round === expectedRound));
  }

  const forbiddenKeys = [];
  const visit = (value) => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/winner|selection|ranking|score/i.test(key)) forbiddenKeys.push(key);
      visit(child);
    }
  };
  visit(result);
  assert.deepEqual(forbiddenKeys, []);
});

test('round 2 gets a fresh campaign-base worktree rather than round 1 candidate code', async () => {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  const scratchRoot = mkdtempSync(join(SAFE_SCRATCH_BASE, '.iterative-base-'));
  const target = mkdtempSync(join(tmpdir(), 'iterative-base-target-'));
  writeFileSync(join(target, 'seed.txt'), 'shared campaign base\n');
  try {
    const result = await runCampaign({
      campaignId: 'iterative-fresh-base',
      tasks: [candidate('round one', 'fresh-r1', 'minimal-change')],
      candidateSet: true,
      maxRounds: 2,
      target,
      gate: [],
      scratchRoot,
      tokenBudget: 100,
      runOptions: {
        gateRetries: 0,
        adapters: {
          runExecutor: async ({ cwd, runId }) => {
            if (runId === 'fresh-r2') {
              assert.equal(existsSync(join(cwd, 'fresh-r1.txt')), false,
                'round 2 must not start from round 1 candidate code');
            }
            writeFileSync(join(cwd, `${runId}.txt`), `${runId}\n`);
            return {
              changedFiles: [`${runId}.txt`],
              lastMessage: runId,
              usage: usage(1),
            };
          },
          runGate: async () => ({ passed: true, results: [], testCount: 1 }),
          runVerifier: async ({ pass }) => ({
            verdict: 'NO_BLOCKERS',
            verdictSource: pass === 'correctness' ? 'result' : 'assistant',
            verdictConsistency: { status: 'consistent' },
            findings: `${pass} clean`,
            launchFailed: false,
            usage: usage(1),
          }),
        },
      },
      nextRound: () => ({
        tasks: [candidate('round two', 'fresh-r2', 'review-informed')],
      }),
    });

    assert.equal(result.rounds.length, 2);
    assert.equal(new Set(result.units.map((entry) => entry.facts.baseCommit)).size, 1);
    assert.equal(existsSync(join(target, 'fresh-r1.txt')), false);
    assert.equal(existsSync(join(target, 'fresh-r2.txt')), false);
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('a campaign-wide budget exhausted in round 1 finishes in-flight work and starts no round 2', async () => {
  const started = [];
  const finished = [];
  const result = await runCampaign({
    campaignId: 'iterative-budget',
    tasks: [
      candidate('one', 'budget-r1-a', 'minimal-change'),
      candidate('two', 'budget-r1-b', 'test-first'),
      candidate('three', 'budget-r1-c', 'refactor-first'),
    ],
    candidateSet: true,
    maxRounds: 2,
    target: 'adapter-target',
    gate: [],
    concurrency: 2,
    tokenBudget: 5,
    runUnit: async ({ runId }) => {
      started.push(runId);
      if (runId === 'budget-r1-b') await new Promise((resolve) => setImmediate(resolve));
      finished.push(runId);
      return candidateFacts(runId, 'review-ready', 6);
    },
    nextRound: () => ({
      tasks: [candidate('never', 'budget-r2', 'budget-informed')],
    }),
  });

  assert.deepEqual(started, ['budget-r1-a', 'budget-r1-b']);
  assert.deepEqual(new Set(finished), new Set(['budget-r1-a', 'budget-r1-b']),
    'both units that were already in flight must finish');
  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].rollup.counts.notDispatched, 1);
  assert.equal(result.stopReason, CAMPAIGN_STOP_REASONS.BUDGET_EXHAUSTED);
  assert.equal(result.rollup.outcome, 'budget-exhausted');
  assert.ok(result.rollup.consumedTokens > 5);
});

test('caller-requested stopping is distinct from budget and maximum-round stopping', async () => {
  let nextRoundCalled = false;
  const result = await runCampaign({
    campaignId: 'iterative-caller-stop',
    tasks: [candidate('enough', 'caller-r1', 'minimal-change')],
    candidateSet: true,
    maxRounds: 3,
    target: 'adapter-target',
    gate: [],
    tokenBudget: 100,
    runUnit: async ({ runId }) => candidateFacts(runId),
    shouldStop: ({ round, result: completed }) => {
      assert.equal(round, 1);
      assert.equal(completed.units[0].unitId, 'caller-r1');
      return true;
    },
    nextRound: () => {
      nextRoundCalled = true;
      return { tasks: [candidate('unused', 'caller-r2', 'unused')] };
    },
  });

  assert.equal(nextRoundCalled, false);
  assert.equal(result.rounds.length, 1);
  assert.equal(result.stopReason, CAMPAIGN_STOP_REASONS.CALLER_REQUESTED);
  assert.notEqual(result.stopReason, CAMPAIGN_STOP_REASONS.BUDGET_EXHAUSTED);
  assert.notEqual(result.stopReason, CAMPAIGN_STOP_REASONS.MAX_ROUNDS_REACHED);
});

test('maxRounds 1 retains the exact single-round aggregate shape and values', async () => {
  const base = {
    campaignId: 'one-round-compatible',
    tasks: [
      candidate('one', 'compatible-one', 'minimal-change'),
      candidate('two', 'compatible-two', 'test-first'),
    ],
    candidateSet: true,
    target: 'adapter-target',
    gate: [],
    tokenBudget: 100,
    runUnit: async ({ runId }) => candidateFacts(runId),
  };
  const current = await runCampaign(base);
  const explicitlyOne = await runCampaign({ ...base, maxRounds: 1 });

  assert.deepEqual(explicitlyOne, current);
  assert.deepEqual(Object.keys(current), [
    'campaignId', 'round', 'target', 'limits', 'units', 'rollup', 'alternatives',
  ]);
  assert.equal(Object.hasOwn(current, 'rounds'), false);
  assert.equal(Object.hasOwn(current, 'stopReason'), false);
});

test('all candidates failing across all rounds is a non-zero campaign failure', async () => {
  const result = await runCampaign({
    campaignId: 'iterative-all-failed',
    tasks: [candidate('first failure', 'failed-r1', 'minimal-change')],
    candidateSet: true,
    maxRounds: 2,
    target: 'adapter-target',
    gate: [],
    tokenBudget: 100,
    runUnit: async ({ runId }) => candidateFacts(runId, 'gate-failed'),
    nextRound: () => ({
      tasks: [candidate('informed failure', 'failed-r2', 'review-informed')],
    }),
  });

  assert.equal(result.rounds.length, 2);
  assert.equal(result.rollup.counts.failed, 2);
  assert.equal(result.rollup.counts.succeeded, 0);
  assert.equal(result.rollup.outcome, 'campaign-failed');
  assert.notEqual(exitCodeFor(result.rollup.outcome), 0);
  assert.ok(result.alternatives.candidates.every((entry) => entry.status === 'failed'));
});
