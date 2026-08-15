import { spawnCapture } from './spawn.js';
import { reportEvent } from './events.js';
import { EMPTY_USAGE, normalizeCodexUsage } from './usage.js';
import { resolveStageTimeouts } from './timeouts.js';

export const DEFAULT_EXECUTOR_MODEL = 'gpt-5.6-sol';
export const DEFAULT_EXECUTOR_EFFORT = 'xhigh';

// Sandbox mode is configurable because Codex's own Windows filesystem sandbox is not
// reliable everywhere. On this machine `workspace-write` fails every write with
//   helper_sid_resolve_failed: resolve SID for offline user CodexSandboxOffline failed
// so the executor produces no diff, the gate goes red on the first import, and the loop
// reports gate-failed forever. Reads and model replies still work, which makes the
// failure easy to misdiagnose: probe with a WRITE, not a greeting.
//
// The escape hatch is CCC_CODEX_SANDBOX. Setting it to `danger-full-access` unblocks the
// executor, and the honest trade is worth stating plainly: it removes Codex's own
// confinement, so Codex is no longer restricted to the worktree. What still holds is the
// harness's isolation — a throwaway git worktree on a non-synced scratch disk, and a diff
// a human reads before anything merges. Codex's sandbox was a second belt on top of that,
// not the only one. Prefer fixing the SID resolution and leaving this unset.
const SANDBOX = process.env.CCC_CODEX_SANDBOX ?? 'workspace-write';

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
  const r = await spawnCapture(bin, args, { cwd, input: plan, timeoutMs, signal });
  const parsed = parseCodexStream(r.stdout);
  // spawnCapture's complete stdout buffer is a compatibility contract. File changes are
  // therefore reported after the process closes rather than weakening that buffer for
  // incremental observation.
  for (const file of parsed.changedFiles) {
    reportEvent(reporter, runId, 'executor', 'file_change', { file, attempt });
  }
  reportEvent(reporter, runId, 'executor', 'finish', {
    code: r.code, tokens: parsed.usage, timedOut: r.timedOut, attempt,
  });
  return {
    ...parsed,
    exitCode: r.code,
    timedOut: r.timedOut,
    ...(r.aborted ? { aborted: true } : {}),
    timeoutMs: r.timeoutMs,
  };
}
