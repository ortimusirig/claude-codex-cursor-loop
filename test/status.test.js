import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCapture } from '../src/spawn.js';
import { readRunStatus } from '../src/status.js';

const cli = fileURLToPath(new URL('../bin/loop.js', import.meta.url));

function snapshot(directory) {
  return readdirSync(directory).sort().map((name) => {
    const path = join(directory, name);
    const stat = statSync(path);
    return { name, size: stat.size, mtimeMs: stat.mtimeMs, content: readFileSync(path, 'hex') };
  });
}

test('status is read-only and ignores a final NDJSON line truncated mid-write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ccc-status-'));
  const eventsPath = join(directory, 'events.jsonl');
  const events = [
    { ts: '2026-08-15T00:00:00.000Z', runId: 'status-run', stage: 'executor',
      type: 'file_change', file: 'src/a.js' },
    { ts: '2026-08-15T00:00:01.000Z', runId: 'status-run', stage: 'executor',
      type: 'finish', tokens: { inputTokens: 10, outputTokens: 3 } },
    { ts: '2026-08-15T00:00:02.000Z', runId: 'status-run', stage: 'executor',
      type: 'stalled', gapMs: 600000,
      lastEvent: { stage: 'executor', type: 'start' } },
    { ts: '2026-08-15T00:00:03.000Z', runId: 'status-run', stage: 'gate',
      type: 'gate_command', bin: 'node', args: ['--test'], code: 7 },
  ];
  writeFileSync(eventsPath, `${events.map(JSON.stringify).join('\n')}\n{"ts":"truncated`);
  writeFileSync(join(directory, 'operator-note.txt'), 'must stay byte-identical\n');
  const before = snapshot(directory);
  try {
    const status = readRunStatus(directory, { now: Date.parse('2026-08-15T00:00:08.000Z') });
    assert.equal(status.currentStage, 'gate');
    assert.equal(status.currentType, 'gate_command');
    assert.equal(status.gapMs, 5000);
    assert.deepEqual(status.files, ['src/a.js']);
    assert.deepEqual(status.gateCommands, [{ bin: 'node', args: ['--test'], code: 7 }]);
    assert.equal(status.tokens.inputTokens, 10);
    assert.equal(status.tokens.outputTokens, 3);
    assert.equal(status.stalls.length, 1,
      'positive control: the digest must retain the valid stall before the partial line');

    const result = await spawnCapture(process.execPath, [cli, 'status', directory]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Current stage: gate \(gate_command\)/);
    assert.match(result.stdout, /Files changed \(1\): src\/a[.]js/);
    assert.match(result.stdout, /node --test -> 7/);
    assert.match(result.stdout, /Stalls \(1\):/);
    assert.deepEqual(snapshot(directory), before,
      'status must not add, remove, rewrite, or touch the mtime of run-directory files');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('status filters a mixed event file to the run named by its directory and warns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-status-mixed-'));
  const requestedRun = '2026-08-15T07-06-24-363Z-requested';
  const otherRun = '2026-08-15T05-38-04-725Z-other';
  const runDirectory = join(root, requestedRun);
  const workDirectory = join(runDirectory, 'w');
  mkdirSync(workDirectory, { recursive: true });
  const events = [
    { ts: '2026-08-15T00:00:00.000Z', runId: otherRun, stage: 'executor',
      type: 'file_change', file: 'other/a.js' },
    { ts: '2026-08-15T00:00:01.000Z', runId: otherRun, stage: 'executor',
      type: 'file_change', file: 'other/b.js' },
    { ts: '2026-08-15T00:00:02.000Z', runId: otherRun, stage: 'executor',
      type: 'file_change', file: 'other/c.js' },
    { ts: '2026-08-15T00:00:03.000Z', runId: otherRun, stage: 'executor',
      type: 'finish', tokens: { inputTokens: 1000, outputTokens: 300 } },
    { ts: '2026-08-15T00:00:04.000Z', runId: requestedRun, stage: 'executor',
      type: 'file_change', file: 'requested/one.js' },
    { ts: '2026-08-15T00:00:05.000Z', runId: requestedRun, stage: 'executor',
      type: 'file_change', file: 'requested/two.js' },
    { ts: '2026-08-15T00:00:06.000Z', runId: requestedRun, stage: 'executor',
      type: 'finish', tokens: { inputTokens: 11, outputTokens: 7 } },
  ];
  writeFileSync(join(workDirectory, 'events.jsonl'),
    `${events.map(JSON.stringify).join('\n')}\n`);
  try {
    const status = readRunStatus(runDirectory, { now: Date.parse('2026-08-15T00:00:08.000Z') });
    assert.equal(status.runId, requestedRun);
    assert.deepEqual(status.files, ['requested/one.js', 'requested/two.js']);
    assert.equal(status.tokens.inputTokens, 11);
    assert.equal(status.tokens.outputTokens, 7);
    assert.deepEqual(status.otherRunIds, [otherRun]);

    const result = await spawnCapture(process.execPath, [cli, 'status', runDirectory]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /contains 2 runs; showing only/);
    assert.match(result.stdout, /Files changed \(2\): requested\/one[.]js, requested\/two[.]js/);
    assert.match(result.stdout, /Tokens: input 11; cached 0; output 7/);
    assert.doesNotMatch(result.stdout, /other\/[abc][.]js|input 1011|output 307/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
