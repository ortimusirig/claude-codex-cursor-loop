import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertNoForbiddenFlags,
  assertUsablePrompt,
  buildCursorArgs,
  DEFAULT_PROMPT,
  DEFAULT_VERIFIER_MODEL,
  extractPlanArtifact,
  hasVerdictEvidence,
  parseVerdict,
  parseVerdictDetail,
  runVerifier,
  FINDINGS_LIMIT,
  INTENT_PROMPT,
  PLAN_LIMIT,
} from '../src/verifier.js';
import { EMPTY_USAGE } from '../src/usage.js';

const fakeAgent = fileURLToPath(new URL('../fixtures/fake-agent.mjs', import.meta.url));
const brokenFakeAgent = fileURLToPath(new URL('../fixtures/fake-agent-broken.mjs', import.meta.url));
const realSamplePath = fileURLToPath(new URL('../fixtures/cursor-stream-schema-sample.ndjson', import.meta.url));
const planSamplePath = fileURLToPath(new URL('../fixtures/cursor-plan-mode-sample.ndjson', import.meta.url));

function rewriteEvents(streamText, rewrite) {
  return streamText.trim().split(/\r?\n/)
    .map((line) => JSON.stringify(rewrite(JSON.parse(line))))
    .join('\n');
}

test('parseVerdictDetail keeps the review text, not just the verdict', () => {
  const stream = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'Line 4 drops the error.\n\nISSUES',
  }) + '\n';
  const { verdict, text, source, planText } = parseVerdictDetail(stream);
  assert.equal(verdict, 'ISSUES');
  assert.match(text, /Line 4 drops the error/);
  assert.equal(source, 'result');
  assert.equal(planText, '');
});

test('parseVerdict still returns a bare verdict string', () => {
  assert.equal(typeof parseVerdict('{"type":"result","result":"NO_BLOCKERS"}'), 'string');
});

test('runVerifier reports findings on the path where the verifier ran', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath, extraArgv: [fakeAgent] });
  assert.equal(r.verdict, 'ISSUES');
  assert.equal(r.launchFailed, false);
  assert.equal(r.verdictSource, 'result');
  // The reasoning must survive: a verdict alone is not actionable.
  assert.match(r.findings, /a bug on line 4/);
  assert.match(r.plan, /Fake review plan/);
  assert.match(r.plan, /Retained review details/);
  assert.deepEqual(r.usage, {
    inputTokens: 10,
    cachedInputTokens: 3,
    outputTokens: 4,
    reasoningOutputTokens: 0,
    cacheWriteTokens: 2,
  });
});

test('runVerifier findings are capped', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath, extraArgv: [fakeAgent] });
  assert.ok(r.findings.length <= FINDINGS_LIMIT);
});

test('runVerifier plan artifacts are capped separately from findings', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    extraArgv: [fakeAgent, 'long-plan'] });
  assert.ok(r.plan.length <= PLAN_LIMIT);
  assert.match(r.findings, /a bug on line 4/);
});

test('intent-pass plan artifacts use the same cap', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    prompt: INTENT_PROMPT, extraArgv: [fakeAgent, 'long-plan'] });
  assert.ok(r.plan.length <= PLAN_LIMIT);
  assert.match(r.findings, /a bug on line 4/);
});

test('a failed launch reports stderr and carries no findings', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath, extraArgv: [brokenFakeAgent] });
  assert.equal(r.launchFailed, true);
  assert.equal(r.findings, undefined);
  assert.equal(r.verdictSource, 'none');
  assert.deepEqual(r.usage, EMPTY_USAGE);
});

test('assertUsablePrompt accepts a usable prompt', () => {
  assert.doesNotThrow(() => assertUsablePrompt('review the diff'));
});

