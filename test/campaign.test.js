import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runCampaign } from '../src/campaign.js';
import { reportEvent } from '../src/events.js';
import { exitCodeFor } from '../src/exit.js';
import { spawnCapture } from '../src/spawn.js';

const SAFE_SCRATCH_BASE = process.env.CCC_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));

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
  for (const [unitId, events] of unitEvents) {
    assert.ok(events.length > 0, `positive control: ${unitId} emitted no events`);
    assert.ok(events.every((event) => event.unitId === unitId),
      `${unitId}'s stream contains another unit's event`);
    assert.ok(events.every((event) => event.unitKind === lifecycleByUnit.get(unitId)));
  }
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

test('the single-writer campaign stream is valid NDJSON and stays outside every unit diff', async () => {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  const scratchRoot = mkdtempSync(join(SAFE_SCRATCH_BASE, '.campaign-'));
  const target = mkdtempSync(join(tmpdir(), 'campaign-target-'));
  const campaignDirectory = join(scratchRoot, 'stream-campaign');
  const campaignEventsPath = join(campaignDirectory, 'campaign-events.jsonl');
  mkdirSync(campaignDirectory);
  writeFileSync(join(target, 'seed.txt'), 'seed\n');
  try {
    const result = await runCampaign({
      campaignId: 'stream-campaign',
      tasks: ['change one', 'change two'],
      target,
      gate: [],
      concurrency: 2,
      tokenBudget: 1000,
      scratchRoot,
      reporter: (event) => appendFileSync(campaignEventsPath, `${JSON.stringify(event)}\n`),
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
    assert.ok(parsed.length >= 8, 'campaign, round, and two unit lifecycles must be present');
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
    const persisted = JSON.parse(readFileSync(join(facts.dir, 'ccc-runfacts.json'), 'utf8'));
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
