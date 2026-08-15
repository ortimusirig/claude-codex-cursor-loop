import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/args.js';
import { DEFAULT_EXECUTOR_EFFORT, DEFAULT_EXECUTOR_MODEL } from '../src/executor.js';
import { run, diffText, mergeVerifierVerdicts } from '../src/run.js';
import { EMPTY_USAGE } from '../src/usage.js';
import {
  DEFAULT_PROMPT,
  DEFAULT_VERIFIER_MODEL,
  INTENT_PROMPT,
  parseVerdictDetail,
} from '../src/verifier.js';
import { spawnCapture } from '../src/spawn.js';
import { exitCodeFor } from '../src/exit.js';

function makeTarget(withFile = true) {
  const d = mkdtempSync(join(tmpdir(), 'tgt-'));
  if (withFile) writeFileSync(join(d, 'seed.txt'), 'seed');
  return d;
}
// Scratch base must satisfy assertSafeScratchRoot: NOT under AppData or OneDrive.
// os.tmpdir() is under AppData on Windows and process.cwd() is under OneDrive for a
// checkout that lives in a synced folder — both are rejected by the guard. Mirror the
// production default from bin/loop.js, which is safe by the same construction.
const SAFE_SCRATCH_BASE = process.env.CCC_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));
const scratch = () => {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  return mkdtempSync(join(SAFE_SCRATCH_BASE, '.ccc-test-'));
};

// Executor fake that writes a file into the isolated dir, so the diff is non-empty.
const writingExecutor = async ({ cwd }) => {
  writeFileSync(join(cwd, 'new.txt'), 'content');
  return { changedFiles: ['new.txt'], lastMessage: 'wrote new.txt' };
};
const noopExecutor = async () => ({ changedFiles: [], lastMessage: 'nothing to do' });

test('correctness and intent findings are separately lifted while verdict is merged', async () => {
  const scr = scratch();
  const verifierCalls = [];
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'f1',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async (opts) => {
        verifierCalls.push(opts);
        return opts.prompt === INTENT_PROMPT
          ? { verdict: 'ISSUES', launchFailed: false,
              findings: 'The shared-scope requirement was dropped.', verdictSource: 'assistant' }
          : { verdict: 'NO_BLOCKERS', launchFailed: false,
              findings: 'The implementation is internally correct.', verdictSource: 'result' };
      },
    },
  });
  assert.equal(facts.verdict, 'ISSUES');
  assert.equal(facts.verifierFindings, 'The implementation is internally correct.');
  assert.equal(facts.verdictSource, 'result');
  assert.equal(facts.verifierPlan, null);
  assert.equal(facts.intentVerifierFindings, 'The shared-scope requirement was dropped.');
  assert.equal(facts.intentVerdict, 'ISSUES');
  assert.equal(facts.intentVerdictSource, 'assistant');
  assert.equal(facts.intentVerifierPlan, null);
  assert.equal(facts.baseRef, 'HEAD');
  assert.match(facts.baseCommit, /^[0-9a-f]{40,64}$/);
  assert.equal(facts.branch, 'ccc/f1');
  assert.deepEqual(verifierCalls.map((call) => call.prompt), [DEFAULT_PROMPT, INTENT_PROMPT]);
  rmSync(scr, { recursive: true, force: true });
});

