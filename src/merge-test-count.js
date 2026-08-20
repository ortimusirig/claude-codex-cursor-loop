import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from './env-compat.js';

const TEST_DIRECTORIES = new Set(['test', 'tests', '__tests__']);

export function isTestPath(path) {
  const normalized = String(path).replaceAll('\\', '/').toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  const file = parts.at(-1) ?? '';
  return parts.slice(0, -1).some((part) => TEST_DIRECTORIES.has(part))
    || /(?:^|[._-])(?:test|spec)(?:[._-]|$)/.test(file);
}

export function countTestPaths(paths) {
  return [...paths].filter(isTestPath).length;
}

export function countTestFiles(directory) {
  const paths = [];
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile() || statSync(full).isFile()) paths.push(relative);
    }
  };
  walk(resolve(directory));
  return countTestPaths(paths);
}

// The floor is itself a gate command: pass/fail remains the command's exit code.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const floor = Number(process.argv[2]);
  if (!Number.isSafeInteger(floor) || floor < 0) {
    process.stderr.write(`invalid URO test-count floor: ${process.argv[2] ?? '(missing)'}\n`);
    process.exitCode = 2;
  } else {
    const observed = readEnv(process.env, 'OBSERVED_TEST_COUNT');
    const parsedObserved = observed === undefined ? null : Number(observed);
    const actual = Number.isSafeInteger(parsedObserved) && parsedObserved >= 0
      ? parsedObserved
      : countTestFiles(process.cwd());
    process.stdout.write(`URO test-count floor: actual=${actual} required=${floor}\n`);
    process.exitCode = actual >= floor ? 0 : 1;
  }
}
