import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collapseLogRows,
  isProblemEvent,
  LogRunNotFoundError,
  queryLogs,
} from '../src/log-query.js';

function makeRoot(name) {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function writeRun(root, runId, events, suffix = '') {
  const worktree = join(root, runId, 'w');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, 'events.jsonl'), events.map(JSON.stringify).join('\n')
    + (events.length > 0 ? '\n' : '') + suffix);
  return join(root, runId);
}

function event(runId, fields = {}) {
  return {
    ts: '2026-08-15T00:00:00.000Z',
    runId,
    stage: 'gate',
    type: 'gate_command',
    bin: 'npm',
    args: ['test'],
    code: 0,
    ...fields,
  };
}

test('problems-only discriminates failures from the same clean stream returned without it', () => {
  const root = makeRoot('ccc-log-problems');
  const clean = event('filter-run', { verdict: 'NO_BLOCKERS', verdictSource: 'result' });
  const failed = event('filter-run', { ts: '2026-08-15T00:00:01.000Z', code: 7 });
  const runDirectory = writeRun(root, 'filter-run', [clean, failed]);
  try {
    const problems = queryLogs({ runDirectory, problemsOnly: true, collapse: false });
    assert.deepEqual(problems.map((row) => row.event), [failed]);

    const cleanDirectory = writeRun(root, 'clean-run', [
      { ...clean, runId: 'clean-run' },
    ]);
    assert.deepEqual(queryLogs({ runDirectory: cleanDirectory, problemsOnly: true }), []);
    assert.deepEqual(
      queryLogs({ runDirectory: cleanDirectory, problemsOnly: false, collapse: false })
        .map((row) => row.event),
      [{ ...clean, runId: 'clean-run' }],
      'the positive control proves the clean stream was read rather than ignored',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('each problems-only condition qualifies independently', () => {
  const cases = [
    ['non-zero code', event('case', { code: 3 })],
    ['timed out', event('case', { timedOut: true })],
    ['stalled', event('case', { stage: 'executor', type: 'stalled', code: 0 })],
    ['ISSUES verdict', event('case', { verdict: 'ISSUES' })],
    ['missing verdict source', event('case', {
      verdict: 'NO_BLOCKERS', verdictSource: 'none',
    })],
  ];
  for (const [name, candidate] of cases) {
    assert.equal(isProblemEvent(candidate), true, name);
    const withoutThisCondition = event('case', {
      verdict: 'NO_BLOCKERS', verdictSource: 'result', timedOut: false,
    });
    assert.equal(isProblemEvent(withoutThisCondition), false, `${name} positive control`);
  }
});

const queryProblemCases = [
  ['non-zero code', 'code', { code: 3 }],
  ['timedOut', 'timed-out', { timedOut: true }],
  ['stalled event', 'stalled', { stage: 'executor', type: 'stalled' }],
  ['ISSUES verdict', 'issues', { verdict: 'ISSUES' }],
  ['verdictSource none', 'no-verdict-source', { verdictSource: 'none' }],
];

for (const [name, slug, problemFields] of queryProblemCases) {
  test(`queryLogs problems-only isolates ${name} from clean neighbors`, () => {
    const root = makeRoot(`ccc-log-query-${slug}`);
    const runId = `query-${slug}`;
    const cleanFields = {
      code: 0,
      timedOut: false,
      verdict: 'NO_BLOCKERS',
      verdictSource: 'result',
    };
    const cleanBefore = event(runId, {
      ...cleanFields,
      ts: '2026-08-15T00:00:00.000Z',
      fixture: 'clean-before',
    });
    const qualifying = event(runId, {
      ...cleanFields,
      ts: '2026-08-15T00:00:01.000Z',
      fixture: `problem-${slug}`,
      ...problemFields,
    });
    const cleanAfter = event(runId, {
      ...cleanFields,
      ts: '2026-08-15T00:00:02.000Z',
      fixture: 'clean-after',
    });
    const runDirectory = writeRun(root, runId, [cleanBefore, qualifying, cleanAfter]);
    try {
      const rows = queryLogs({ runDirectory, problemsOnly: true, collapse: false });
      assert.deepEqual(
        rows.map((row) => row.event),
        [qualifying],
        `${name} must be the only row returned from its otherwise-clean stream`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('collapsing states the count and preserves exactly every collapsed record', () => {
  const records = [1, 2, 3].map((item) => ({
    ts: `2026-08-15T00:00:0${item}.000Z`, runId: 'collapse-run',
    stage: 'executor', type: 'item_completed', itemType: `item-${item}`,
  }));
  const rows = records.map((record) => ({
    ...record, kind: 'event', sourceRunId: record.runId, detail: `item=${record.itemType}`,
    event: record,
  }));
  const collapsed = collapseLogRows(rows);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].kind, 'group');
  assert.equal(collapsed[0].count, 3);
  assert.deepEqual(collapsed[0].records, records);
  assert.deepEqual(collapsed[0].rows, rows,
    'expanding the group yields the complete event rows without projection or loss');
});

test('scratch queries collect and chronologically order records from every run', () => {
  const root = makeRoot('ccc-log-cross-run');
  const later = event('run-a', {
    ts: '2026-08-15T00:00:02.000Z', file: 'from-a.js', tokens: { inputTokens: 4 },
  });
  const earlier = event('run-b', {
    ts: '2026-08-15T00:00:01.000Z', file: 'from-b.js', code: 2,
  });
  const untimed = event('run-b', { ts: 'not-a-time', file: 'untimed.js' });
  writeRun(root, 'run-a', [later]);
  writeRun(root, 'run-b', [earlier, untimed], '{"partial":');
  mkdirSync(join(root, 'run-without-stream'));
  try {
    const rows = queryLogs({ scratchRoot: root, collapse: false });
    assert.deepEqual(rows.map((row) => row.event), [earlier, later, untimed]);
    assert.deepEqual(rows.map((row) => row.runId), ['run-b', 'run-a', 'run-b']);
    assert.equal(rows[0].file, 'from-b.js');
    assert.deepEqual(rows[1].tokens, { inputTokens: 4 },
      'raw fields remain available instead of being reduced to the timeline projection');
    assert.equal(rows[1].detail, 'npm test code=0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a single run can be selected and an unknown run is explicit', () => {
  const root = makeRoot('ccc-log-selector');
  writeRun(root, 'one', [event('one')]);
  writeRun(root, 'two', [event('two')]);
  try {
    const selected = queryLogs({ scratchRoot: root, runId: 'two', collapse: false });
    assert.deepEqual(selected.map((row) => row.runId), ['two']);
    assert.throws(
      () => queryLogs({ scratchRoot: root, runId: 'missing' }),
      (error) => error instanceof LogRunNotFoundError && error.code === 'RUN_NOT_FOUND',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
