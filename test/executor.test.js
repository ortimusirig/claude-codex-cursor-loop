import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildCodexArgs,
  DEFAULT_EXECUTOR_EFFORT,
  DEFAULT_EXECUTOR_MODEL,
  runExecutor,
  parseCodexStream,
} from '../src/executor.js';
import {
  addUsage,
  EMPTY_USAGE,
  normalizeCodexUsage,
  normalizeCursorUsage,
} from '../src/usage.js';

const fakeCodex = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
const schemaSamplePath = fileURLToPath(new URL('../fixtures/codex-stream-schema-sample.ndjson', import.meta.url));
const usageSamplePath = fileURLToPath(new URL('../fixtures/codex-exec-usage-sample.ndjson', import.meta.url));
const cursorPlanSamplePath = fileURLToPath(new URL('../fixtures/cursor-plan-mode-sample.ndjson', import.meta.url));

test('buildCodexArgs pins model, effort, disables MCP, and defaults to workspace-write', async () => {
  // The pin belongs here, spelled out: a test that avoided the literal would stop being
  // able to detect a changed default, which is the only thing this line is for.
  assert.equal(DEFAULT_EXECUTOR_MODEL, 'gpt-5.6-sol');
  assert.equal(DEFAULT_EXECUTOR_EFFORT, 'xhigh');
  const hadSandboxOverride = Object.hasOwn(process.env, 'CCC_CODEX_SANDBOX');
  const sandboxOverride = process.env.CCC_CODEX_SANDBOX;
  delete process.env.CCC_CODEX_SANDBOX;
  try {
    const isolatedModule = await import(`../src/executor.js?default-sandbox=${Date.now()}`);
    const a = isolatedModule.buildCodexArgs({ cwd: 'C:/w' }).join(' ');
    assert.match(a, /exec/);
    assert.match(a, /--json/);
    assert.match(a, new RegExp(`-m ${DEFAULT_EXECUTOR_MODEL.replaceAll('.', '\\.')}`));
    assert.match(a, new RegExp(`model_reasoning_effort=${DEFAULT_EXECUTOR_EFFORT}`));
    assert.match(a, /mcp_servers=\{\}/);
    assert.match(a, /-s workspace-write/, 'the confining mode stays the default');
    assert.doesNotMatch(a, /--ignore-user-config/, 'must never discard project trust');
  } finally {
    if (hadSandboxOverride) process.env.CCC_CODEX_SANDBOX = sandboxOverride;
  }
});

test('buildCodexArgs allows an explicit sandbox override, for hosts where the Codex sandbox is broken', () => {
  const a = buildCodexArgs({ cwd: 'C:/w', sandbox: 'danger-full-access' }).join(' ');
  assert.match(a, /-s danger-full-access/);
  // The override must not quietly change anything else about the invocation.
  assert.match(a, new RegExp(`-m ${DEFAULT_EXECUTOR_MODEL.replaceAll('.', '\\.')}`));
  assert.match(a, /mcp_servers=\{\}/);
});

test('buildCodexArgs accepts explicit model and effort overrides', () => {
  const a = buildCodexArgs({ cwd: 'C:/w', model: 'executor-override', effort: 'medium' });
  assert.equal(a[a.indexOf('-m') + 1], 'executor-override');
  assert.ok(a.includes('model_reasoning_effort=medium'));
});

test('runExecutor parses file_change and agent_message from the stream', async () => {
  const r = await runExecutor({ plan: 'do the thing', cwd: process.cwd(),
    bin: process.execPath, extraArgv: [fakeCodex] });
  assert.deepEqual(r.changedFiles, ['a.py', 'b.py']);
  assert.equal(r.lastMessage, 'implemented the thing');
});

test('parseCodexStream handles the real wrapped item.completed schema, ignores errors and item.started', () => {
  const sample = readFileSync(schemaSamplePath, 'utf8');
  const r = parseCodexStream(sample);
  assert.deepEqual(r.changedFiles, ['ok.txt']);
  assert.equal(r.lastMessage, 'Created ok.txt.');
  assert.deepEqual(r.usage, EMPTY_USAGE);
});

test('normalizeCodexUsage maps the real Codex usage object', () => {
  const stream = readFileSync(usageSamplePath, 'utf8');
  const raw = stream.trim().split(/\r?\n/).map(JSON.parse).at(-1).usage;
  assert.deepEqual(normalizeCodexUsage(raw), {
    inputTokens: 31116,
    cachedInputTokens: 26112,
    outputTokens: 96,
    reasoningOutputTokens: 45,
    cacheWriteTokens: 0,
  });
});

test('normalizeCursorUsage maps the real Cursor usage object', () => {
  const stream = readFileSync(cursorPlanSamplePath, 'utf8');
  const raw = stream.trim().split(/\r?\n/).map(JSON.parse).find((event) => event.type === 'result').usage;
  assert.deepEqual(normalizeCursorUsage(raw), {
    inputTokens: 20111,
    cachedInputTokens: 38528,
    outputTokens: 1184,
    reasoningOutputTokens: 0,
    cacheWriteTokens: 0,
  });
});

test('usage normalizers return zero usage for missing or garbage input and sanitize invalid fields', () => {
  for (const raw of [undefined, null, 'garbage', 42, [], () => {}]) {
    assert.deepEqual(normalizeCodexUsage(raw), EMPTY_USAGE);
    assert.deepEqual(normalizeCursorUsage(raw), EMPTY_USAGE);
  }
  assert.deepEqual(normalizeCodexUsage({ input_tokens: -1, output_tokens: '96' }), EMPTY_USAGE);
  assert.deepEqual(normalizeCursorUsage({ inputTokens: Number.NaN, cacheReadTokens: -2 }), EMPTY_USAGE);
});

test('addUsage sums canonical fields without mutating either argument', () => {
  const a = { inputTokens: 10, cachedInputTokens: 7, outputTokens: 3,
    reasoningOutputTokens: 2, cacheWriteTokens: 1 };
  const b = { inputTokens: 4, cachedInputTokens: 5, outputTokens: 6,
    reasoningOutputTokens: 8, cacheWriteTokens: 9 };
  const beforeA = { ...a };
  const beforeB = { ...b };
  assert.deepEqual(addUsage(a, b), {
    inputTokens: 14,
    cachedInputTokens: 12,
    outputTokens: 9,
    reasoningOutputTokens: 10,
    cacheWriteTokens: 10,
  });
  assert.deepEqual(a, beforeA);
  assert.deepEqual(b, beforeB);
});

test('parseCodexStream retains real usage and ignores command_execution items', () => {
  const earlierUsage = JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 1, cached_input_tokens: 2, cache_write_input_tokens: 3,
      output_tokens: 4, reasoning_output_tokens: 5,
    },
  });
  const r = parseCodexStream(`${earlierUsage}\n${readFileSync(usageSamplePath, 'utf8')}`);
  assert.deepEqual(r.changedFiles, []);
  assert.equal(r.lastMessage, 'PROBEOK');
  assert.deepEqual(r.usage, {
    inputTokens: 31116,
    cachedInputTokens: 26112,
    outputTokens: 96,
    reasoningOutputTokens: 45,
    cacheWriteTokens: 0,
  });
});
