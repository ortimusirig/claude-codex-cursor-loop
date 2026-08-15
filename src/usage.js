export const EMPTY_USAGE = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  cacheWriteTokens: 0,
});

const valueOrZero = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
);

function isUsageObject(raw) {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

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
  return {
    inputTokens: valueOrZero(raw.inputTokens),
    cachedInputTokens: valueOrZero(raw.cacheReadTokens),
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