test('executor retries accumulate usage and model overrides reach both agents and run facts', async () => {
  const scr = scratch();
  const executorCalls = [];
  const verifierCalls = [];
  let executorCall = 0;
  let gateCall = 0;
  const executorUsages = [
    { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2,
      reasoningOutputTokens: 1, cacheWriteTokens: 0 },
    { inputTokens: 20, cachedInputTokens: 10, outputTokens: 3,
      reasoningOutputTokens: 2, cacheWriteTokens: 1 },
  ];
  const correctnessUsage = { inputTokens: 7, cachedInputTokens: 4, outputTokens: 6,
    reasoningOutputTokens: 0, cacheWriteTokens: 2 };
  const intentUsage = { inputTokens: 11, cachedInputTokens: 5, outputTokens: 8,
    reasoningOutputTokens: 0, cacheWriteTokens: 3 };
  const cliOpts = parseArgs(['run', '--task', 'do the task', '--target', makeTarget(),
    '--gate', 'unused-gate.json', '--gate-retries', '1',
    '--executor-model', 'executor-override', '--executor-effort', 'medium',
    '--verifier-model', 'verifier-override']);
  const facts = await run({
    ...cliOpts, gate: [],
    scratchRoot: scr, runId: 'usage-models',
    adapters: {
      runExecutor: async (opts) => {
        executorCalls.push(opts);
        writeFileSync(join(opts.cwd, 'new.txt'), 'content');
        return { changedFiles: ['new.txt'], lastMessage: `attempt ${executorCall + 1}`,
          usage: executorUsages[executorCall++] };
      },
      runGate: async () => ({ passed: ++gateCall > 1, results: [] }),
      runVerifier: async (opts) => {
        verifierCalls.push(opts);
        return opts.prompt === INTENT_PROMPT
          ? { verdict: 'NO_BLOCKERS', launchFailed: false, findings: 'Intent is covered.',
              verdictSource: 'result', plan: '# Intent review\n\nNO_BLOCKERS', usage: intentUsage }
          : { verdict: 'ISSUES', launchFailed: false, findings: 'Found it.',
              verdictSource: 'plan', plan: '# Review\n\nISSUES', usage: correctnessUsage };
      },
    },
  });
  assert.equal(executorCalls.length, 2, 'initial execution plus one free retry');
  for (const call of executorCalls) {
    assert.equal(call.model, 'executor-override');
    assert.equal(call.effort, 'medium');
  }
  assert.equal(verifierCalls.length, 2);
  for (const call of verifierCalls) assert.equal(call.model, 'verifier-override');
  assert.deepEqual(verifierCalls.map((call) => call.prompt), [DEFAULT_PROMPT, INTENT_PROMPT]);
  assert.deepEqual(facts.model, {
    executor: 'executor-override', executorEffort: 'medium', verifier: 'verifier-override',
  });
  assert.deepEqual(facts.iterations[0].executorUsage, {
    inputTokens: 30, cachedInputTokens: 15, outputTokens: 5,
    reasoningOutputTokens: 3, cacheWriteTokens: 1,
  });
  assert.deepEqual(facts.tokens, {
    executor: { inputTokens: 30, cachedInputTokens: 15, outputTokens: 5,
      reasoningOutputTokens: 3, cacheWriteTokens: 1 },
    verifier: { inputTokens: 18, cachedInputTokens: 9, outputTokens: 14,
      reasoningOutputTokens: 0, cacheWriteTokens: 5 },
    total: { inputTokens: 48, cachedInputTokens: 24, outputTokens: 19,
      reasoningOutputTokens: 3, cacheWriteTokens: 6 },
  });
  assert.equal(facts.verdictSource, 'plan');
  assert.equal(facts.verifierPlan, '# Review\n\nISSUES');
  assert.equal(facts.intentVerifierFindings, 'Intent is covered.');
  assert.equal(facts.intentVerdict, 'NO_BLOCKERS');
  assert.equal(facts.intentVerdictSource, 'result');
  assert.equal(facts.intentVerifierPlan, '# Intent review\n\nNO_BLOCKERS');
  assert.equal(facts.gateFailure, null);
  rmSync(scr, { recursive: true, force: true });
});

