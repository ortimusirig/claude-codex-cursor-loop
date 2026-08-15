import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCampaign } from '../src/campaign.js';
import { exitCodeFor } from '../src/exit.js';
import { runGate } from '../src/gate.js';
import { MERGE_LEDGER_FILENAME, TEST_COUNT_FLOOR_BIN } from '../src/merge.js';
import { spawnCapture } from '../src/spawn.js';

const SAFE_SCRATCH_BASE = process.env.CCC_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));

const cleanVerifier = async () => ({
  verdict: 'NO_BLOCKERS', verdictSource: 'result', launchFailed: false, usage: {},
});

const successFacts = (runId) => ({
  runId,
  outcome: 'no-op',
  branch: `ccc/${runId}`,
  tokens: { total: {} },
});

async function gitOk(cwd, ...args) {
  const result = await spawnCapture('git', ['-C', cwd, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not observed');
}

function makeDirectories(prefix) {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  return {
    scratchRoot: mkdtempSync(join(SAFE_SCRATCH_BASE, `.${prefix}-`)),
    target: mkdtempSync(join(tmpdir(), `${prefix}-target-`)),
  };
}

function cleanup({ target, scratchRoot }) {
  rmSync(target, { recursive: true, force: true });
  rmSync(scratchRoot, { recursive: true, force: true });
}

function fanInTasks(prefix = 'fanin') {
  return [
    { task: 'Implement the left behavior.', unitId: `${prefix}-left`, unitKind: 'node' },
    { task: 'Implement the right behavior.', unitId: `${prefix}-right`, unitKind: 'node' },
    {
      task: 'Integrate the left and right behaviors.',
      unitId: `${prefix}-join`,
      unitKind: 'node',
      dependsOn: [`${prefix}-right`, `${prefix}-left`],
    },
  ];
}

test('a clean fan-in merge contains both distinctive parent changes and runs both verifiers', async () => {
  const dirs = makeDirectories('clean-fanin');
  writeFileSync(join(dirs.target, 'tests-baseline.test.js'), 'test("baseline", () => {});\n');
  const countTests = {
    bin: process.execPath,
    args: ['-e', [
      "const fs = require('node:fs');",
      "const files = fs.readdirSync('.').filter((name) => name.endsWith('.test.js'));",
      "const count = files.reduce((n, file) => n + (fs.readFileSync(file, 'utf8').match(/test\\s*\\(/g) || []).length, 0);",
      "process.stdout.write(`ℹ tests ${count}\\n`);",
    ].join('')],
  };
  const verifierPasses = [];
  const campaignEvents = [];
  const unitEvents = new Map();
  try {
    const result = await runCampaign({
      campaignId: 'clean-fanin',
      tasks: fanInTasks('clean'),
      target: dirs.target,
      gate: [countTests],
      concurrency: 2,
      tokenBudget: 1000,
      scratchRoot: dirs.scratchRoot,
      reporter: (event) => campaignEvents.push(event),
      unitReporterFactory: ({ unitId }) => {
        const events = [];
        unitEvents.set(unitId, events);
        return (event) => events.push(event);
      },
      runOptions: {
        gateRetries: 0,
        adapters: {
          runExecutor: async ({ cwd, runId, plan }) => {
            if (runId === 'clean-left') {
              writeFileSync(join(cwd, 'left-only.txt'), 'left parent: lunar-17\n');
              writeFileSync(join(cwd, 'left.test.js'),
                'test("left one", () => {});\ntest("left two", () => {});\n');
            } else if (runId === 'clean-right') {
              writeFileSync(join(cwd, 'right-only.txt'), 'right parent: solar-29\n');
              writeFileSync(join(cwd, 'right.test.js'), [
                'test("right one", () => {});',
                'test("right two", () => {});',
                'test("right three", () => {});',
                '',
              ].join('\n'));
            } else {
              assert.match(plan, /both parents? behavior survives|every parent behavior survives/i);
              assert.match(plan, /interaction.*seam|seam.*interaction/i);
              assert.equal(readFileSync(join(cwd, 'left-only.txt'), 'utf8').trim(),
                'left parent: lunar-17');
              assert.equal(readFileSync(join(cwd, 'right-only.txt'), 'utf8').trim(),
                'right parent: solar-29');
              writeFileSync(join(cwd, 'seam.test.js'), 'test("left and right seam", () => {});\n');
            }
            return { changedFiles: [], lastMessage: `completed ${runId}`, usage: {}, exitCode: 0 };
          },
          runGate,
          runVerifier: async ({ pass }) => {
            verifierPasses.push(pass);
            return cleanVerifier();
          },
        },
      },
    });

    const merge = result.units[2];
    assert.equal(merge.status, 'completed', JSON.stringify(merge));
    assert.equal(merge.unitKind, 'merge');
    assert.equal(merge.facts.unitKind, 'merge');
    assert.equal(merge.facts.outcome, 'review-ready');
    assert.equal(readFileSync(join(merge.facts.dir, 'left-only.txt'), 'utf8').trim(),
      'left parent: lunar-17');
    assert.equal(readFileSync(join(merge.facts.dir, 'right-only.txt'), 'utf8').trim(),
      'right parent: solar-29');
    assert.equal(existsSync(join(result.units[0].facts.dir, 'right-only.txt')), false,
      'the merge must not move the first parent branch');
    assert.equal(existsSync(join(result.units[1].facts.dir, 'left-only.txt')), false,
      'the merge must not move the second parent branch');
    assert.equal(existsSync(join(dirs.target, 'left-only.txt')), false,
      'the target folder must remain untouched');
    assert.equal(existsSync(join(dirs.target, 'right-only.txt')), false,
      'the target folder must remain untouched');
    assert.deepEqual(verifierPasses.slice(-2), ['correctness', 'intent']);
    assert.deepEqual(merge.facts.merge.parentOrder, ['clean-left', 'clean-right'],
      'graph declaration order, not dependsOn array order, selects the merge parent order');
    assert.equal(merge.facts.merge.testCounts.source, 'gate-output');
    assert.deepEqual(merge.facts.merge.testCounts.parents, [
      { unitId: 'clean-left', count: 3 },
      { unitId: 'clean-right', count: 4 },
    ]);
    assert.equal(merge.facts.merge.testCounts.baseline, 1);
    assert.equal(merge.facts.merge.testCounts.required, 6);
    assert.equal(merge.facts.merge.testCounts.actual, 7);
    const diff = readFileSync(join(merge.facts.dir, 'CHANGES.diff'), 'utf8');
    assert.match(diff, /left parent: lunar-17/);
    assert.match(diff, /right parent: solar-29/);
    const intent = readFileSync(join(merge.facts.dir, 'TASK.md'), 'utf8');
    assert.match(intent, /Add at least one new test.*interaction.*seam/i);
    assert.match(intent, /intent verifier.*every parent behavior survives.*seam is tested/i);
    assert.equal(Object.hasOwn(result.units[0].facts, 'unitKind'), false,
      'ordinary units retain their existing run-facts shape');
    const mergeCampaignEvents = campaignEvents.filter((event) => event.unitId === 'clean-join'
      && event.stage === 'merge');
    assert.deepEqual(mergeCampaignEvents.map((event) => `${event.type}:${event.verdict ?? ''}`),
      ['start:', 'finish:prepared'],
      'the campaign stream must expose merge-context preparation and its decision');
    const mergeUnitEvents = unitEvents.get('clean-join');
    assert.ok(mergeUnitEvents.some((event) => event.stage === 'merge' && event.type === 'start'),
      'the unit stream must expose mechanical merge work');
    assert.ok(mergeUnitEvents.some((event) => event.stage === 'merge'
      && event.type === 'finish' && event.verdict === 'merged'));
    const baselineGate = mergeUnitEvents.find((event) => (
      event.stage === 'gate' && event.type === 'gate_command' && event.scope === 'merge-baseline'
    ));
    assert.ok(baselineGate, 'the merge baseline-count gate command must not be invisible');
    assert.equal(baselineGate.attempt, 0);
    assert.deepEqual({
      campaignId: baselineGate.campaignId,
      round: baselineGate.round,
      unitId: baselineGate.unitId,
      unitKind: baselineGate.unitKind,
    }, {
      campaignId: 'clean-fanin', round: 1, unitId: 'clean-join', unitKind: 'merge',
    });
  } finally {
    cleanup(dirs);
  }
});

test('a text conflict reaches the executor with named paths and ledgers the resolution', async () => {
  const dirs = makeDirectories('conflict-fanin');
  writeFileSync(join(dirs.target, 'shared.txt'), 'baseline value\n');
  try {
    const result = await runCampaign({
      campaignId: 'conflict-fanin',
      tasks: fanInTasks('conflict'),
      target: dirs.target,
      gate: [],
      concurrency: 2,
      tokenBudget: 1000,
      scratchRoot: dirs.scratchRoot,
      runOptions: {
        gateRetries: 0,
        adapters: {
          runExecutor: async ({ cwd, runId, plan }) => {
            if (runId === 'conflict-left') {
              writeFileSync(join(cwd, 'shared.txt'), 'left contract\n');
              writeFileSync(join(cwd, 'left.test.js'), 'left test\n');
            } else if (runId === 'conflict-right') {
              writeFileSync(join(cwd, 'shared.txt'), 'right contract\n');
              writeFileSync(join(cwd, 'right.test.js'), 'right test\n');
            } else {
              assert.match(readFileSync(join(cwd, 'shared.txt'), 'utf8'), /<{7} HEAD/,
                'positive control: executor must receive the conflicted tree');
              assert.match(plan, /conflicts in:[\s\S]*shared[.]txt/i);
              assert.match(plan, /conflict-left[\s\S]*conflict-right/i);
              writeFileSync(join(cwd, 'shared.txt'), 'left contract + right contract\n');
              writeFileSync(join(cwd, 'seam.test.js'), 'combined contract seam\n');
              writeFileSync(join(cwd, MERGE_LEDGER_FILENAME), JSON.stringify({
                status: 'resolved',
                resolutions: [{
                  path: 'shared.txt',
                  chosen: 'retain both contracts in composed order',
                  reason: 'callers require the left prefix and right suffix together',
                }],
              }));
            }
            return { changedFiles: ['shared.txt'], lastMessage: `completed ${runId}`, usage: {} };
          },
          runGate,
          runVerifier: cleanVerifier,
        },
      },
    });

    assert.equal(result.units[2].status, 'completed', JSON.stringify(result.units[2]));
    const facts = result.units[2].facts;
    assert.equal(facts.outcome, 'review-ready');
    assert.deepEqual(facts.merge.conflicts[0].paths, ['shared.txt']);
    assert.deepEqual(facts.merge.resolutions, [{
      path: 'shared.txt',
      chosen: 'retain both contracts in composed order',
      reason: 'callers require the left prefix and right suffix together',
      parentUnitId: 'conflict-right',
    }]);
    const persisted = JSON.parse(readFileSync(join(facts.dir, 'ccc-runfacts.json'), 'utf8'));
    assert.equal(persisted.merge.resolutions[0].chosen,
      'retain both contracts in composed order');
    const report = readFileSync(join(facts.dir, 'ccc-report.md'), 'utf8');
    assert.match(report, /shared[.]txt[\s\S]*retain both contracts[\s\S]*left prefix and right suffix/i);
  } finally {
    cleanup(dirs);
  }
});

test('the merge gate test-count floor fails when conflict repair drops one parent test file', async () => {
  const dirs = makeDirectories('floor-fanin');
  writeFileSync(join(dirs.target, 'seed.txt'), 'baseline\n');
  try {
    const result = await runCampaign({
      campaignId: 'floor-fanin',
      tasks: fanInTasks('floor'),
      target: dirs.target,
      gate: [],
      concurrency: 2,
      tokenBudget: 1000,
      scratchRoot: dirs.scratchRoot,
      runOptions: {
        gateRetries: 0,
        adapters: {
          runExecutor: async ({ cwd, runId }) => {
            if (runId === 'floor-left') {
              writeFileSync(join(cwd, 'left.test.js'), 'left behavior test\n');
            } else if (runId === 'floor-right') {
              writeFileSync(join(cwd, 'right.test.js'), 'right behavior test\n');
            } else {
              rmSync(join(cwd, 'right.test.js'));
              writeFileSync(join(cwd, 'left.test.js'),
                'left behavior test plus a nominal seam in the same file\n');
            }
            return { changedFiles: [], lastMessage: `completed ${runId}`, usage: {} };
          },
          runGate,
          runVerifier: async ({ runId }) => {
            if (runId === 'floor-join') {
              throw new Error('a failed floor must stop before verification');
            }
            return cleanVerifier();
          },
        },
      },
    });

    assert.equal(result.units[2].status, 'completed', JSON.stringify(result.units));
    const facts = result.units[2].facts;
    assert.equal(facts.merge.testCounts.required, 2);
    assert.equal(facts.merge.testCounts.actual, 1);
    assert.equal(facts.outcome, 'gate-failed');
    assert.equal(facts.gateFailure.harness, TEST_COUNT_FLOOR_BIN);
    assert.match(facts.gateFailure.outputTail, /actual=1 required=2/);
    assert.equal(readFileSync(join(facts.dir, 'left.test.js'), 'utf8'),
      'left behavior test plus a nominal seam in the same file\n');
    assert.throws(() => readFileSync(join(facts.dir, 'right.test.js'), 'utf8'), /ENOENT/);
  } finally {
    cleanup(dirs);
  }
});

test('genuinely conflicting intent stops with a distinct terminal outcome before gate or review', async () => {
  const dirs = makeDirectories('intent-fanin');
  writeFileSync(join(dirs.target, 'policy.txt'), 'baseline policy\n');
  let mergeGateCalls = 0;
  let verifierCalls = 0;
  try {
    const result = await runCampaign({
      campaignId: 'intent-fanin',
      tasks: fanInTasks('intent'),
      target: dirs.target,
      gate: [],
      concurrency: 2,
      tokenBudget: 1000,
      scratchRoot: dirs.scratchRoot,
      runOptions: {
        gateRetries: 0,
        adapters: {
          runExecutor: async ({ cwd, runId }) => {
            if (runId === 'intent-left') {
              writeFileSync(join(cwd, 'policy.txt'), 'policy must allow anonymous access\n');
            } else if (runId === 'intent-right') {
              writeFileSync(join(cwd, 'policy.txt'), 'policy must forbid anonymous access\n');
            } else {
              writeFileSync(join(cwd, MERGE_LEDGER_FILENAME), JSON.stringify({
                status: 'conflicting-intent',
                resolutions: [{
                  path: 'policy.txt',
                  chosen: 'left unresolved for human direction',
                  reason: 'allowing and forbidding anonymous access are incompatible intents',
                }],
              }));
            }
            return { changedFiles: [], lastMessage: `completed ${runId}`, usage: {} };
          },
          runGate: async (options) => {
            if (options.commands.some((command) => command.harness === TEST_COUNT_FLOOR_BIN)) {
              mergeGateCalls++;
            }
            return { passed: true, results: [] };
          },
          runVerifier: async ({ runId }) => {
            if (runId === 'intent-join') verifierCalls++;
            return cleanVerifier();
          },
        },
      },
    });

    const facts = result.units[2].facts;
    assert.equal(facts.outcome, 'conflicting-intent');
    assert.notEqual(exitCodeFor(facts.outcome), 0);
    assert.notEqual(exitCodeFor(facts.outcome), exitCodeFor('gate-failed'));
    assert.equal(facts.gateStatus, 'not-run');
    assert.equal(mergeGateCalls, 0);
    assert.equal(verifierCalls, 0);
    assert.equal(facts.merge.resolutions[0].reason,
      'allowing and forbidding anonymous access are incompatible intents');
  } finally {
    cleanup(dirs);
  }
});

test('fan-in waits for every parent, one failed parent skips it, and the skip cascades', async () => {
  const launched = [];
  const resolvers = new Map();
  const waiting = runCampaign({
    campaignId: 'wait-all',
    tasks: [
      { task: 'left', unitId: 'wait-left' },
      { task: 'right', unitId: 'wait-right' },
      { task: 'merge', unitId: 'wait-merge', dependsOn: ['wait-left', 'wait-right'] },
    ],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    runUnit: ({ runId }) => new Promise((resolve) => {
      launched.push(runId);
      if (runId === 'wait-merge') resolve(successFacts(runId));
      else resolvers.set(runId, () => resolve(successFacts(runId)));
    }),
  });
  await waitUntil(() => resolvers.size === 2);
  resolvers.get('wait-left')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(launched, ['wait-left', 'wait-right'],
    'the merge must remain undispatched after only one parent succeeds');
  resolvers.get('wait-right')();
  const completed = await waiting;
  assert.deepEqual(launched, ['wait-left', 'wait-right', 'wait-merge']);
  assert.equal(completed.units[2].unitKind, 'merge');

  const failedLaunches = [];
  const failed = await runCampaign({
    campaignId: 'failed-fanin',
    tasks: [
      { task: 'left', unitId: 'failed-left' },
      { task: 'right', unitId: 'failed-right' },
      { task: 'merge', unitId: 'failed-merge', dependsOn: ['failed-left', 'failed-right'] },
      { task: 'after', unitId: 'failed-after', dependsOn: 'failed-merge' },
    ],
    target: 'unused-by-adapter',
    gate: [],
    concurrency: 2,
    tokenBudget: 1000,
    runUnit: async ({ runId }) => {
      failedLaunches.push(runId);
      return runId === 'failed-right'
        ? { ...successFacts(runId), outcome: 'gate-failed' }
        : successFacts(runId);
    },
  });
  assert.deepEqual(new Set(failedLaunches), new Set(['failed-left', 'failed-right']));
  assert.equal(failed.units[2].status, 'skipped');
  assert.equal(failed.units[2].blockedByUnitId, 'failed-right');
  assert.equal(failed.units[3].status, 'skipped');
  assert.equal(failed.units[3].reason, 'predecessor-skipped');
});

test('a fan-in merge holds no concurrency slot while its parents are pending', async () => {
  const launched = [];
  const result = await runCampaign({
    campaignId: 'fanin-single-slot',
    tasks: [
      { task: 'first', unitId: 'slot-first' },
      { task: 'second', unitId: 'slot-second' },
      { task: 'merge', unitId: 'slot-merge', dependsOn: ['slot-first', 'slot-second'] },
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
  assert.deepEqual(launched, ['slot-first', 'slot-second', 'slot-merge']);
  assert.equal(result.rollup.counts.succeeded, 3);
});

test('the same graph twice selects the same merge base and canonical parent order', async () => {
  const seed = mkdtempSync(join(tmpdir(), 'deterministic-seed-'));
  const first = makeDirectories('deterministic-one');
  const second = makeDirectories('deterministic-two');
  try {
    await gitOk(seed, 'init', '-b', 'main');
    writeFileSync(join(seed, 'baseline.test.js'), 'baseline test\n');
    await gitOk(seed, 'add', '-A');
    await gitOk(seed, '-c', 'user.email=t@t', '-c', 'user.name=t',
      'commit', '-m', 'deterministic baseline');
    const expectedBase = await gitOk(seed, 'rev-parse', 'HEAD');
    rmSync(first.target, { recursive: true, force: true });
    rmSync(second.target, { recursive: true, force: true });
    cpSync(seed, first.target, { recursive: true });
    cpSync(seed, second.target, { recursive: true });

    const execute = async (dirs, reverseDelay) => runCampaign({
      campaignId: `deterministic-${reverseDelay ? 'reverse' : 'forward'}`,
      tasks: [
        { task: 'Implement the right side.', unitId: 'order-right' },
        { task: 'Implement the left side.', unitId: 'order-left' },
        { task: 'Merge both ordered sides.', unitId: 'order-merge', dependsOn: ['order-left', 'order-right'] },
      ],
      target: dirs.target,
      gate: [],
      concurrency: 2,
      tokenBudget: 1000,
      scratchRoot: dirs.scratchRoot,
      runOptions: {
        gateRetries: 0,
        adapters: {
          runExecutor: async ({ cwd, runId }) => {
            if ((runId === 'order-right') === reverseDelay) {
              await new Promise((resolve) => setTimeout(resolve, 15));
            }
            if (runId === 'order-right') writeFileSync(join(cwd, 'right.test.js'), 'right\n');
            else if (runId === 'order-left') writeFileSync(join(cwd, 'left.test.js'), 'left\n');
            else writeFileSync(join(cwd, 'seam.test.js'), 'seam\n');
            return { changedFiles: [], lastMessage: runId, usage: {} };
          },
          runGate,
          runVerifier: cleanVerifier,
        },
      },
    });
    const [a, b] = await Promise.all([execute(first, false), execute(second, true)]);
    assert.equal(a.units[2].status, 'completed', JSON.stringify(a.units));
    assert.equal(b.units[2].status, 'completed', JSON.stringify(b.units));
    const mergeA = a.units[2].facts.merge;
    const mergeB = b.units[2].facts.merge;
    assert.deepEqual(mergeA.parentOrder, ['order-right', 'order-left']);
    assert.deepEqual(mergeB.parentOrder, mergeA.parentOrder);
    assert.equal(mergeA.mergeBase, expectedBase);
    assert.equal(mergeB.mergeBase, expectedBase);
  } finally {
    rmSync(seed, { recursive: true, force: true });
    cleanup(first);
    cleanup(second);
  }
});
