export const EMPTY_USAGE = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  cacheWriteTokens: 0,
});

export const USAGE_INPUT_INVARIANT = 'cachedInputTokens <= inputTokens';

const valueOrZero = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
);

function isUsageObject(raw) {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

// Canonical usage is inclusive: inputTokens is all input consumed, while
// cachedInputTokens is the cache-served portion of that total. Codex already reports
// input_tokens this way, so its fields are copied without adjustment. Cursor disagrees:
// inputTokens is new input only and cacheReadTokens is separate, so Cursor must be
// converted by adding the two into the canonical inputTokens total.
export function normalizeCodexUsage(raw) {
  if (!isUsageObject(raw)) return EMPTY_USAGE;
  return {
    inputTokens: valueOrZero(raw.input_tokens),
    cachedInputTokens: valueOrZero(raw.cached_input_tokens),
    outputTokens: valueOrZero(raw.output_tokens),
    reasoningOutputTokens: valueOrZero(raw.reasoning_output_tokens),
    cacheWriteTokens: valueOrZero(raw.cache_write_input_tokens),
  };
}

export function normalizeCursorUsage(raw) {
  if (!isUsageObject(raw)) return EMPTY_USAGE;
  const newInputTokens = valueOrZero(raw.inputTokens);
  const cachedInputTokens = valueOrZero(raw.cacheReadTokens);
  return {
    inputTokens: newInputTokens + cachedInputTokens,
    cachedInputTokens,
    outputTokens: valueOrZero(raw.outputTokens),
    reasoningOutputTokens: 0,
    cacheWriteTokens: valueOrZero(raw.cacheWriteTokens),
  };
}

export function addUsage(a, b) {
  return {
    inputTokens: valueOrZero(a?.inputTokens) + valueOrZero(b?.inputTokens),
    cachedInputTokens: valueOrZero(a?.cachedInputTokens) + valueOrZero(b?.cachedInputTokens),
    outputTokens: valueOrZero(a?.outputTokens) + valueOrZero(b?.outputTokens),
    reasoningOutputTokens: valueOrZero(a?.reasoningOutputTokens) + valueOrZero(b?.reasoningOutputTokens),
    cacheWriteTokens: valueOrZero(a?.cacheWriteTokens) + valueOrZero(b?.cacheWriteTokens),
  };
}

export function checkUsageConsistency(usage) {
  const normalized = addUsage(EMPTY_USAGE, usage);
  const status = normalized.cachedInputTokens <= normalized.inputTokens
    ? 'consistent'
    : 'disagreement';
  // This is an accounting assertion, not an execution assertion. Return a structured
  // disagreement instead of throwing: accounting defects must be visible in run facts
  // and reports, but must never turn otherwise successful work into a failed run.
  return {
    status,
    invariant: USAGE_INPUT_INVARIANT,
    inputTokens: normalized.inputTokens,
    cachedInputTokens: normalized.cachedInputTokens,
    ...(status === 'disagreement'
      ? { message: 'Cached input tokens exceed total input tokens.' }
      : {}),
  };
}

export function annotateUsageConsistency(result) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  if (!Object.hasOwn(result, 'usage')) return result;
  return {
    ...result,
    usageConsistency: checkUsageConsistency(result.usage),
  };
}

export function summarizeUsageConsistency(checks = []) {
  const recordedChecks = Array.isArray(checks) ? checks : [];
  return {
    status: recordedChecks.some((check) => check?.status === 'disagreement')
      ? 'disagreement'
      : 'consistent',
    invariant: USAGE_INPUT_INVARIANT,
    checks: recordedChecks.map((check) => ({ ...check })),
  };
}