test('a retained-evidence disagreement is reported without failing a completed run', async () => {
  const scr = scratch();
  const target = makeTarget();
  try {
    const contradictory = parseVerdictDetail(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: 'A blocking defect remains.\n\nISSUES',
    }));
    const clean = parseVerdictDetail(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: 'The intent is satisfied.\n\nNO_BLOCKERS',
    }));
    const facts = await run({
      task: 'do the task', target, gate: [], gateRetries: 0,
      scratchRoot: scr, runId: 'verdict-disagreement',
      adapters: {
        runExecutor: writingExecutor,
        runGate: async () => ({ passed: true, results: [] }),
        runVerifier: async ({ prompt }) => prompt === INTENT_PROMPT
          ? {
              verdict: clean.verdict,
              verdictSource: clean.source,
              verdictEvidence: clean.evidence,
              launchFailed: false,
            }
          : {
              // Simulate a harness bookkeeping defect: the recorded value does
              // not match the exact retained text, but verification completed.
              verdict: 'NO_BLOCKERS',
              verdictSource: contradictory.source,
              verdictEvidence: contradictory.evidence,
              launchFailed: false,
            },
      },
    });

    assert.equal(facts.outcome, 'review-ready', 'bookkeeping must not fail the run');
    assert.equal(facts.verifierConsistency.status, 'disagreement');
    assert.equal(facts.verifierConsistency.recordedVerdict, 'NO_BLOCKERS');
    assert.equal(facts.verifierConsistency.rederivedVerdict, 'ISSUES');
    const persisted = JSON.parse(readFileSync(join(facts.dir, 'ccc-runfacts.json'), 'utf8'));
    assert.equal(persisted.verifierConsistency.status, 'disagreement');
    assert.equal(persisted.iterations[0].verifier.verdictConsistency.status, 'disagreement');
    const report = readFileSync(join(facts.dir, 'ccc-report.md'), 'utf8');
    assert.match(report, /bookkeeping disagreement/i);
    assert.match(report, /recorded NO_BLOCKERS\/result; re-derived ISSUES\/result/i);
  } finally {
    rmSync(scr, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('omitted model flags travel through the CLI path to both agents and run-fact defaults', async () => {
  const scr = scratch();
  const executorCalls = [];
  const verifierCalls = [];
  const cliOpts = parseArgs(['run', '--task', 'do the task', '--target', makeTarget(),
    '--gate', 'unused-gate.json']);
  const facts = await run({
    ...cliOpts, gate: [], scratchRoot: scr, runId: 'default-models',
    adapters: {
      runExecutor: async (opts) => {
        executorCalls.push(opts);
        return writingExecutor(opts);
      },
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async (opts) => {
        verifierCalls.push(opts);
        return { verdict: 'NO_BLOCKERS', launchFailed: false };
      },
    },
  });

  assert.equal(executorCalls[0].model, DEFAULT_EXECUTOR_MODEL);
  assert.equal(executorCalls[0].effort, DEFAULT_EXECUTOR_EFFORT);
  assert.deepEqual(verifierCalls.map((call) => call.model),
    [DEFAULT_VERIFIER_MODEL, DEFAULT_VERIFIER_MODEL]);
  assert.deepEqual(facts.model, {
    executor: DEFAULT_EXECUTOR_MODEL,
    executorEffort: DEFAULT_EXECUTOR_EFFORT,
    verifier: DEFAULT_VERIFIER_MODEL,
  });
  rmSync(scr, { recursive: true, force: true });
});

test('TASK.md is written before execution, excluded from the diff, and both verifiers launch', async () => {
  let launches = 0;
  const scr = scratch();
  const plan = 'Implement the exact requested behavior.\nDo not narrow shared scope.\n';
  const target = makeTarget();
  const facts = await run({
    task: plan, target, gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'g1',
    adapters: {
      runExecutor: async ({ cwd }) => {
        assert.equal(readFileSync(join(cwd, 'TASK.md'), 'utf8'), plan,
          'executor must receive an isolated checkout containing the resolved task');
        return writingExecutor({ cwd });
      },
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => { launches++; return { verdict: 'NO_BLOCKERS', launchFailed: false }; },
    },
  });
  assert.equal(facts.outcome, 'review-ready');
  assert.equal(launches, 2);
  assert.ok(existsSync(join(facts.dir, 'CHANGES.diff')), 'CHANGES.diff handed to verifier');
  const diff = readFileSync(join(facts.dir, 'CHANGES.diff'), 'utf8');
  assert.match(diff, /new[.]txt/);
  assert.doesNotMatch(diff, /TASK[.]md/);
  assert.equal(existsSync(join(target, 'TASK.md')), false, 'the target must remain untouched');
  rmSync(scr, { recursive: true, force: true });
});

test('run reads an existing .txt task file instead of executing its path string', async () => {
  const scr = scratch();
  const taskDir = mkdtempSync(join(tmpdir(), 'run-task-'));
  const taskPath = join(taskDir, 'plan.txt');
  const plan = 'Use the contents of the text task file.\n';
  writeFileSync(taskPath, plan);
  const facts = await run({
    task: taskPath, target: makeTarget(), gate: [], gateRetries: 0,
    scratchRoot: scr, runId: 'txt-task',
    adapters: {
      runExecutor: async ({ cwd, plan: received }) => {
        assert.equal(received, plan, 'the executor must receive file contents, not the .txt path');
        assert.equal(readFileSync(join(cwd, 'TASK.md'), 'utf8'), plan);
        return noopExecutor();
      },
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => { throw new Error('no-op must not launch a verifier'); },
    },
  });
  assert.equal(facts.outcome, 'no-op');
  rmSync(taskDir, { recursive: true, force: true });
  rmSync(scr, { recursive: true, force: true });
});

test('first executor call gets the verbatim plan and a retry gets the preceding gate failure', async () => {
  const scr = scratch();
  const plan = 'Implement the requested behavior exactly.\nKeep the original plan unchanged.\n';
  const executorPlans = [];
  let gateCall = 0;
  const failure = {
    bin: 'node', args: ['--test', 'test/repair.test.js'], code: 7,
    outputTail: '[stdout]\nrepair test failed\n[stderr]\nexpected true but received false',
  };
  const facts = await run({
    task: plan, target: makeTarget(), gate: [], gateRetries: 1,
    scratchRoot: scr, runId: 'retry-context',
    adapters: {
      runExecutor: async (opts) => {
        executorPlans.push(opts.plan);
        return writingExecutor(opts);
      },
      runGate: async () => gateCall++ === 0
        ? { passed: false, results: [failure] }
        : { passed: true, results: [] },
      runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
    },
  });

  assert.equal(facts.gateStatus, 'passed');
  assert.equal(executorPlans.length, 2);
  assert.equal(executorPlans[0], plan, 'the initial executor prompt must be the plan verbatim');
  assert.ok(executorPlans[1].startsWith(plan), 'retry context must be appended to the original plan');
  assert.match(executorPlans[1], /Previous gate attempt failed/);
  assert.match(executorPlans[1], /"bin":"node"/);
  assert.match(executorPlans[1], /"--test","test\/repair[.]test[.]js"/);
  assert.match(executorPlans[1], /Exit code: 7/);
  assert.ok(executorPlans[1].includes(failure.outputTail));
  assert.equal(readFileSync(join(facts.dir, 'TASK.md'), 'utf8'), plan,
    'TASK.md must retain only the original plan');
  rmSync(scr, { recursive: true, force: true });
});

test('each retry receives only the immediately preceding distinguishable gate failure', async () => {
  const scr = scratch();
  const plan = 'Repair the implementation.';
  const executorPlans = [];
  const firstFailure = {
    bin: 'node', args: ['--test', 'test/first.test.js'], code: 11,
    outputTail: '[stdout]\nFIRST_FAILURE_ONLY\n[stderr]\nfirst stack',
  };
  const secondFailure = {
    bin: 'npm', args: ['run', 'second-check'], code: 22,
    outputTail: '[stdout]\nSECOND_FAILURE_ONLY\n[stderr]\nsecond stack',
  };
  const gateResults = [
    { passed: false, results: [firstFailure] },
    { passed: false, results: [secondFailure] },
    { passed: true, results: [] },
  ];
  const facts = await run({
    task: plan, target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'fresh-retry-context',
    adapters: {
      runExecutor: async (opts) => {
        executorPlans.push(opts.plan);
        return writingExecutor(opts);
      },
      runGate: async () => gateResults.shift(),
      runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
    },
  });

  assert.equal(facts.gateStatus, 'passed');
  assert.equal(executorPlans.length, 3);
  assert.equal(executorPlans[0], plan);
  assert.ok(executorPlans[1].includes('FIRST_FAILURE_ONLY'));
  assert.ok(!executorPlans[1].includes('SECOND_FAILURE_ONLY'));
  assert.match(executorPlans[1], /Exit code: 11/);
  assert.ok(executorPlans[2].includes('SECOND_FAILURE_ONLY'));
  assert.ok(!executorPlans[2].includes('FIRST_FAILURE_ONLY'),
    'the second retry must not accumulate the first failure');
  assert.match(executorPlans[2], /"bin":"npm"/);
  assert.match(executorPlans[2], /Exit code: 22/);
  rmSync(scr, { recursive: true, force: true });
});

test('a green first gate never augments the executor prompt', async () => {
  const scr = scratch();
  const plan = 'Make one focused change.\n';
  const executorPlans = [];
  const facts = await run({
    task: plan, target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'green-no-retry-context',
    adapters: {
      runExecutor: async (opts) => {
        executorPlans.push(opts.plan);
        return writingExecutor(opts);
      },
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => ({ verdict: 'NO_BLOCKERS', launchFailed: false }),
    },
  });

  assert.equal(facts.gateStatus, 'passed');
  assert.deepEqual(executorPlans, [plan]);
  assert.doesNotMatch(executorPlans[0], /Previous gate attempt failed/);
  rmSync(scr, { recursive: true, force: true });
});

test('correctness-pass launch failure yields verifier-failed and intent still runs', async () => {
  const scr = scratch();
  const verifier = { verdict: 'ISSUES', exitCode: 1, launchFailed: true, stderr: 'launch failed' };
  const intentVerifier = { verdict: 'NO_BLOCKERS', exitCode: 0, launchFailed: false };
  let calls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'vf1',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => calls++ === 0 ? verifier : intentVerifier,
    },
  });
  assert.equal(facts.outcome, 'verifier-failed');
  assert.deepEqual(facts.iterations[0].verifier, verifier);
  assert.deepEqual(facts.iterations[0].intentVerifier, intentVerifier);
  assert.equal(calls, 2, 'intent audit must still run after a correctness launch failure');
  rmSync(scr, { recursive: true, force: true });
});

