import { existsSync, readFileSync, statSync } from 'node:fs';

function looksLikePath(value) {
  // Treat separator/dot/tilde-prefixed values and every whitespace-free token as
  // path-like. This intentionally errs toward a loud missing-file error: a one-word
  // inline task can be made unambiguous by adding prose, while a mistaken path must
  // never become an expensive one-word executor prompt.
  return /[\\/]/.test(value) || /^[.~]/.test(value) || !/\s/.test(value);
}

export function resolveTask(task) {
  if (typeof task !== 'string' || task.length === 0) {
    throw new Error('task must be a non-empty string');
  }

  if (existsSync(task)) {
    let isFile;
    try {
      isFile = statSync(task).isFile();
    } catch (error) {
      throw new Error(`cannot inspect task path ${task}: ${error.message}`);
    }
    if (!isFile) throw new Error(`task path is not a file: ${task}`);
    try {
      return readFileSync(task, 'utf8');
    } catch (error) {
      throw new Error(`cannot read task file ${task}: ${error.message}`);
    }
  }

  if (looksLikePath(task)) throw new Error(`task file not found: ${task}`);
  return task;
}
