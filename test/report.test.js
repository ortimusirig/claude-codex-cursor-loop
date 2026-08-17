import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunFacts, writeReport } from '../src/report.js';
import { DEFAULT_EXECUTOR_EFFORT, DEFAULT_EXECUTOR_MODEL } from '../src/executor.js';
import { DEFAULT_VERIFIER_MODEL } from '../src/verifier.js';
import { EMPTY_USAGE } from '../src/usage.js';

const facts = buildRunFacts({
  runId: 'r1', target: 'C:/proj', dir: 'C:/ccc/w', isRepo: false, branch: 'ccc/r1',
  iterations: [{ n: 1, changedFiles: ['a.py'], lastMessage: 'did it',
    gate: { passed: true, results: [] }, verifier: { verdict: 'NO_BLOCKERS' } }],
  gateStatus: 'passed', verdict: 'NO_BLOCKERS', outcome: 'review-ready',
  gateRetries: 2,
});

test('buildRunFacts records pins and outcome', () => {
  assert.equal(facts.model.executor, DEFAULT_EXECUTOR_MODEL);
  assert.equal(facts.model.executorEffort, DEFAULT_EXECUTOR_EFFORT);
  assert.equal(facts.model.verifier, DEFAULT_VERIFIER_MODEL);
  assert.equal(facts.outcome, 'review-ready');
  assert.equal(facts.iterations[0].changedFiles[0], 'a.py');
  assert.equal(Object.hasOwn(facts.limits, 'maxIterations'), false);
  assert.equal(facts.limits.gateRetries, 2);
  assert.deepEqual(facts.limits.timeoutsMs, { executor: null, verifier: null, gate: null });
  assert.deepEqual(facts.timeoutEvents, []);
});

test('buildRunFacts records model overrides actually used for a run', () => {
  const overridden = buildRunFacts({
    runId: 'models', target: 'C:/proj', dir: 'C:/ccc/w', isRepo: false, branch: 'ccc/models',
    iterations: [], gateStatus: 'passed', verdict: null, outcome: 'no-op',
    gateRetries: 0,
    models: { executor: 'executor-override', executorEffort: 'medium', verifier: 'verifier-override' },
  });
  assert.deepEqual(overridden.model, {
    executor: 'executor-override',
    executorEffort: 'medium',
    verifier: 'verifier-override',
  });
});

test('writeReport emits json and markdown', () => {
  const d = mkdtempSync(join(tmpdir(), 'rep-'));
  const { jsonPath, mdPath } = writeReport({ dir: d, facts });
  const persisted = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert.equal(persisted.runId, 'r1');
  assert.equal(Object.hasOwn(persisted.limits, 'maxIterations'), false);
  assert.equal(persisted.limits.gateRetries, 2);
  assert.match(readFileSync(mdPath, 'utf8'), /review-ready/);
});

