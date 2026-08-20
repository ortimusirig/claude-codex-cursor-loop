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
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countUsageTokens, runCampaign } from '../src/campaign.js';
import { parsePartialEventStream } from '../src/event-stream.js';
import { formatEventSummary, reportEvent } from '../src/events.js';
import { exitCodeFor } from '../src/exit.js';
import { spawnCapture } from '../src/spawn.js';
import {
  addUsage,
  normalizeCodexUsage,
  normalizeCursorUsage,
} from '../src/usage.js';

const SAFE_SCRATCH_BASE = process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));

const codexUsageSamplePath = fileURLToPath(
  new URL('../fixtures/codex-exec-usage-sample.ndjson', import.meta.url),
);
const cursorUsageSamplePath = fileURLToPath(
  new URL('../fixtures/cursor-plan-mode-sample.ndjson', import.meta.url),
);

function capturedVendorUsage() {
  const codexRaw = readFileSync(codexUsageSamplePath, 'utf8')
    .trim().split(/\r?\n/).map(JSON.parse).at(-1).usage;
  const cursorRaw = readFileSync(cursorUsageSamplePath, 'utf8')
    .trim().split(/\r?\n/).map(JSON.parse).find((event) => event.type === 'result').usage;
  return {
    codex: normalizeCodexUsage(codexRaw),
    cursor: normalizeCursorUsage(cursorRaw),
  };
}

const successFacts = (runId, tokens = 0) => ({
  runId,
  outcome: 'no-op',
  tokens: {
    total: {
      inputTokens: tokens,
      cachedInputTokens: Math.floor(tokens / 2),
      outputTokens: 0,
      reasoningOutputTokens: 0,
      cacheWriteTokens: 0,
    },
  },
});

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not observed');
}

