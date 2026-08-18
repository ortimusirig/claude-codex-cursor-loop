import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { commandExists } from './spawn.js';
import { assertSafeScratchRoot } from './isolation.js';
import { resolveTask } from './task.js';

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export async function preflight({
  task,
  tasks,
  target,
  gate,
  scratchRoot,
  correctsRunId,
  bins = { git: 'git', codex: 'codex', agent: 'agent' },
}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!existsSync(target)) return fail(`target does not exist: ${target}`);
  if (!existsSync(gate)) return fail(`gate config not found: ${gate}`);
  try { JSON.parse(readFileSync(gate, 'utf8')); } catch (e) { return fail(`gate config is not valid JSON: ${e.message}`); }
  const taskInputs = tasks ?? (task === undefined ? [] : [task]);
  for (const taskInput of taskInputs) {
    try { resolveTask(taskInput); } catch (e) { return fail(e.message); }
  }
  try { assertSafeScratchRoot(scratchRoot); } catch (e) { return fail(e.message); }
  if (correctsRunId !== undefined) {
    const root = resolve(scratchRoot);
    const runDirectory = resolve(root, correctsRunId);
    const isDirectChild = runDirectory !== root && dirname(runDirectory) === root;
    if (!isDirectChild
      || (!isDirectory(join(root, correctsRunId))
        && !isDirectory(join(root, correctsRunId, 'w')))) {
      return fail(`corrected run not found under scratch root: ${correctsRunId}`);
    }
  }
  for (const [name, bin] of Object.entries(bins)) {
    if (!(await commandExists(bin))) return fail(`required binary not found: ${name} (${bin})`);
  }
  return { ok: true, reason: null };
}