test('verifier findings reach both the facts and the markdown report', () => {
  const withFindings = buildRunFacts({
    runId: 'r2', target: 'C:/proj', dir: 'C:/ccc/w', isRepo: false, branch: 'ccc/r2',
    iterations: [{ n: 1, changedFiles: ['a.py'], lastMessage: 'did it',
      gate: { passed: true, results: [] },
      verifier: { verdict: 'ISSUES', findings: 'Line 4 drops the error.' } }],
    gateStatus: 'passed', verdict: 'ISSUES',
    verifierFindings: 'Line 4 drops the error.',
    intentVerifierFindings: 'The task required shared scope.',
    intentVerdict: 'ISSUES', intentVerdictSource: 'assistant',
    intentVerifierPlan: '# Intent audit\n\nISSUES',
    outcome: 'review-ready', gateRetries: 2,
  });
  assert.equal(withFindings.verifierFindings, 'Line 4 drops the error.');
  assert.equal(withFindings.intentVerifierFindings, 'The task required shared scope.');
  assert.equal(withFindings.intentVerdict, 'ISSUES');
  assert.equal(withFindings.intentVerdictSource, 'assistant');
  assert.equal(withFindings.intentVerifierPlan, '# Intent audit\n\nISSUES');

  const d = mkdtempSync(join(tmpdir(), 'rep2-'));
  const { mdPath } = writeReport({ dir: d, facts: withFindings });
  const md = readFileSync(mdPath, 'utf8');
  assert.match(md, /## Verifier findings/);
  assert.match(md, /Line 4 drops the error/);
  assert.match(md, /## Intent verifier findings/);
  assert.match(md, /The task required shared scope/);
  assert.match(md, /## Intent verifier plan artifact/);
});

test('facts carry an explicit null when no findings were recorded', () => {
  assert.equal(facts.verifierFindings, null);
  assert.equal(facts.verdictSource, null);
  assert.equal(facts.correctnessVerdict, null);
  assert.equal(facts.correctnessVerdictSource, null);
  assert.equal(facts.verifierPlan, null);
  assert.equal(facts.intentVerifierFindings, null);
  assert.equal(facts.intentVerdict, null);
  assert.equal(facts.intentVerdictSource, null);
  assert.equal(facts.intentVerifierPlan, null);
  assert.equal(facts.gateFailure, null);
  assert.deepEqual(facts.tokens, {
    executor: EMPTY_USAGE,
    verifier: EMPTY_USAGE,
    total: EMPTY_USAGE,
  });
});

test('writeReport emits retained diagnostics, verdict provenance, fail-safe wording, and tokens', () => {
  const diagnosticFacts = buildRunFacts({
    runId: 'diag', target: 'C:/proj', dir: 'C:/ccc/w', isRepo: false, branch: 'ccc/diag',
    iterations: [{ n: 1, changedFiles: ['broken.js'], lastMessage: 'attempted fix',
      gate: { passed: false, results: [] }, verifier: null }],
    gateStatus: 'failed', verdict: 'ISSUES', verdictSource: 'none',
    verifierFindings: 'Verifier preamble only.',
    verifierPlan: '# Diff review\n\nThe assertion misses the defect.\n\nISSUES',
    intentVerifierFindings: 'Intent verifier preamble only.',
    intentVerdict: 'ISSUES', intentVerdictSource: 'none',
    intentVerifierPlan: '# Intent review\n\nShared scope was omitted.\n\nISSUES',
    gateFailure: {
      bin: 'node', args: ['--test'], code: 1,
      outputTail: '[stdout]\nFAIL specific assertion\n[stderr]\nstack detail',
    },
    tokens: {
      executor: { inputTokens: 11, cachedInputTokens: 7, outputTokens: 5,
        reasoningOutputTokens: 3, cacheWriteTokens: 2 },
      verifier: { inputTokens: 13, cachedInputTokens: 9, outputTokens: 6,
        reasoningOutputTokens: 0, cacheWriteTokens: 4 },
      total: { inputTokens: 24, cachedInputTokens: 16, outputTokens: 11,
        reasoningOutputTokens: 3, cacheWriteTokens: 6 },
    },
    outcome: 'gate-failed', gateRetries: 0,
  });
  const d = mkdtempSync(join(tmpdir(), 'rep-diag-'));
  const { mdPath } = writeReport({ dir: d, facts: diagnosticFacts });
  const md = readFileSync(mdPath, 'utf8');
  assert.match(md, /\*\*Verdict:\*\* ISSUES \(source: none\)/);
  assert.match(md, /no verdict marker was found/i);
  assert.match(md, /ISSUES is the fail-safe default/i);
  assert.match(md, /Correctness verifier: no verdict marker was found/i);
  assert.match(md, /Intent verifier: no verdict marker was found/i);
  assert.match(md, /## Verifier plan artifact/);
  assert.match(md, /The assertion misses the defect/);
  assert.match(md, /## Intent verifier findings/);
  assert.match(md, /Intent verifier preamble only/);
  assert.match(md, /## Intent verifier plan artifact/);
  assert.match(md, /Shared scope was omitted/);
  assert.match(md, /## Gate failure/);
  assert.match(md, /node --test/);
  assert.match(md, /exit code:.*1/i);
  assert.match(md, /FAIL specific assertion/);
  assert.match(md, /stack detail/);
  assert.match(md, /## Tokens/);
  assert.match(md, /Executor.*input: 11/i);
  assert.match(md, /Verifier.*input: 13/i);
  assert.match(md, /Total.*input: 24/i);
});

test('writeReport omits optional plan and gate sections when facts contain null', () => {
  const d = mkdtempSync(join(tmpdir(), 'rep-min-'));
  const { mdPath } = writeReport({ dir: d, facts });
  const md = readFileSync(mdPath, 'utf8');
  assert.doesNotMatch(md, /## Verifier plan artifact/);
  assert.doesNotMatch(md, /## Intent verifier plan artifact/);
  assert.doesNotMatch(md, /## Gate failure/);
  assert.match(md, /## Tokens/);
});

test('configured timeouts and timeout events reach facts and markdown', () => {
  const timedOut = buildRunFacts({
    runId: 'timeout', target: 'C:/proj', dir: 'C:/ccc/w', isRepo: false,
    branch: 'ccc/timeout', iterations: [], gateStatus: 'not-run', verdict: null,
    outcome: 'timed-out', gateRetries: 0,
    timeouts: { executor: 100, verifier: 200, gate: 300 },
    timeoutEvents: [{ stage: 'executor', iteration: 1, attempt: 1, timeoutMs: 100 }],
  });
  assert.deepEqual(timedOut.limits.timeoutsMs, { executor: 100, verifier: 200, gate: 300 });
  assert.equal(timedOut.timeoutEvents[0].stage, 'executor');
  const d = mkdtempSync(join(tmpdir(), 'rep-timeout-'));
  const { mdPath } = writeReport({ dir: d, facts: timedOut });
  const md = readFileSync(mdPath, 'utf8');
  assert.match(md, /Timeouts \(ms\).*executor 100.*verifier 200.*gate 300/i);
  assert.match(md, /executor: timed out after 100 ms/i);
});
