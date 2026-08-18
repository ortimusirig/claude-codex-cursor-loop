import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflight } from '../src/preflight.js';

const SAFE_SCRATCH_BASE = process.env.CCC_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/ccc-test'
  : join(homedir(), '.ccc-test'));

function makeScratch() {
  mkdirSync(SAFE_SCRATCH_BASE, { recursive: true });
  return mkdtempSync(join(SAFE_SCRATCH_BASE, '.preflight-corrects-'));
}

test('fails when target does not exist', async () => {
  const gate = mkdtempSync(join(tmpdir(), 'g-'));
  writeFileSync(join(gate, 'gate.json'), '[]');
  const r = await preflight({ target: 'C:/does/not/exist/xyz', gate: join(gate, 'gate.json'),
    scratchRoot: 'C:/ccc/w', bins: { git: process.execPath, codex: process.execPath, agent: process.execPath } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /target/i);
});

test('fails when scratch root is under AppData', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(d, 'gate.json'), '[]');
  const r = await preflight({ target: d, gate: join(d, 'gate.json'),
    scratchRoot: 'C:/Users/x/AppData/Local/ccc',
    bins: { git: process.execPath, codex: process.execPath, agent: process.execPath } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /AppData/i);
});

test('passes when everything resolves', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-'));
  writeFileSync(join(d, 'gate.json'), '[]');
  const r = await preflight({ target: d, gate: join(d, 'gate.json'), scratchRoot: 'C:/ccc/w',
    bins: { git: process.execPath, codex: process.execPath, agent: process.execPath } });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('fails before binary probes when a path-like task file is missing', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-'));
  const missing = join(d, 'missing-plan.txt');
  writeFileSync(join(d, 'gate.json'), '[]');
  const r = await preflight({ task: missing, target: d, gate: join(d, 'gate.json'),
    scratchRoot: 'C:/ccc/w',
    bins: { git: 'not-needed', codex: 'not-needed', agent: 'not-needed' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /task file not found/i);
  assert.ok(r.reason.includes(missing), 'the diagnostic must name the missing task path');
});

test('batch preflight validates every task before probing binaries', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-'));
  const missing = join(d, 'second-plan.txt');
  writeFileSync(join(d, 'gate.json'), '[]');
  const r = await preflight({
    tasks: ['Valid inline plan prose.', missing],
    target: d,
    gate: join(d, 'gate.json'),
    scratchRoot: 'C:/ccc/w',
    bins: { git: 'not-needed', codex: 'not-needed', agent: 'not-needed' },
  });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes(missing));
});

test('preflight rejects a missing corrected run and accepts an existing run directory', async () => {
  const d = mkdtempSync(join(tmpdir(), 'p-corrects-'));
  const scratchRoot = makeScratch();
  const gate = join(d, 'gate.json');
  writeFileSync(gate, '[]');
  const bins = { git: process.execPath, codex: process.execPath, agent: process.execPath };
  try {
    const missing = await preflight({
      task: 'A valid inline task.', target: d, gate, scratchRoot,
      correctsRunId: 'mistyped-prior-run', bins,
    });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /corrected run not found/i);
    assert.ok(missing.reason.includes('mistyped-prior-run'),
      'the preflight diagnostic must name the missing run id');

    mkdirSync(join(scratchRoot, 'existing-prior-run', 'w'), { recursive: true });
    const existing = await preflight({
      task: 'A valid inline task.', target: d, gate, scratchRoot,
      correctsRunId: 'existing-prior-run', bins,
    });
    assert.deepEqual(existing, { ok: true, reason: null },
      'positive control: an existing prior run must pass the same preflight');
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});
