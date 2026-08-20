import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_ARTIFACTS, resolveArtifact } from '../src/artifacts.js';

test('resolveArtifact prefers the current name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uro-artifact-'));
  try {
    writeFileSync(join(dir, 'uro-runfacts.json'), '{}');
    writeFileSync(join(dir, 'ccc-runfacts.json'), '{}');
    assert.equal(resolveArtifact(dir, 'uro-runfacts.json'), join(dir, 'uro-runfacts.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveArtifact falls back to the superseded name so old runs stay readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uro-artifact-'));
  try {
    writeFileSync(join(dir, 'ccc-runfacts.json'), '{}');
    assert.equal(resolveArtifact(dir, 'uro-runfacts.json'), join(dir, 'ccc-runfacts.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveArtifact returns the current path when neither file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uro-artifact-'));
  try {
    assert.equal(resolveArtifact(dir, 'uro-report.md'), join(dir, 'uro-report.md'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HARNESS_ARTIFACTS excludes both prefixes from staging and diffs', () => {
  // A pre-rename run directory still holds ccc- files. If they are not excluded they are
  // staged into CHANGES.diff as if they were the unit's own work.
  for (const name of [
    'uro-report.md', 'uro-runfacts.json', 'uro-github.json', 'uro-merge-resolutions.json',
    'ccc-report.md', 'ccc-runfacts.json', 'ccc-github.json', 'ccc-merge-resolutions.json',
  ]) {
    assert.ok(HARNESS_ARTIFACTS.includes(name), `${name} must be excluded`);
  }
});
