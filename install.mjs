#!/usr/bin/env node
// Portable installer for the run-claude-codex-cursor-loop skill.
// Cross-platform, zero dependencies, no PowerShell or bash required.
//
//   node install.mjs            install to ~/.claude/skills/run-claude-codex-cursor-loop
//   node install.mjs --name X   install under a different skill name
//   node install.mjs --dry-run  show what would happen, change nothing
//
// Copies the package, verifies every file by SHA-256, then runs the self-test
// from the INSTALLED location (the installed copy is what actually runs).

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
// Docs and diag.mjs ride along: install wipes the destination first, so anything
// absent here is DELETED from an existing install. diag.mjs is a runtime tool, and
// README.md is the CLI reference — both belong where the skill is actually invoked.
// The missing-source guard below checks only entries that are listed here; it cannot
// detect an existing top-level entry silently omitted from this array.
const PAYLOAD = ['package.json', 'SKILL.md', 'README.md', 'LICENSE', 'PORTING.md', 'diag.mjs', 'bin', 'src', 'fixtures', 'test', 'docs', 'cursor-plugin'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const nameIdx = args.indexOf('--name');
const skillName = nameIdx >= 0 ? args[nameIdx + 1] : 'run-claude-codex-cursor-loop';
const dest = join(homedir(), '.claude', 'skills', skillName);

const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(`FAIL: Node >=24 required, found ${process.versions.node}`);
  process.exit(1);
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

console.log(`source: ${SRC}`);
console.log(`target: ${dest}`);
if (dryRun) {
  console.log('\n--dry-run: nothing was written. Payload that would be installed:');
  for (const item of PAYLOAD) console.log(`  ${item}${existsSync(join(SRC, item)) ? '' : '  (MISSING)'}`);
  process.exit(0);
}

for (const item of PAYLOAD) {
  if (!existsSync(join(SRC, item))) {
    console.error(`FAIL: payload item missing from source: ${item}`);
    process.exit(1);
  }
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const item of PAYLOAD) cpSync(join(SRC, item), join(dest, item), { recursive: true });

// Verify: every installed file must byte-match its source.
let checked = 0;
for (const item of PAYLOAD) {
  const from = join(SRC, item);
  const files = statSync(from).isDirectory() ? walk(from).map((r) => [join(from, r), join(dest, item, r)]) : [[from, join(dest, item)]];
  for (const [a, b] of files) {
    if (sha(a) !== sha(b)) {
      console.error(`FAIL: hash mismatch after copy: ${b}`);
      process.exit(1);
    }
    checked++;
  }
}
console.log(`verified: ${checked} files match by SHA-256`);

// Self-test from the installed location.
const t = spawnSync(process.execPath, ['--test'], { cwd: dest, encoding: 'utf8' });
const out = `${t.stdout}${t.stderr}`;
const pass = /^# pass (\d+)/m.exec(out)?.[1] ?? /pass (\d+)/.exec(out)?.[1] ?? '?';
const fail = /^# fail (\d+)/m.exec(out)?.[1] ?? /fail (\d+)/.exec(out)?.[1] ?? '?';
if (t.status !== 0) {
  console.error(`FAIL: self-test failed from the installed location (pass=${pass} fail=${fail})`);
  process.exit(1);
}
console.log(`self-test: PASS (${pass} tests)`);

// Report vendor CLI availability (informational — the loop preflights these at run time).
const probe = process.platform === 'win32' ? 'where' : 'which';
for (const bin of ['git', 'codex', 'agent']) {
  const r = spawnSync(probe, [bin], { encoding: 'utf8' });
  console.log(`${bin}: ${r.status === 0 ? 'found' : 'NOT FOUND (needed at run time)'}`);
}

const scratch = process.env.CCC_SCRATCH_ROOT ?? (process.platform === 'win32' ? 'C:/ccc/w' : '~/.ccc/w');
console.log(`\nSKILL_STATUS=INSTALLED name=${skillName}`);
console.log(`scratch root: ${scratch}  (override with CCC_SCRATCH_ROOT)`);
console.log(`run: node "${join(dest, 'bin', 'loop.js')}" run --task <plan.md> --target <folder> --gate <gate.json>`);