test('intent-pass launch failure yields verifier-failed', async () => {
  const scr = scratch();
  const verifier = { verdict: 'NO_BLOCKERS', exitCode: 0, launchFailed: false };
  const intentVerifier = { verdict: 'ISSUES', exitCode: 1, launchFailed: true,
    stderr: 'intent launch failed' };
  let calls = 0;
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'vf2',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => calls++ === 0 ? verifier : intentVerifier,
    },
  });
  assert.equal(facts.outcome, 'verifier-failed');
  assert.deepEqual(facts.iterations[0].verifier, verifier);
  assert.deepEqual(facts.iterations[0].intentVerifier, intentVerifier);
  rmSync(scr, { recursive: true, force: true });
});

test('empty diff → verifier is NOT launched (no-op)', async () => {
  let launches = 0;
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'e1',
    adapters: {
      runExecutor: noopExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => { launches++; return { verdict: 'NO_BLOCKERS' }; },
    },
  });
  assert.equal(launches, 0, 'no diff means nothing to review');
  assert.equal(facts.outcome, 'no-op');
  assert.equal(readFileSync(join(facts.dir, 'TASK.md'), 'utf8'), 'do the task');
  assert.equal(await diffText(facts.dir), '',
    'TASK.md and generated report artifacts must not turn a no-op into a change');
  rmSync(scr, { recursive: true, force: true });
});

