import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunFacts, writeReport } from '../src/report.js';
import {
  deriveVerdictFromEvidence,
  FINDINGS_LIMIT,
  parseVerdictDetail,
  PLAN_LIMIT,
} from '../src/verifier.js';

function event(value) {
  return JSON.stringify(value);
}

function assistant(text) {
  return event({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function result(text) {
  return event({ type: 'result', subtype: 'success', is_error: false, result: text });
}

function plan({ name = '', overview = '', plan = '' }) {
  return event({
    type: 'tool_call', subtype: 'completed',
    tool_call: { createPlanToolCall: { args: { name, overview, plan } } },
  });
}

test('written run facts reproduce every verdict source from byte-identical retained evidence', () => {
  const resultText = 'Result reasoning with a snowman \u2603.\n\nNO_BLOCKERS';
  const assistantText = 'Assistant found a blocking defect.\n\nISSUES';
  const composedPlanText = '# Audit plan\n\n**NO_BLOCKERS** — no correctness defects\n\nNo verdict token appears in args.plan.';
  const cases = [
    {
      source: 'result',
      expectedJudgedText: resultText,
      detail: parseVerdictDetail([
        assistant('Losing assistant.\n\nISSUES'),
        plan({ name: 'Losing plan', plan: 'ISSUES' }),
        result(resultText),
      ].join('\n')),
    },
    {
      source: 'assistant',
      expectedJudgedText: assistantText,
      detail: parseVerdictDetail([
        plan({ name: 'Losing plan', plan: 'NO_BLOCKERS' }),
        assistant(assistantText),
        result('An inconclusive result preamble.'),
      ].join('\n')),
    },
    {
      source: 'plan',
      expectedJudgedText: composedPlanText,
      detail: parseVerdictDetail([
        assistant('Review saved to plan.'),
        plan({
          name: 'Audit plan',
          overview: '**NO_BLOCKERS** — no correctness defects',
          plan: 'No verdict token appears in args.plan.',
        }),
        result('Review saved to plan.'),
      ].join('\n')),
    },
    {
      source: 'none',
      expectedJudgedText: '# Inconclusive plan\n\nNo final marker.',
      detail: parseVerdictDetail([
        assistant('Assistant remained inconclusive.'),
        plan({ name: 'Inconclusive plan', plan: 'No final marker.' }),
        result('Result remained inconclusive.'),
      ].join('\n')),
    },
  ];

  const dir = mkdtempSync(join(tmpdir(), 'ccc-verdict-evidence-'));
  try {
    const iterations = cases.map(({ detail }, index) => ({
      n: index + 1,
      changedFiles: [],
      lastMessage: 'fixture',
      verifier: {
        verdict: detail.verdict,
        verdictSource: detail.source,
        verdictEvidence: detail.evidence,
      },
      intentVerifier: null,
    }));
    const facts = buildRunFacts({
      runId: 'round-trip', target: dir, dir, isRepo: false, branch: 'ccc/round-trip',
      iterations, gateStatus: 'passed', verdict: 'ISSUES', outcome: 'review-ready',
      gateRetries: 0,
    });
    const { jsonPath } = writeReport({ dir, facts });

    // This is intentionally reloaded from the artifact. Re-deriving from the
    // in-memory parse result would not prove that uro-runfacts.json is sufficient.
    const persisted = JSON.parse(readFileSync(jsonPath, 'utf8'));
    for (const [index, expected] of cases.entries()) {
      const recorded = persisted.iterations[index].verifier;
      const replay = deriveVerdictFromEvidence(recorded.verdictEvidence);
      assert.equal(recorded.verdictSource, expected.source);
      assert.equal(replay.source, recorded.verdictSource);
      assert.equal(replay.verdict, recorded.verdict);
      assert.deepEqual(
        Buffer.from(recorded.verdictEvidence.judgedText, 'utf8'),
        Buffer.from(expected.expectedJudgedText, 'utf8'),
        `${expected.source} judged text must be byte-identical after persistence`,
      );
      const judgedCandidate = expected.source === 'none' ? 'plan' : expected.source;
      assert.equal(
        recorded.verdictEvidence.judgedText,
        recorded.verdictEvidence.candidates[judgedCandidate].text,
        `${expected.source} must retain the exact final candidate passed to its rule`,
      );
    }

    const persistedPlan = persisted.iterations[2].verifier;
    assert.equal(persistedPlan.verdict, 'NO_BLOCKERS');
    assert.doesNotMatch(
      persistedPlan.verdictEvidence.candidates.plan.text.split('\n').at(-1),
      /NO_BLOCKERS|ISSUES/,
      'the args.plan body deliberately contains no verdict token',
    );
    assert.equal(
      deriveVerdictFromEvidence(persistedPlan.verdictEvidence).verdict,
      persistedPlan.verdict,
      'name/overview tokens and the retained composed plan must never diverge',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('truncation is explicit and replay uses the exact bounded text that was judged', () => {
  const rawPlan = `${'x'.repeat(PLAN_LIMIT + 40)}\n\nNO_BLOCKERS`;
  const detail = parseVerdictDetail([
    assistant('a'.repeat(FINDINGS_LIMIT + 10)),
    plan({ name: 'Long plan', plan: rawPlan }),
    result('r'.repeat(FINDINGS_LIMIT + 20)),
  ].join('\n'));
  assert.equal(detail.source, 'plan');
  assert.equal(detail.verdict, 'NO_BLOCKERS');
  assert.equal(detail.evidence.inputTruncated, true);
  assert.equal(detail.evidence.judgedTextTruncated, true);
  assert.equal(detail.evidence.candidates.plan.truncated, true);
  assert.equal(detail.evidence.candidates.plan.text.length, PLAN_LIMIT);
  assert.equal(detail.evidence.candidates.result.truncated, true);
  assert.equal(detail.evidence.candidates.result.text.length, FINDINGS_LIMIT);
  assert.equal(detail.evidence.candidates.assistant.truncated, true);
  assert.equal(detail.evidence.candidates.assistant.text.length, FINDINGS_LIMIT);
  assert.equal(detail.evidence.judgedText, detail.evidence.candidates.plan.text);
  assert.deepEqual(deriveVerdictFromEvidence(detail.evidence), {
    verdict: detail.verdict,
    source: detail.source,
    judgedText: detail.evidence.judgedText,
    judgedTextTruncated: true,
  });
});
