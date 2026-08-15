import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTask } from '../src/task.js';

test('an existing .txt task file is read as the plan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-'));
  const path = join(dir, 'plan.txt');
  writeFileSync(path, 'Implement the behavior from this text file.\n');
  try {
    assert.equal(resolveTask(path), 'Implement the behavior from this text file.\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('genuine inline prose is returned verbatim', () => {
  const prose = 'Implement the requested behavior safely.';
  assert.equal(resolveTask(prose), prose);
});

test('a missing path-like task is rejected instead of becoming prose', () => {
  assert.throws(() => resolveTask('missing-plan.txt'), /task file not found: missing-plan[.]txt/);
});