test('intent prompt is usable, asks both audit questions, and stays read-only', () => {
  assert.doesNotThrow(() => assertUsablePrompt(INTENT_PROMPT));
  assert.match(INTENT_PROMPT, /everything TASK[.]md asked/);
  assert.match(INTENT_PROMPT, /would that assertion still pass if the feature under test were broken/);
  assert.doesNotMatch(INTENT_PROMPT, /["\r\n]/);
  const args = buildCursorArgs({ prompt: INTENT_PROMPT });
  assertNoForbiddenFlags(args);
  assert.equal(args[args.indexOf('--mode') + 1], 'plan');
  assert.ok(args.includes('--trust'));
});

test('assertUsablePrompt rejects double quotes', () => {
  assert.throws(() => assertUsablePrompt('say "hi"'), /double quote/);
});

test('assertUsablePrompt rejects newlines', () => {
  assert.throws(() => assertUsablePrompt('line one\nline two'), /single line/);
});

test('assertUsablePrompt rejects an empty prompt', () => {
  assert.throws(() => assertUsablePrompt('   '), /empty/);
});

test('buildCursorArgs uses read-only plan mode, trust, and the pinned model', () => {
  assert.match(DEFAULT_VERIFIER_MODEL, /^cursor-grok-4[.]5-high$/);
  const a = buildCursorArgs({}).join(' ');
  assert.match(a, /--mode plan/);
  assert.match(a, /--output-format stream-json/);
  assert.match(a, /--trust/, 'must clear the workspace-trust gate or every review fails to ISSUES');
  assert.match(a, new RegExp(DEFAULT_VERIFIER_MODEL.replaceAll('.', '\\.')));
});

test('buildCursorArgs accepts an explicit model override', () => {
  const a = buildCursorArgs({ model: 'verifier-override' });
  assert.equal(a[a.indexOf('--model') + 1], 'verifier-override');
});

test('forbidden write flags never appear', () => {
  assert.doesNotMatch(buildCursorArgs({}).join(' '), /--force|--yolo|(^| )-f( |$)|--approve-mcps/);
});

test('buildCursorArgs rejects a quote-bearing prompt', () => {
  assert.throws(() => buildCursorArgs({ prompt: 'has "quotes"' }), /double quote/);
});

test('assertNoForbiddenFlags throws on a write flag', () => {
  assert.throws(() => assertNoForbiddenFlags(['-p', '--force']), /force/);
});

test('runVerifier rejects forbidden flags for correctness and intent launches', async () => {
  for (const prompt of [DEFAULT_PROMPT, INTENT_PROMPT]) {
    await assert.rejects(
      () => runVerifier({ cwd: process.cwd(), prompt, extraArgv: ['--approve-mcps'] }),
      /forbidden verifier flag/,
    );
  }
});

test('runVerifier returns NO_BLOCKERS when the stream says so', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    extraArgv: [fakeAgent, 'clean'] });
  assert.equal(r.verdict, 'NO_BLOCKERS');
  assert.equal(r.launchFailed, false);
});

test('runVerifier identifies a non-zero empty stream as a launch failure', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    extraArgv: [brokenFakeAgent] });
  assert.equal(r.verdict, 'ISSUES');
  assert.equal(r.launchFailed, true);
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /fake agent failed/);
});

test('runVerifier returns ISSUES otherwise', async () => {
  const r = await runVerifier({ cwd: process.cwd(), bin: process.execPath,
    extraArgv: [fakeAgent, 'dirty'] });
  assert.equal(r.verdict, 'ISSUES');
});

test('parseVerdict handles the real captured cursor-agent stream without crashing', () => {
  const streamText = readFileSync(realSamplePath, 'utf8');
  const verdict = parseVerdict(streamText);
  assert.ok(verdict === 'NO_BLOCKERS' || verdict === 'ISSUES');
  // The sample is a FILEOK probe with no NO_BLOCKERS token, proving the parser
  // reads the real nested assistant/result shape rather than crashing or false-matching.
  assert.equal(verdict, 'ISSUES');
});

test('extractPlanArtifact returns the last real plan tool-call artifact and ignores interaction copies', () => {
  const streamText = rewriteEvents(readFileSync(planSamplePath, 'utf8'), (event) => {
    const planArgs = event.tool_call?.createPlanToolCall?.args;
    if (event.type === 'tool_call' && event.subtype === 'started' && planArgs) {
      planArgs.name = 'Stale started copy';
    }
    const interactionArgs = event.query?.createPlanRequestQuery?.args;
    if (interactionArgs) interactionArgs.name = 'Interaction copy must be ignored';
    return event;
  });
  const artifact = extractPlanArtifact(streamText);
  assert.equal(artifact.name, 'Diff review verdict');
  assert.match(artifact.overview, /implementation is wrong/);
  assert.match(artifact.plan, /return a - b/);
  assert.match(artifact.plan, /ISSUES$/);
  assert.equal(extractPlanArtifact(readFileSync(realSamplePath, 'utf8')), null);
});

test('parseVerdictDetail labels a conclusive real assistant fallback as assistant-sourced', () => {
  const streamText = readFileSync(planSamplePath, 'utf8').trim().split(/\r?\n/)
    .map(JSON.parse)
    .filter((event) => event.type !== 'result')
    .map(JSON.stringify)
    .join('\n');
  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'assistant');
  assert.match(detail.text, /wrong implementation/);
});

test('parseVerdictDetail labels a conclusive real result as result-sourced', () => {
  const detail = parseVerdictDetail(readFileSync(planSamplePath, 'utf8'));
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'result');
  assert.match(detail.text, /wrong implementation/);
  assert.match(detail.planText, /Sole assertion/);
});

test('parseVerdictDetail falls back to the real plan artifact when result is only preamble', () => {
  const streamText = rewriteEvents(readFileSync(planSamplePath, 'utf8'), (event) => {
    if (event.type === 'result') event.result = 'Review saved to the plan artifact.';
    if (event.type === 'assistant') {
      for (const part of event.message?.content ?? []) {
        if (part.type === 'text') part.text = 'Review saved to the plan artifact.';
      }
    }
    return event;
  });
  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'plan');
  assert.equal(detail.text, 'Review saved to the plan artifact.');
  assert.match(detail.planText, /Sole assertion/);
  assert.match(detail.planText, /ISSUES$/);
});