test('red gate exhausts retries → gate-failed, verifier never launched', async () => {
  let gateCalls = 0, launches = 0;
  const scr = scratch();
  const facts = await run({
    task: 'do the task', target: makeTarget(), gate: [], gateRetries: 2,
    scratchRoot: scr, runId: 'r1',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => { gateCalls++; return { passed: false, results: [{
        bin: 'node', args: ['--test'], code: 1,
        outputTail: '[stdout]\nfailed assertion\n[stderr]\nstack trace',
      }] }; },
      runVerifier: async () => { launches++; return { verdict: 'NO_BLOCKERS' }; },
    },
  });
  assert.equal(facts.gateStatus, 'failed');
  assert.equal(facts.outcome, 'gate-failed');
  assert.equal(launches, 0);
  assert.equal(gateCalls, 3, '1 initial + 2 free retries');
  assert.deepEqual(facts.gateFailure, {
    bin: 'node', args: ['--test'], code: 1,
    outputTail: '[stdout]\nfailed assertion\n[stderr]\nstack trace',
  });
  assert.deepEqual(facts.tokens.executor, EMPTY_USAGE);
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out executor stops the run, is recorded, and maps to a non-zero process exit', async () => {
  const scr = scratch();
  let gateCalls = 0;
  let verifierCalls = 0;
  const facts = await run({
    task: 'Implement the requested timeout behavior.', target: makeTarget(), gate: [],
    gateRetries: 2, scratchRoot: scr, runId: 'executor-timeout',
    adapters: {
      runExecutor: async () => ({ changedFiles: [], lastMessage: 'partial work',
        timedOut: true, timeoutMs: 25, exitCode: -1 }),
      runGate: async () => { gateCalls++; return { passed: true, results: [] }; },
      runVerifier: async () => { verifierCalls++; return { verdict: 'NO_BLOCKERS' }; },
    },
  });
  assert.equal(facts.outcome, 'timed-out');
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  assert.equal(gateCalls, 0, 'a timed-out executor must not advance to the gate');
  assert.equal(verifierCalls, 0);
  assert.equal(facts.iterations[0].executor.timedOut, true);
  assert.deepEqual(facts.timeoutEvents, [
    { stage: 'executor', iteration: 1, attempt: 1, timeoutMs: 25 },
  ]);
  assert.match(readFileSync(join(facts.dir, 'ccc-report.md'), 'utf8'),
    /executor: timed out after 25 ms/i);
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out verifier cannot produce a successful outcome', async () => {
  const scr = scratch();
  let calls = 0;
  const facts = await run({
    task: 'Implement the requested timeout behavior.', target: makeTarget(), gate: [],
    gateRetries: 0, scratchRoot: scr, runId: 'verifier-timeout',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: true, results: [] }),
      runVerifier: async () => ++calls === 1
        ? { verdict: 'NO_BLOCKERS', launchFailed: false, timedOut: true, timeoutMs: 40 }
        : { verdict: 'NO_BLOCKERS', launchFailed: false, timedOut: false },
    },
  });
  assert.equal(facts.outcome, 'timed-out');
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  assert.deepEqual(facts.timeoutEvents, [
    { stage: 'verifier', pass: 'correctness', iteration: 1, timeoutMs: 40 },
  ]);
  rmSync(scr, { recursive: true, force: true });
});