async function gitOk(cwd, ...args) {
  const result = await spawnCapture('git', ['-C', cwd, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

test('several independent units all conclude and retain one aggregate entry each', async () => {
  const result = await runCampaign({
    campaignId: 'all-complete',
    tasks: ['one', 'two', 'three'],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    runUnit: async ({ runId }) => successFacts(runId, 3),
  });

  assert.equal(result.units.length, 3);
  assert.deepEqual(result.units.map((entry) => entry.status),
    ['completed', 'completed', 'completed']);
  assert.deepEqual(result.units.map((entry) => entry.facts.runId),
    result.units.map((entry) => entry.unitId));
  assert.deepEqual(result.rollup.counts, {
    planned: 3, dispatched: 3, completed: 3, succeeded: 3, failed: 0, notDispatched: 0,
  });
  assert.equal(result.rollup.outcome, 'review-ready');
});

test('a campaign sums captured Codex and Cursor usage with non-negative uncached input', async () => {
  const captured = capturedVendorUsage();
  const result = await runCampaign({
    campaignId: 'captured-mixed-usage',
    tasks: ['codex executor', 'cursor verifier'],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 1,
    tokenBudget: 1_000_000,
    runUnit: async ({ task, runId }) => ({
      ...successFacts(runId),
      tokens: { total: task.startsWith('codex') ? captured.codex : captured.cursor },
    }),
  });

  const expected = addUsage(captured.codex, captured.cursor);
  assert.deepEqual(result.rollup.tokens, expected);
  assert.equal(expected.inputTokens, 89755);
  assert.equal(expected.cachedInputTokens, 64640);
  assert.equal(expected.inputTokens - expected.cachedInputTokens, 25115);
  assert.ok(result.rollup.tokens.inputTokens - result.rollup.tokens.cachedInputTokens >= 0);
  assert.equal(result.rollup.usageConsistency.status, 'consistent');
});

test('configured concurrency bounds the observed in-flight unit count', async () => {
  let inFlight = 0;
  let observedMaximum = 0;
  const observations = [];
  const result = await runCampaign({
    campaignId: 'bounded',
    tasks: ['one', 'two', 'three', 'four'],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    runUnit: async ({ runId }) => {
      inFlight++;
      observedMaximum = Math.max(observedMaximum, inFlight);
      observations.push(inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight--;
      observations.push(inFlight);
      return successFacts(runId);
    },
  });

  assert.equal(result.rollup.counts.completed, 4);
  assert.equal(observedMaximum, 2,
    `actual in-flight observations were ${JSON.stringify(observations)}`);
  assert.ok(observations.includes(2), 'positive control: two units must actually overlap');
  assert.ok(observations.every((count) => count <= 2), 'no observation may exceed the bound');
});

test('a dependent isolates from its predecessor result branch and sees its exact content', async () => {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  const scratchRoot = mkdtempSync(join(SAFE_SCRATCH_BASE, '.tree-inheritance-'));
  const target = mkdtempSync(join(tmpdir(), 'tree-inheritance-target-'));
  writeFileSync(join(target, 'seed.txt'), 'campaign base\n');
  try {
    const result = await runCampaign({
      campaignId: 'tree-inheritance',
      tasks: [
        { task: 'Write the predecessor marker.', unitId: 'tree-parent', unitKind: 'node' },
        {
          task: 'Observe the predecessor marker.',
          unitId: 'tree-child',
          unitKind: 'node',
          dependsOn: 'tree-parent',
        },
      ],
      target,
      gate: [],
      concurrency: 2,
      tokenBudget: 1000,
      scratchRoot,
      runOptions: {
        gateRetries: 0,
        adapters: {
          runExecutor: async ({ cwd, runId }) => {
            if (runId === 'tree-parent') {
              writeFileSync(join(cwd, 'predecessor.txt'), 'specific predecessor content: alpha-42');
              return { changedFiles: ['predecessor.txt'], lastMessage: 'wrote predecessor', usage: {} };
            }
            const inherited = readFileSync(join(cwd, 'predecessor.txt'), 'utf8');
            writeFileSync(join(cwd, 'dependent-observation.txt'), `observed: ${inherited}`);
            return {
              changedFiles: ['dependent-observation.txt'],
              lastMessage: 'observed predecessor',
              usage: {},
            };
          },
          runGate: async () => ({ passed: true, results: [] }),
          runVerifier: async () => ({
            verdict: 'NO_BLOCKERS', verdictSource: 'result', launchFailed: false, usage: {},
          }),
        },
      },
    });

    const [parent, child] = result.units;
    assert.equal(parent.facts.outcome, 'review-ready');
    assert.equal(child.facts.outcome, 'review-ready');
    assert.equal(child.facts.baseRef, parent.facts.branch,
      'the child must name the predecessor result branch, not the campaign base');
    assert.equal(child.facts.baseCommit, parent.resultCommit,
      'the child base commit must be the checkpoint containing the predecessor result');
    assert.equal(
      readFileSync(join(child.facts.dir, 'predecessor.txt'), 'utf8'),
      'specific predecessor content: alpha-42',
    );
    assert.equal(
      readFileSync(join(child.facts.dir, 'dependent-observation.txt'), 'utf8'),
      'observed: specific predecessor content: alpha-42',
    );
    assert.equal(existsSync(join(target, 'predecessor.txt')), false,
      'the campaign must not materialize predecessor changes in the target folder');
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('a dependent starts after its predecessor finishes and receives a release event', async () => {
  const observed = [];
  const events = [];
  const result = await runCampaign({
    campaignId: 'ordered-tree',
    tasks: [
      { task: 'parent', unitId: 'ordered-parent', branch: 'planner/ordered-parent' },
      { task: 'child', unitId: 'ordered-child', dependsOn: 'ordered-parent' },
    ],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    reporter: (event) => events.push(event),
    runUnit: async ({ runId, baseRef }) => {
      observed.push(`start:${runId}`);
      await new Promise((resolve) => setImmediate(resolve));
      observed.push(`finish:${runId}`);
      if (runId === 'ordered-child') assert.equal(baseRef, 'planner/ordered-parent');
      return { ...successFacts(runId), branch: runId === 'ordered-parent'
        ? 'planner/ordered-parent' : `ccc/${runId}` };
    },
  });

  assert.equal(result.rollup.outcome, 'review-ready');
  assert.ok(
    observed.indexOf('finish:ordered-parent') < observed.indexOf('start:ordered-child'),
    `observed order was ${JSON.stringify(observed)}`,
  );
  const parentFinish = events.findIndex((event) => (
    event.unitId === 'ordered-parent' && event.stage === 'unit' && event.type === 'finish'
  ));
  const childRelease = events.findIndex((event) => (
    event.unitId === 'ordered-child' && event.stage === 'unit' && event.type === 'released'
  ));
  const childStart = events.findIndex((event) => (
    event.unitId === 'ordered-child' && event.stage === 'unit' && event.type === 'start'
  ));
  assert.ok(parentFinish >= 0 && parentFinish < childRelease && childRelease < childStart,
    `unit lifecycle was ${JSON.stringify(events.map((event) => `${event.unitId}:${event.type}`))}`);
});

test('siblings released by one predecessor actually overlap up to the concurrency bound', async () => {
  let siblingInFlight = 0;
  let observedMaximum = 0;
  const observations = [];
  const result = await runCampaign({
    campaignId: 'sibling-overlap',
    tasks: [
      { task: 'parent', unitId: 'sibling-parent' },
      { task: 'left', unitId: 'sibling-left', dependsOn: 'sibling-parent' },
      { task: 'right', unitId: 'sibling-right', dependsOn: 'sibling-parent' },
    ],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    runUnit: async ({ runId }) => {
      if (runId !== 'sibling-parent') {
        siblingInFlight++;
        observedMaximum = Math.max(observedMaximum, siblingInFlight);
        observations.push(siblingInFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        siblingInFlight--;
        observations.push(siblingInFlight);
      }
      return successFacts(runId);
    },
  });

  assert.equal(result.rollup.counts.succeeded, 3);
  assert.equal(observedMaximum, 2,
    `actual sibling in-flight observations were ${JSON.stringify(observations)}`);
  assert.ok(observations.includes(2), 'positive control: both siblings must actually overlap');
});

test('a waiting unit holds no slot when concurrency is one', async () => {
  const launched = [];
  const campaign = runCampaign({
    campaignId: 'single-slot-chain',
    tasks: [
      { task: 'parent', unitId: 'slot-parent' },
      { task: 'child', unitId: 'slot-child', dependsOn: 'slot-parent' },
    ],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 1,
    tokenBudget: 1000,
    runUnit: async ({ runId }) => {
      launched.push(runId);
      await new Promise((resolve) => setImmediate(resolve));
      return successFacts(runId);
    },
  });
  let deadlockTimer;
  const result = await Promise.race([
    campaign,
    new Promise((_, reject) => {
      deadlockTimer = setTimeout(() => reject(new Error('chain deadlocked')), 500);
    }),
  ]).finally(() => clearTimeout(deadlockTimer));
  assert.deepEqual(launched, ['slot-parent', 'slot-child']);
  assert.equal(result.rollup.counts.succeeded, 2);
});

test('a failed predecessor skips descendants transitively while an unrelated branch finishes', async () => {
  const launched = [];
  const events = [];
  const result = await runCampaign({
    campaignId: 'skip-cascade',
    tasks: [
      { task: 'broken root', unitId: 'broken-root' },
      { task: 'blocked child', unitId: 'blocked-child', dependsOn: 'broken-root' },
      { task: 'blocked grandchild', unitId: 'blocked-grandchild', dependsOn: 'blocked-child' },
      { task: 'independent root', unitId: 'independent-root' },
    ],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    reporter: (event) => events.push(event),
    runUnit: async ({ runId }) => {
      launched.push(runId);
      await new Promise((resolve) => setImmediate(resolve));
      return runId === 'broken-root'
        ? { ...successFacts(runId), outcome: 'gate-failed' }
        : successFacts(runId);
    },
  });

  assert.deepEqual(new Set(launched), new Set(['broken-root', 'independent-root']));
  assert.equal(result.units[0].status, 'completed');
  assert.equal(result.units[1].status, 'skipped');
  assert.equal(result.units[1].reason, 'predecessor-failed');
  assert.equal(result.units[2].status, 'skipped');
  assert.equal(result.units[2].reason, 'predecessor-skipped');
  assert.equal(result.units[2].blockedByUnitId, 'broken-root');
  assert.equal(result.units[3].status, 'completed');
  assert.deepEqual(result.rollup.counts, {
    planned: 4,
    dispatched: 2,
    completed: 2,
    succeeded: 1,
    failed: 1,
    notDispatched: 0,
    skipped: 2,
  });
  assert.equal(result.rollup.outcome, 'campaign-failed');
  assert.deepEqual(
    events.filter((event) => event.type === 'skipped').map((event) => event.unitId),
    ['blocked-child', 'blocked-grandchild'],
  );
});

test('all failed predecessor outcomes block children, while no-op releases them', async () => {
  for (const outcome of ['gate-failed', 'timed-out', 'verifier-failed']) {
    const launched = [];
    const result = await runCampaign({
      campaignId: `blocked-${outcome}`,
      tasks: [
        { task: 'parent', unitId: `parent-${outcome}` },
        { task: 'child', unitId: `child-${outcome}`, dependsOn: `parent-${outcome}` },
      ],
      target: 'unused-by-adapter',
      gate: [],
      concurrency: 1,
      tokenBudget: 1000,
      runUnit: async ({ runId }) => {
        launched.push(runId);
        return { ...successFacts(runId), outcome };
      },
    });
    assert.deepEqual(launched, [`parent-${outcome}`]);
    assert.equal(result.units[1].status, 'skipped');
    assert.equal(result.units[1].blockedByOutcome, outcome);
  }

  const noOpLaunches = [];
  const noOp = await runCampaign({
    campaignId: 'no-op-releases',
    tasks: [
      { task: 'parent', unitId: 'no-op-parent', branch: 'planner/no-op-parent' },
      { task: 'child', unitId: 'no-op-child', dependsOn: 'no-op-parent' },
    ],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 1,
    tokenBudget: 1000,
    runUnit: async ({ runId, baseRef }) => {
      noOpLaunches.push(runId);
      if (runId === 'no-op-child') assert.equal(baseRef, 'planner/no-op-parent');
      return successFacts(runId);
    },
  });
  assert.deepEqual(noOpLaunches, ['no-op-parent', 'no-op-child']);
  assert.equal(noOp.units[1].status, 'completed');
});

test('every invalid graph is rejected before any executor launches', async () => {
  const cases = [
    {
      name: 'unknown parent',
      tasks: [{ task: 'child', unitId: 'unknown-child', dependsOn: 'missing-parent' }],
      pattern: /unknown-child.*unknown unit.*missing-parent/i,
    },
    {
      name: 'self dependency',
      tasks: [{ task: 'self', unitId: 'self-unit', dependsOn: 'self-unit' }],
      pattern: /self-unit.*depend on itself/i,
    },
    {
      name: 'duplicate parent',
      tasks: [
        { task: 'a', unitId: 'duplicate-a' },
        { task: 'child', unitId: 'duplicate-child', dependsOn: ['duplicate-a', 'duplicate-a'] },
      ],
      pattern: /duplicate-child.*duplicate parent.*duplicate-a/i,
    },
    {
      name: 'cycle',
      tasks: [
        { task: 'a', unitId: 'cycle-a', dependsOn: 'cycle-b' },
        { task: 'b', unitId: 'cycle-b', dependsOn: 'cycle-a' },
      ],
      pattern: /cycle.*cycle-a.*cycle-b/i,
    },
  ];
  for (const invalid of cases) {
    let launches = 0;
    await assert.rejects(runCampaign({
      campaignId: `invalid-${invalid.name.replaceAll(' ', '-')}`,
      tasks: invalid.tasks,
      target: 'must-not-be-touched',
      gate: [],
      concurrency: 2,
      tokenBudget: 1000,
      runUnit: async () => {
        launches++;
        return successFacts('impossible');
      },
    }), invalid.pattern, invalid.name);
    assert.equal(launches, 0, `${invalid.name} launched an executor before validation`);
  }
});

test('campaign summaries make predecessor waiting distinct from a watchdog stall', async () => {
  const events = [];
  await runCampaign({
    campaignId: 'waiting-observability',
    tasks: [
      { task: 'parent', unitId: 'watch-parent' },
      { task: 'child', unitId: 'watch-child', dependsOn: 'watch-parent' },
    ],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 1,
    tokenBudget: 1000,
    reporter: (event) => events.push(event),
    runUnit: async ({ runId }) => successFacts(runId),
  });
  const waiting = events.find((event) => event.unitId === 'watch-child' && event.type === 'waiting');
  assert.ok(waiting, 'the campaign stream must state that the child is waiting');
  assert.equal(waiting.predecessorUnitId, 'watch-parent');
  assert.match(formatEventSummary(waiting), /waiting on predecessor=watch-parent/i);
  assert.doesNotMatch(formatEventSummary(waiting), /stalled/i,
    'waiting on declared topology must not be presented as a watchdog stall');
});

test('one failed unit is isolated while its peers finish and the campaign is non-zero', async () => {
  const finished = [];
  const result = await runCampaign({
    campaignId: 'isolated-failure',
    tasks: ['green-a', 'red', 'green-b'],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    runUnit: async ({ task, runId }) => {
      await new Promise((resolve) => setImmediate(resolve));
      finished.push(task);
      return task === 'red'
        ? { ...successFacts(runId), outcome: 'gate-failed' }
        : successFacts(runId);
    },
  });

  assert.deepEqual(new Set(finished), new Set(['green-a', 'red', 'green-b']));
  assert.equal(result.rollup.counts.completed, 3);
  assert.equal(result.rollup.counts.failed, 1);
  assert.equal(result.rollup.counts.succeeded, 2);
  assert.equal(result.rollup.outcome, 'campaign-failed');
  assert.notEqual(exitCodeFor(result.rollup.outcome), 0);
});

test('exceeding the token budget stops dispatch while already in-flight units finish', async () => {
  const launched = [];
  const resolvers = new Map();
  const campaign = runCampaign({
    campaignId: 'budget-stop',
    tasks: ['one', 'two', 'three', 'four'],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 2,
    tokenBudget: 10,
    runUnit: ({ task, runId }) => new Promise((resolve) => {
      launched.push(task);
      resolvers.set(task, () => resolve(successFacts(runId, 11)));
    }),
  });

  await waitUntil(() => launched.length === 2);
  assert.deepEqual(launched, ['one', 'two']);
  resolvers.get('one')();
  await waitUntil(() => resolvers.has('two') && launched.length === 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(launched, ['one', 'two'], 'no third unit may dispatch after the overage');
  resolvers.get('two')();

  const result = await campaign;
  assert.equal(result.rollup.outcome, 'budget-exhausted');
  assert.equal(result.rollup.budgetExceeded, true);
  assert.equal(result.rollup.counts.completed, 2,
    'both units that were in flight must reach their conclusion');
  assert.equal(result.rollup.counts.notDispatched, 2);
  assert.deepEqual(result.units.slice(2).map((entry) => entry.reason),
    ['token-budget-exceeded', 'token-budget-exceeded']);
  assert.notEqual(exitCodeFor(result.rollup.outcome), 0);
});

test('Cursor cache reads count toward the campaign ceiling before another unit dispatches', async () => {
  const { cursor } = capturedVendorUsage();
  const oldUnderCount = cursor.inputTokens - cursor.cachedInputTokens + cursor.outputTokens;
  const correctedCount = countUsageTokens(cursor);
  const tokenBudget = 40_000;
  assert.ok(oldUnderCount < tokenBudget, 'positive control: old accounting stays below ceiling');
  assert.ok(correctedCount > tokenBudget, 'corrected accounting must cross the ceiling');

  const launched = [];
  const result = await runCampaign({
    campaignId: 'cursor-inclusive-budget',
    tasks: ['first', 'must-not-launch'],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 1,
    tokenBudget,
    runUnit: async ({ task, runId }) => {
      launched.push(task);
      return { ...successFacts(runId), tokens: { total: cursor } };
    },
  });

  assert.deepEqual(launched, ['first']);
  assert.equal(result.rollup.consumedTokens, 59823);
  assert.equal(result.rollup.outcome, 'budget-exhausted');
  assert.equal(result.rollup.counts.notDispatched, 1);
  assert.equal(result.units[1].reason, 'token-budget-exceeded');
});

test('campaign and concurrent unit events carry complete, correctly scoped identity', async () => {
  const campaignEvents = [];
  const unitEvents = new Map();
  const result = await runCampaign({
    campaignId: 'identity',
    tasks: [
      { task: 'candidate work', unitKind: 'candidate', unitId: 'candidate-1' },
      { task: 'merge work', unitKind: 'merge', unitId: 'merge-1' },
    ],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    reporter: (event) => campaignEvents.push(event),
    unitReporterFactory: ({ unitId }) => {
      const events = [];
      unitEvents.set(unitId, events);
      return (event) => events.push(event);
    },
    runUnit: async ({ runId, reporter }) => {
      reportEvent(reporter, runId, 'executor', 'start', { attempt: 1 });
      await new Promise((resolve) => setImmediate(resolve));
      reportEvent(reporter, runId, 'executor', 'finish', { attempt: 1, code: 0 });
      return successFacts(runId);
    },
  });

  assert.equal(result.rollup.counts.completed, 2);
  for (const event of campaignEvents) {
    for (const field of ['campaignId', 'round', 'unitId', 'unitKind']) {
      assert.ok(Object.hasOwn(event, field), `campaign event omitted ${field}`);
    }
    assert.equal(event.campaignId, 'identity');
    assert.equal(event.round, 1);
  }
  const lifecycleByUnit = new Map([
    ['candidate-1', 'candidate'],
    ['merge-1', 'merge'],
  ]);
  const unitLifecycle = campaignEvents.filter((event) => event.stage === 'unit');
  assert.deepEqual(unitLifecycle.slice(0, 2).map((event) => event.type), ['start', 'start'],
    'positive control: both units must be in flight before either finishes');
  for (const event of unitLifecycle) {
    assert.equal(event.unitKind, lifecycleByUnit.get(event.unitId),
      `wrong unit attribution for ${JSON.stringify(event)}`);
  }
  const attributedCampaignEvents = campaignEvents.filter((event) => event.unitId !== null);
  assert.ok(attributedCampaignEvents.some((event) => (
    event.stage === 'planner' && event.type === 'review_received' && event.unitId === 'candidate-1'
  )), 'candidate 1 must feed an attributed review record to the planner');
  assert.ok(attributedCampaignEvents.some((event) => (
    event.stage === 'planner' && event.type === 'review_received' && event.unitId === 'merge-1'
  )), 'merge 1 must feed an attributed review record to the planner');
  for (const event of attributedCampaignEvents) {
    assert.equal(event.unitKind, lifecycleByUnit.get(event.unitId),
      `campaign stream cross-attributed ${event.stage}/${event.type}`);
  }
  for (const [unitId, events] of unitEvents) {
    assert.ok(events.length > 0, `positive control: ${unitId} emitted no events`);
    assert.ok(events.every((event) => event.unitId === unitId),
      `${unitId}'s stream contains another unit's event`);
    assert.ok(events.every((event) => event.unitKind === lifecycleByUnit.get(unitId)));
  }
});

test('planner events retain candidate perspectives, both reviews, synthesis choice, and reasoning', async () => {
  const events = [];
  let plannerInput;
  const result = await runCampaign({
    campaignId: 'planner-observability',
    round: 2,
    tasks: [
      { task: 'minimal plan', unitId: 'candidate-minimal', perspective: 'minimal-change' },
      { task: 'refactor plan', unitId: 'candidate-refactor', perspective: 'refactor-first' },
    ],
    target: 'unused-by-adapter', gate: [], concurrency: 2, tokenBudget: 1000,
    reporter: (event) => events.push(event),
    runUnit: async ({ runId }) => ({
      ...successFacts(runId),
      outcome: 'review-ready',
      gateStatus: 'passed',
      verdict: 'NO_BLOCKERS',
      verdictSource: 'result',
      verifierFindings: `${runId} correctness reasoning`,
      intentVerdict: 'NO_BLOCKERS',
      intentVerdictSource: 'assistant',
      intentVerifierFindings: `${runId} intent reasoning`,
    }),
    plannerSynthesis: async (input) => {
      plannerInput = input;
      return {
        decision: 'synthesize-both',
        selectedUnitIds: ['candidate-minimal', 'candidate-refactor'],
        reasoning: 'Use the minimal surface with the refactor candidate structural boundary.',
      };
    },
  });

  assert.equal(result.round, 2);
  assert.deepEqual(events.filter((event) => event.type === 'candidate_generated')
    .map((event) => [event.unitId, event.perspective]), [
    ['candidate-minimal', 'minimal-change'],
    ['candidate-refactor', 'refactor-first'],
  ]);
  assert.deepEqual(plannerInput.reviews.map((review) => ({
    unitId: review.unitId,
    complete: review.complete,
    correctness: review.correctness.findings,
    intent: review.intent.findings,
  })), [
    {
      unitId: 'candidate-minimal', complete: true,
      correctness: 'candidate-minimal correctness reasoning',
      intent: 'candidate-minimal intent reasoning',
    },
    {
      unitId: 'candidate-refactor', complete: true,
      correctness: 'candidate-refactor correctness reasoning',
      intent: 'candidate-refactor intent reasoning',
    },
  ]);
  const synthesis = events.find((event) => event.type === 'synthesis');
  assert.equal(synthesis.decision, 'synthesize-both');
  assert.match(synthesis.reasoning, /minimal surface.*structural boundary/);
  assert.deepEqual(synthesis.selectedUnitIds, ['candidate-minimal', 'candidate-refactor']);
  assert.deepEqual({ unitId: synthesis.unitId, unitKind: synthesis.unitKind },
    { unitId: null, unitKind: null });
});

test('a missing required review is explicit planner input rather than silent absence', async () => {
  const events = [];
  let reviews;
  await runCampaign({
    campaignId: 'missing-review',
    tasks: [{ task: 'candidate', unitId: 'missing-correctness', perspective: 'risk-first' }],
    target: 'unused-by-adapter', gate: [], concurrency: 1, tokenBudget: 1000,
    reporter: (event) => events.push(event),
    runUnit: async ({ runId }) => ({
      ...successFacts(runId),
      outcome: 'verifier-failed',
      gateStatus: 'passed',
      verdict: null,
      intentVerdict: 'NO_BLOCKERS',
      intentVerifierFindings: 'intent completed',
    }),
    plannerSynthesis: (input) => {
      reviews = input.reviews;
      return { decision: 'stop', reasoning: 'Correctness review is missing.' };
    },
  });
  assert.deepEqual(reviews[0].missing, ['correctness']);
  assert.equal(reviews[0].complete, false);
  const event = events.find((candidate) => candidate.type === 'review_received');
  assert.deepEqual(event.missing, ['correctness']);
  assert.equal(event.complete, false);
});

test('broken campaign and unit event sinks cannot change campaign outcomes', async () => {
  const result = await runCampaign({
    campaignId: 'broken-sinks',
    tasks: ['one', 'two'],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    reporter: async () => { throw new Error('campaign sink failed'); },
    unitReporterFactory: () => () => { throw new Error('unit sink failed'); },
    runUnit: async ({ runId, reporter }) => {
      reportEvent(reporter, runId, 'executor', 'start');
      return successFacts(runId);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.rollup.outcome, 'review-ready');
  assert.equal(result.rollup.counts.succeeded, 2);
});

test('attaching campaign observability does not change the aggregate result', async () => {
  const options = {
    campaignId: 'reporter-transparent',
    tasks: [
      { task: 'one', unitId: 'transparent-one' },
      { task: 'two', unitId: 'transparent-two' },
    ],
    target: 'unused-by-adapter', gate: [], concurrency: 1, tokenBudget: 1000,
    runUnit: async ({ runId }) => successFacts(runId, 3),
  };
  const withoutReporter = await runCampaign(options);
  const withReporter = await runCampaign({ ...options, reporter: () => {} });
  assert.deepEqual(withReporter, withoutReporter,
    'a reporter must add events only, never fields, timers, files, or changed campaign behavior');
});

test('the single-writer campaign stream is valid NDJSON and stays outside every unit diff', async () => {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  const scratchRoot = mkdtempSync(join(SAFE_SCRATCH_BASE, '.campaign-'));
  const target = mkdtempSync(join(tmpdir(), 'campaign-target-'));
  const campaignDirectory = join(scratchRoot, 'stream-campaign');
  const campaignEventsPath = join(campaignDirectory, 'campaign-events.jsonl');
  mkdirSync(campaignDirectory);
  writeFileSync(join(target, 'seed.txt'), 'seed\n');
  let observedDuringWrites = 0;
  try {
    const result = await runCampaign({
      campaignId: 'stream-campaign',
      tasks: ['change one', 'change two'],
      target,
      gate: [],
      concurrency: 2,
      tokenBudget: 1000,
      scratchRoot,
      reporter: (event) => {
        appendFileSync(campaignEventsPath, `${JSON.stringify(event)}\n`);
        const liveText = readFileSync(campaignEventsPath, 'utf8');
        const liveEvents = parsePartialEventStream(liveText, campaignEventsPath);
        assert.equal(liveEvents.at(-1)?.type, event.type,
          'every append must leave the live campaign stream parseable through its newest line');
        observedDuringWrites++;
      },
      runOptions: {
        gateRetries: 0,
        adapters: {
          runExecutor: async ({ cwd, runId }) => {
            const file = `${runId}.txt`;
            writeFileSync(join(cwd, file), 'real unit change\n');
            return { changedFiles: [file], lastMessage: 'changed', usage: {} };
          },
          runGate: async () => ({ passed: true, results: [] }),
          runVerifier: async () => ({
            verdict: 'NO_BLOCKERS', verdictSource: 'result', launchFailed: false, usage: {},
          }),
        },
      },
    });

    const lines = readFileSync(campaignEventsPath, 'utf8').trim().split(/\r?\n/);
    const parsed = lines.map((line, index) => {
      assert.doesNotThrow(() => JSON.parse(line), `campaign line ${index + 1} is invalid JSON`);
      return JSON.parse(line);
    });
    assert.equal(observedDuringWrites, parsed.length,
      'positive control: every campaign line was read while the writer was still active');
    assert.ok(parsed.length >= 8, 'campaign, round, and two unit lifecycles must be present');
    const campaignBase = parsed.filter((event) => event.stage === 'isolate'
      && event.scope === 'campaign-base');
    assert.deepEqual(campaignBase.map((event) => [event.type, event.verdict ?? null]), [
      ['start', null], ['finish', 'ready'],
    ]);
    assert.ok(campaignBase.every((event) => event.unitId === null && event.unitKind === null),
      'shared-base isolation belongs to the campaign, never an arbitrary concurrent unit');
    appendFileSync(campaignEventsPath, '{"ts":"partial-campaign-record"');
    assert.deepEqual(parsePartialEventStream(readFileSync(campaignEventsPath, 'utf8')),
      parsed, 'a partial final append must not hide or corrupt any completed campaign record');
    for (const entry of result.units) {
      const diff = readFileSync(join(entry.facts.dir, 'CHANGES.diff'), 'utf8');
      assert.match(diff, new RegExp(`${entry.unitId}[.]txt`),
        'positive control: the unit must have a real diff');
      assert.doesNotMatch(diff, /campaign-events[.]jsonl/);
      assert.ok(relative(entry.facts.dir, campaignEventsPath).startsWith('..'),
        'campaign stream must live outside the unit worktree');
    }
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('a non-repo campaign gives every unit exactly one shared root commit', async () => {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  const scratchRoot = mkdtempSync(join(SAFE_SCRATCH_BASE, '.shared-base-'));
  const target = mkdtempSync(join(tmpdir(), 'shared-base-target-'));
  writeFileSync(join(target, 'seed.txt'), 'one campaign baseline\n');
  try {
    const result = await runCampaign({
      campaignId: 'shared-nonrepo-base',
      tasks: ['unit one', 'unit two', 'unit three'],
      target,
      gate: [],
      concurrency: 3,
      tokenBudget: 1000,
      scratchRoot,
      runOptions: {
        gateRetries: 0,
        adapters: {
          runExecutor: async () => ({ changedFiles: [], lastMessage: 'no changes', usage: {} }),
          runGate: async () => ({ passed: true, results: [] }),
          runVerifier: async () => { throw new Error('no-op units must not verify'); },
        },
      },
    });

    assert.equal(result.rollup.counts.succeeded, 3);
    const roots = await Promise.all(result.units.map((entry) => (
      gitOk(entry.facts.dir, 'rev-list', '--max-parents=0', 'HEAD')
    )));
    assert.equal(roots.length, 3, 'positive control: every unit must contribute a root');
    assert.equal(new Set(roots).size, 1,
      `all units must share one campaign root, got ${JSON.stringify(roots)}`);
    const commonDirectories = await Promise.all(result.units.map((entry) => (
      gitOk(entry.facts.dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    )));
    assert.equal(new Set(commonDirectories).size, 1,
      'positive control: equal commit hashes are insufficient; units must share one repository');
    assert.ok(result.units.every((entry) => entry.facts.isRepo === false),
      'the facts must continue to describe the original non-repo target');
    assert.ok(result.units.every((entry) => entry.facts.baseRef === 'HEAD'));
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('campaign unit topology reaches isolation and is recorded in run facts', async () => {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  const scratchRoot = mkdtempSync(join(SAFE_SCRATCH_BASE, '.facts-base-'));
  const target = mkdtempSync(join(tmpdir(), 'facts-base-target-'));
  let result;
  try {
    await gitOk(target, 'init', '-b', 'main');
    writeFileSync(join(target, 'version.txt'), 'selected base\n');
    await gitOk(target, 'add', '-A');
    await gitOk(target, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base');
    const selectedCommit = await gitOk(target, 'rev-parse', 'HEAD');
    await gitOk(target, 'tag', 'planner-base');
    writeFileSync(join(target, 'version.txt'), 'different HEAD\n');
    await gitOk(target, 'add', '-A');
    await gitOk(target, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'head');

    result = await runCampaign({
      campaignId: 'facts-topology',
      tasks: [{
        task: 'Do nothing.',
        unitId: 'facts-unit',
        unitKind: 'node',
        baseRef: 'planner-base',
        branch: 'planner/facts-unit',
      }],
      target,
      gate: [],
      concurrency: 1,
      tokenBudget: 1000,
      scratchRoot,
      runOptions: {
        gateRetries: 0,
        adapters: {
          runExecutor: async () => ({ changedFiles: [], lastMessage: 'no changes', usage: {} }),
          runGate: async () => ({ passed: true, results: [] }),
          runVerifier: async () => { throw new Error('no-op unit must not verify'); },
        },
      },
    });

    const facts = result.units[0].facts;
    assert.equal(facts.baseRef, 'planner-base');
    assert.equal(facts.baseCommit, selectedCommit);
    assert.equal(facts.branch, 'planner/facts-unit');
    assert.equal(readFileSync(join(facts.dir, 'version.txt'), 'utf8').trim(), 'selected base');
    const persisted = JSON.parse(readFileSync(join(facts.dir, 'uro-runfacts.json'), 'utf8'));
    assert.deepEqual(
      { baseRef: persisted.baseRef, baseCommit: persisted.baseCommit, branch: persisted.branch },
      { baseRef: 'planner-base', baseCommit: selectedCommit, branch: 'planner/facts-unit' },
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('one campaign isolation failure does not prevent another unit from running', async () => {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  const scratchRoot = mkdtempSync(join(SAFE_SCRATCH_BASE, '.isolate-failure-'));
  const target = mkdtempSync(join(tmpdir(), 'isolate-failure-target-'));
  try {
    await gitOk(target, 'init', '-b', 'main');
    writeFileSync(join(target, 'seed.txt'), 'seed\n');
    await gitOk(target, 'add', '-A');
    await gitOk(target, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base');
    await gitOk(target, 'branch', 'planner/already-there');

    const result = await runCampaign({
      campaignId: 'isolate-one-fails',
      tasks: [
        { task: 'This unit fails.', unitId: 'bad-unit', branch: 'planner/already-there' },
        { task: 'This unit succeeds.', unitId: 'good-unit', branch: 'planner/good-unit' },
      ],
      target,
      gate: [],
      concurrency: 2,
      tokenBudget: 1000,
      scratchRoot,
      runOptions: {
        gateRetries: 0,
        adapters: {
          runExecutor: async () => ({ changedFiles: [], lastMessage: 'ran', usage: {} }),
          runGate: async () => ({ passed: true, results: [] }),
          runVerifier: async () => { throw new Error('no-op unit must not verify'); },
        },
      },
    });

    assert.equal(result.units[0].status, 'failed');
    assert.match(result.units[0].error.message, /already exists/i);
    assert.equal(result.units[1].status, 'completed');
    assert.equal(result.units[1].facts.outcome, 'no-op');
    assert.equal(result.rollup.counts.failed, 1);
    assert.equal(result.rollup.counts.succeeded, 1);
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});
