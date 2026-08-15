import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflight } from '../src/preflight.js';

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
