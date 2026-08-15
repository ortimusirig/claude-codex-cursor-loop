import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { commandExists } from './spawn.js';
import { assertSafeScratchRoot } from './isolation.js';
import { resolveTask } from './task.js';

export async function preflight({ task, target, gate, scratchRoot, bins = { git: 'git', codex: 'codex', agent: 'agent' } }) {
  const fail = (reason) => ({ ok: false, reason });
  if (!existsSync(target)) return fail(`target does not exist: ${target}`);
  if (!existsSync(gate)) return fail(`gate config not found: ${gate}`);
  try { JSON.parse(readFileSync(gate, 'utf8')); } catch (e) { return fail(`gate config is not valid JSON: ${e.message}`); }
  if (task !== undefined) {
    try { resolveTask(task); } catch (e) { return fail(e.message); }
  }
  try { assertSafeScratchRoot(scratchRoot); } catch (e) { return fail(e.message); }
  for (const [name, bin] of Object.entries(bins)) {
    if (!(await commandExists(bin))) return fail(`required binary not found: ${name} (${bin})`);
  }
  return { ok: true, reason: null };
}