test('a timed-out gate command is distinguishable in run facts and the report', async () => {
  const scr = scratch();
  let verifierCalls = 0;
  const facts = await run({
    task: 'Implement the requested timeout behavior.', target: makeTarget(), gate: [],
    gateRetries: 0, scratchRoot: scr, runId: 'gate-timeout',
    adapters: {
      runExecutor: writingExecutor,
      runGate: async () => ({ passed: false, results: [{
        bin: 'node', args: ['--test'], code: -1, timedOut: true, timeoutMs: 60,
        outputTail: '[stdout]\npartial test output\n[stderr]\n',
      }] }),
      runVerifier: async () => { verifierCalls++; return { verdict: 'NO_BLOCKERS' }; },
    },
  });
  assert.equal(facts.outcome, 'timed-out');
  assert.notEqual(exitCodeFor(facts.outcome), 0);
  assert.equal(verifierCalls, 0);
  assert.deepEqual(facts.timeoutEvents, [{
    stage: 'gate', iteration: 1, attempt: 1, timeoutMs: 60,
    bin: 'node', args: ['--test'],
  }]);
  assert.equal(facts.gateFailure.timedOut, true);
  const report = readFileSync(join(facts.dir, 'ccc-report.md'), 'utf8');
  assert.match(report, /Gate failure/);
  assert.match(report, /Timed out.*60 ms/i);
  rmSync(scr, { recursive: true, force: true });
});

test('diffText throws when git fails (non-git dir)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'nogit-'));
  await assert.rejects(() => diffText(d), /git (add|diff) failed/);
});

test('diffText excludes every harness artifact with real git pathspecs', async () => {
  const d = makeTarget();
  await spawnCapture('git', ['-C', d, 'init', '-b', 'main']);
  await spawnCapture('git', ['-C', d, 'add', '-A']);
  await spawnCapture('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-m', 'baseline']);
  writeFileSync(join(d, 'feature.js'), 'export const enabled = true;\n');
  for (const artifact of ['TASK.md', 'CHANGES.diff', 'ccc-report.md', 'ccc-runfacts.json']) {
    writeFileSync(join(d, artifact), `harness-only ${artifact}\n`);
  }
  const diff = await diffText(d);
  assert.match(diff, /feature[.]js/);
  for (const artifact of ['TASK.md', 'CHANGES.diff', 'ccc-report.md', 'ccc-runfacts.json']) {
    assert.doesNotMatch(diff, new RegExp(artifact.replace('.', '[.]')));
  }
  rmSync(d, { recursive: true, force: true });
});

test('mergeVerifierVerdicts is fail-safe across both passes', () => {
  assert.equal(mergeVerifierVerdicts('NO_BLOCKERS', 'NO_BLOCKERS'), 'NO_BLOCKERS');
  assert.equal(mergeVerifierVerdicts('NO_BLOCKERS', 'ISSUES'), 'ISSUES');
  assert.equal(mergeVerifierVerdicts('ISSUES', 'NO_BLOCKERS'), 'ISSUES');
});
