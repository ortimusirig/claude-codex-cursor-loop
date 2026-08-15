import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { reportEvent } from './events.js';
import { spawnCapture } from './spawn.js';

export function assertSafeScratchRoot(root) {
  const segs = root.replace(/\\/g, '/').toLowerCase().split('/');
  for (const s of segs) {
    if (s === 'appdata') throw new Error(`scratch root under AppData is forbidden: ${root}`);
    if (s === 'onedrive' || s.startsWith('onedrive ') || s.startsWith('onedrive-')) {
      throw new Error(`scratch root under OneDrive is forbidden: ${root}`);
    }
  }
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

export function hashTree(dir) {
  const h = createHash('sha256');
  for (const rel of walk(dir)) {
    h.update(rel).update('\0').update(readFileSync(join(dir, rel))).update('\0');
  }
  return h.digest('hex');
}

async function git(cwd, ...args) {
  const r = await spawnCapture('git', ['-C', cwd, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

export async function isolate({ target, runId, scratchRoot, reporter }) {
  reportEvent(reporter, runId, 'isolate', 'start', { source: target });
  assertSafeScratchRoot(scratchRoot);
  const branch = `ccc/${runId}`;
  const dir = join(scratchRoot, runId, 'w');
  const isRepo = (await spawnCapture('git', ['-C', target, 'rev-parse', '--is-inside-work-tree'])).code === 0;
  if (isRepo) {
    await git(target, 'worktree', 'add', '-b', branch, dir, 'HEAD');
    reportEvent(reporter, runId, 'isolate', 'finish', {
      dir, source: 'git-worktree',
    });
    return { dir, isRepo: true, branch, cleanup: async () => {
      await spawnCapture('git', ['-C', target, 'worktree', 'remove', '--force', dir]);
    } };
  }
  mkdirSync(dir, { recursive: true });
  cpSync(target, dir, { recursive: true });
  await git(dir, 'init', '-b', branch);
  await git(dir, 'add', '-A');
  await git(dir, '-c', 'user.email=ccc@local', '-c', 'user.name=ccc', 'commit', '-m', 'baseline');
  reportEvent(reporter, runId, 'isolate', 'finish', {
    dir, source: 'copy',
  });
  return { dir, isRepo: false, branch, cleanup: async () => {
    rmSync(join(scratchRoot, runId), { recursive: true, force: true });
  } };
}