test('parseVerdictDetail labels an inconclusive real stream as fail-safe none', () => {
  const detail = parseVerdictDetail(readFileSync(realSamplePath, 'utf8'));
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
});

test('parseVerdict returns NO_BLOCKERS from a real-shaped result string', () => {
  const streamText = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'checking...' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'All clear.\n\nNO_BLOCKERS' }),
  ].join('\n');
  assert.equal(parseVerdict(streamText), 'NO_BLOCKERS');
});

test('a non-blocking-notes heading does not turn a clean assistant verdict into ISSUES', () => {
  const assistantText = 'No blocking problems found.\n\nNO_BLOCKERS';
  const resultText = 'The review is clean.\n\n## Non-blocking notes (not ISSUES)';
  const streamText = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: resultText }),
  ].join('\n');

  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'NO_BLOCKERS');
  assert.equal(detail.source, 'assistant');
  assert.equal(detail.text, assistantText);
});

test('a mid-paragraph NO_BLOCKERS refusal cannot hide a final blocking finding', () => {
  const streamText = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: "I can't mark this NO_BLOCKERS — there is a null dereference on line 40.\n\nThe null dereference is blocking and must be fixed.",
  });

  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
  assert.match(detail.text, /null dereference is blocking/);
});

test('final-line formatting noise is ignored for NO_BLOCKERS', () => {
  const finalLines = [
    '**NO_BLOCKERS**',
    '`NO_BLOCKERS`',
    'NO_BLOCKERS.',
    'NO_BLOCKERS   \t',
    '## NO_BLOCKERS',
    '- **NO_BLOCKERS**',
    'Verdict: NO_BLOCKERS;',
    '_NO_BLOCKERS_',
  ];

  for (const finalLine of finalLines) {
    const detail = parseVerdictDetail(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      result: `The review is clean.\n\n${finalLine}\n  `,
    }));
    assert.equal(detail.verdict, 'NO_BLOCKERS', finalLine);
    assert.equal(detail.source, 'result', finalLine);
  }
});

test('a result token on a non-final line does not decide the verdict', () => {
  const detail = parseVerdictDetail(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'NO_BLOCKERS\n\nA blocking race remains in the retry path.',
  }));
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
});

test('a plan line beginning with a formatted ISSUES token is conclusive', () => {
  const streamText = [
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Review saved to the plan.' }),
    JSON.stringify({
      type: 'tool_call', subtype: 'completed',
      tool_call: { createPlanToolCall: { args: {
        name: 'Review', overview: '',
        plan: '# Findings\n\n**ISSUES** — one blocking test bug; rest of the diff looks correct.',
      } } },
    }),
  ].join('\n');

  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'plan');
});

test('both qualifying plan tokens resolve to ISSUES', () => {
  const streamText = JSON.stringify({
    type: 'tool_call', subtype: 'completed',
    tool_call: { createPlanToolCall: { args: {
      name: 'Ambiguous review', overview: '',
      plan: '**NO_BLOCKERS** — initial assessment.\n\nVerdict: ISSUES — blocking defect confirmed.',
    } } },
  });

  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'plan');
});

test('an inconclusive synthetic stream remains fail-safe with no verdict source', () => {
  const detail = parseVerdictDetail(JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Review could not be completed.' }] },
  }));
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'none');
});

test('parseVerdict is fail-safe: an errored result yields ISSUES even if text contains NO_BLOCKERS', () => {
  const streamText = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'NO_BLOCKERS' }] } }),
    JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'NO_BLOCKERS' }),
  ].join('\n');
  assert.equal(parseVerdict(streamText), 'ISSUES');
  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.source, 'none');
  assert.equal(detail.text, '', 'errored result must keep suppressing assistant text');
});

test('a conclusive result ISSUES is not overridden by a NO_BLOCKERS plan artifact', () => {
  const streamText = rewriteEvents(readFileSync(planSamplePath, 'utf8'), (event) => {
    const args = event.type === 'tool_call'
      ? event.tool_call?.createPlanToolCall?.args
      : null;
    if (args && typeof args.plan === 'string') args.plan = args.plan.replaceAll('ISSUES', 'NO_BLOCKERS');
    return event;
  });
  const detail = parseVerdictDetail(streamText);
  assert.equal(detail.verdict, 'ISSUES');
  assert.equal(detail.source, 'result');
  assert.match(detail.planText, /NO_BLOCKERS$/);
});

test('hasVerdictEvidence detects result or assistant stream events', () => {
  assert.equal(hasVerdictEvidence(''), false);
  assert.equal(hasVerdictEvidence('{"type":"result","result":"x"}'), true);
});
