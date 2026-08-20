import { spawnCapture } from './spawn.js';
import { reportEvent } from './events.js';
import { encodeRecordedText } from './execution-record.js';
import { annotateUsageConsistency, EMPTY_USAGE, normalizeCodexUsage } from './usage.js';
import { resolveStageTimeouts } from './timeouts.js';
import { StringDecoder } from 'node:string_decoder';
import { readEnv } from './env-compat.js';

export const DEFAULT_EXECUTOR_MODEL = 'gpt-5.6-sol';
export const DEFAULT_EXECUTOR_EFFORT = 'xhigh';

// Sandbox mode is configurable because Codex's own Windows filesystem sandbox is not
// reliable everywhere. On this machine `workspace-write` fails every write with
//   helper_sid_resolve_failed: resolve SID for offline user CodexSandboxOffline failed
// so the executor produces no diff, the gate goes red on the first import, and the loop
// reports gate-failed forever. Reads and model replies still work, which makes the
// failure easy to misdiagnose: probe with a WRITE, not a greeting.
//
// The escape hatch is URO_CODEX_SANDBOX. Setting it to `danger-full-access` unblocks the
// executor, and the honest trade is worth stating plainly: it removes Codex's own
// confinement, so Codex is no longer restricted to the worktree. What still holds is the
// harness's isolation — a throwaway git worktree on a non-synced scratch disk, and a diff
// a human reads before anything merges. Codex's sandbox was a second belt on top of that,
// not the only one. Prefer fixing the SID resolution and leaving this unset.
const SANDBOX = readEnv(process.env, 'CODEX_SANDBOX') ?? 'workspace-write';

export function buildCodexArgs({
  cwd,
  model = DEFAULT_EXECUTOR_MODEL,
  effort = DEFAULT_EXECUTOR_EFFORT,
  sandbox = SANDBOX,
}) {
  return [
    'exec', '--json',
    '-m', model,
    '-c', `model_reasoning_effort=${effort}`,
    '-c', 'mcp_servers={}',
    '-s', sandbox,
    '-C', cwd,
    '-',
  ];
}

export function parseCodexStream(streamText) {
  const seen = new Set();
  const changedFiles = [];
  let lastMessage = '';
  let usage = EMPTY_USAGE;
  for (const line of streamText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.type === 'turn.completed' && Object.hasOwn(o, 'usage')) {
      usage = normalizeCodexUsage(o.usage);
      continue;
    }
    if (o.type !== 'item.completed' || !o.item) continue;
    const it = o.item;
    if (it.type === 'file_change' && Array.isArray(it.changes)) {
      for (const c of it.changes) {
        if (c && typeof c.path === 'string' && !seen.has(c.path)) { seen.add(c.path); changedFiles.push(c.path); }
      }
    } else if (it.type === 'agent_message' && typeof it.text === 'string') {
      lastMessage = it.text;
    }
  }
  return { changedFiles, lastMessage, usage };
}

function createIncrementalReporter({ reporter, runId, attempt }) {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  const observeLine = (line) => {
    const source = line.trim();
    if (source === '') return;
    let event;
    try { event = JSON.parse(source); } catch { return; }
    if (event?.type !== 'item.completed' || !event.item) return;

    const item = event.item;
    let reported = false;
    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      const seenFiles = new Set();
      for (const change of item.changes) {
        if (!change || typeof change.path !== 'string' || seenFiles.has(change.path)) continue;
        seenFiles.add(change.path);
        reported = true;
        reportEvent(reporter, runId, 'executor', 'file_change', {
          file: change.path, attempt,
        });
      }
    }
    // Every completed item is observable activity. A file-change item already reports its
    // paths; all other items (and duplicate/empty file-change items) get one progress event.
    if (!reported) {
      const itemType = typeof item.type === 'string' ? item.type : 'unknown';
      const fields = { itemType, attempt };
      if (itemType === 'command_execution') {
        if (typeof item.command === 'string') fields.command = item.command;
        if (Number.isInteger(item.exit_code)) fields.exitCode = item.exit_code;
        const output = encodeRecordedText(item.aggregated_output);
        if (output.text !== '') {
          fields.output = output.text;
          fields.outputEncoding = output.encoding;
          if (output.truncated) fields.outputTruncated = true;
        }
      }
      if (itemType === 'error' && typeof item.message === 'string') {
        fields.errorMessage = item.message;
      }
      if (itemType === 'agent_message') {
        const text = encodeRecordedText(item.text);
        if (text.text !== '') {
          fields.text = text.text;
          fields.textEncoding = text.encoding;
          if (text.truncated) fields.textTruncated = true;
        }
      }
      reportEvent(reporter, runId, 'executor', 'item_completed', fields);
    }
  };

  const consumeCompleteLines = () => {
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      observeLine(line);
    }
  };

  return {
    onStdout(chunk) {
      pending += decoder.write(chunk);
      consumeCompleteLines();
    },
    finish() {
      pending += decoder.end();
      consumeCompleteLines();
      if (pending !== '') observeLine(pending);
      pending = '';
    },
  };
}

export async function runExecutor({
  plan,
  cwd,
  bin = 'codex',
  extraArgv = [],
  model = DEFAULT_EXECUTOR_MODEL,
  effort = DEFAULT_EXECUTOR_EFFORT,
  timeoutMs = resolveStageTimeouts().executor,
  reporter,
  runId,
  attempt,
  signal,
}) {
  const args = [...extraArgv, ...buildCodexArgs({ cwd, model, effort })];
  reportEvent(reporter, runId, 'executor', 'start', { bin, args, attempt });
  // Executor launches are special: healthy Codex turns often outlive the watchdog gap,
  // unlike the shorter gate/verify commands. Observe its NDJSON as it arrives so the gap
  // remains a gap measurement; spawnCapture still retains and returns every original byte.
  const observer = typeof reporter === 'function'
    ? createIncrementalReporter({ reporter, runId, attempt })
    : null;
  const r = await spawnCapture(bin, args, {
    cwd, input: plan, timeoutMs, signal,
    ...(observer ? { onStdout: observer.onStdout } : {}),
  });
  observer?.finish();
  const parsed = parseCodexStream(r.stdout);
  const result = annotateUsageConsistency({
    ...parsed,
    exitCode: r.code,
    timedOut: r.timedOut,
    ...(r.aborted ? { aborted: true } : {}),
    timeoutMs: r.timeoutMs,
  });
  reportEvent(reporter, runId, 'executor', 'finish', {
    code: r.code, tokens: parsed.usage, timedOut: r.timedOut, attempt,
    usageConsistency: result.usageConsistency.status,
  });
  return result;
}
