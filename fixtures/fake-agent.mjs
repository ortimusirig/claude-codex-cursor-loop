// argv[2] === 'clean' emits NO_BLOCKERS, anything else emits an ISSUES review.
// Emits the real cursor-agent --output-format stream-json shape: a nested
// assistant message (message.content is an array of {type:"text"} parts)
// followed by a final result event.
const mode = process.argv[2] ?? 'dirty';
const verdict = mode === 'clean' ? 'NO_BLOCKERS' : 'ISSUES';
const review = mode === 'clean'
  ? `No blocking problems found.\n\n${verdict}`
  : `There is a bug on line 4.\n\n${verdict}`;
const plan = mode === 'long-plan'
  ? `${'x'.repeat(9000)}\n\nISSUES`
  : `Retained review details.\n\n${verdict}`;
process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: review }] } }) + '\n');
process.stdout.write(JSON.stringify({
  type: 'tool_call', subtype: 'completed',
  tool_call: { createPlanToolCall: { args: {
    name: 'Fake review plan', overview: 'Fake overview', plan,
  } } },
}) + '\n');
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: review,
  usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 },
}) + '\n');
