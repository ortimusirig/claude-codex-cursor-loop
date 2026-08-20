import {
  existsSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_ARTIFACTS } from './artifacts.js';
import { spawnCapture } from './spawn.js';
import { countTestPaths } from './merge-test-count.js';

export const MERGE_LEDGER_FILENAME = 'uro-merge-resolutions.json';
export const TEST_COUNT_FLOOR_BIN = 'ccc-test-count-floor';

const floorScript = fileURLToPath(new URL('./merge-test-count.js', import.meta.url));

async function git(cwd, ...args) {
  const result = await spawnCapture('git', ['-C', cwd, ...args]);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function gitPaths(repository, commit) {
  const output = await git(repository, 'ls-tree', '-r', '-z', '--name-only', commit);
  return output.split('\0').filter(Boolean);
}

export async function deriveMergeContext({ repository, parents }) {
  if (!Array.isArray(parents) || parents.length < 2) {
    throw new TypeError('a merge context requires at least two parents');
  }
  if (parents.some((parent) => typeof parent.commit !== 'string' || parent.commit === '')) {
    throw new TypeError('every merge parent must have a commit');
  }
  const commits = parents.map((parent) => parent.commit);
  const mergeBase = (await git(repository, 'merge-base', '--octopus', ...commits)).trim();
  const baseline = countTestPaths(await gitPaths(repository, mergeBase));
  const parentCounts = [];
  for (const parent of parents) {
    parentCounts.push({
      unitId: parent.unitId,
      count: countTestPaths(await gitPaths(repository, parent.commit)),
    });
  }
  const required = parentCounts.reduce((sum, parent) => sum + parent.count, 0)
    - baseline * (parents.length - 1);
  return {
    parents: parents.map((parent) => ({ ...parent })),
    parentOrder: parents.map((parent) => parent.unitId),
    mergeBase,
    testCounts: {
      baseline,
      parents: parentCounts,
      required: Math.max(0, required),
      source: 'test-files',
    },
  };
}

export function withObservedTestCounts(merge, { baseline, parents }) {
  if (!Number.isSafeInteger(baseline) || baseline < 0
    || !Array.isArray(parents) || parents.length !== merge.parents.length
    || parents.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    return merge;
  }
  const parentCounts = merge.parents.map((parent, index) => ({
    unitId: parent.unitId,
    count: parents[index],
  }));
  const required = parents.reduce((sum, count) => sum + count, 0)
    - baseline * (parents.length - 1);
  return {
    ...merge,
    testCounts: {
      baseline,
      parents: parentCounts,
      required: Math.max(0, required),
      source: 'gate-output',
    },
  };
}

export function testCountFloorCommand(required) {
  if (!Number.isSafeInteger(required) || required < 0) {
    throw new TypeError('test-count floor must be a non-negative safe integer');
  }
  return {
    bin: process.execPath,
    args: [floorScript, String(required)],
    harness: TEST_COUNT_FLOOR_BIN,
  };
}

async function mergeHeadExists(cwd) {
  const result = await spawnCapture('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
  return result.code === 0;
}

async function unmergedPaths(cwd) {
  const result = await spawnCapture('git', [
    '-C', cwd, 'diff', '--name-only', '--diff-filter=U', '-z',
  ]);
  if (result.code !== 0) throw new Error(`cannot inspect merge conflicts: ${result.stderr.trim()}`);
  return result.stdout.split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/')).sort();
}

async function stageMergeChanges(cwd) {
  const add = await spawnCapture('git', [
    '-C', cwd, 'add', '-A', '--', '.',
    ...HARNESS_ARTIFACTS.map((name) => `:(exclude)${name}`),
  ]);
  if (add.code !== 0) throw new Error(`cannot stage merge resolution: ${add.stderr.trim()}`);
}

async function commitMerge(cwd, message) {
  await stageMergeChanges(cwd);
  await git(
    cwd,
    '-c', 'user.email=ccc@local',
    '-c', 'user.name=ccc',
    'commit', '--no-verify', '-m', message,
  );
}

export async function advanceMerge({ cwd, parents, nextParentIndex = 1, unitId }) {
  for (let index = nextParentIndex; index < parents.length; index++) {
    const parent = parents[index];
    const result = await spawnCapture('git', [
      '-C', cwd,
      '-c', 'user.email=ccc@local',
      '-c', 'user.name=ccc',
      'merge', '--no-commit', '--no-ff', '--no-edit', parent.commit,
    ]);
    if (result.code !== 0) {
      const paths = await unmergedPaths(cwd);
      if (paths.length === 0) {
        throw new Error(
          `git merge of parent "${parent.unitId}" failed without conflict paths: ${result.stderr.trim()}`,
        );
      }
      return {
        complete: false,
        nextParentIndex: index,
        conflict: { parentUnitId: parent.unitId, parentCommit: parent.commit, paths },
      };
    }
    if (await mergeHeadExists(cwd)) {
      await commitMerge(cwd, `merge ${parent.unitId} into ${unitId}`);
    }
  }
  return { complete: true, nextParentIndex: parents.length, conflict: null };
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function readMergeLedger({ cwd, conflict, executorResult }) {
  const ledgerPath = join(cwd, MERGE_LEDGER_FILENAME);
  let raw = executorResult?.mergeResolution;
  if (raw === undefined && existsSync(ledgerPath)) {
    try {
      raw = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    } catch (error) {
      return { ok: false, reason: `invalid ${MERGE_LEDGER_FILENAME}: ${error.message}` };
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `missing ${MERGE_LEDGER_FILENAME}` };
  }
  const status = raw.status ?? raw.outcome;
  if (status !== 'resolved' && status !== 'conflicting-intent') {
    return { ok: false, reason: `${MERGE_LEDGER_FILENAME} status must be resolved or conflicting-intent` };
  }
  if (!Array.isArray(raw.resolutions)) {
    return { ok: false, reason: `${MERGE_LEDGER_FILENAME} resolutions must be an array` };
  }
  const normalized = raw.resolutions.map((entry) => ({
    path: typeof entry?.path === 'string' ? entry.path.replaceAll('\\', '/') : entry?.path,
    chosen: entry?.chosen,
    reason: entry?.reason,
  }));
  for (const path of conflict.paths) {
    const entry = normalized.find((candidate) => candidate.path === path);
    if (!entry || !nonEmpty(entry.chosen) || !nonEmpty(entry.reason)) {
      return {
        ok: false,
        reason: `${MERGE_LEDGER_FILENAME} must record a chosen resolution and reason for ${path}`,
      };
    }
  }
  return {
    ok: true,
    status,
    resolutions: normalized.map((entry) => ({
      ...entry,
      parentUnitId: conflict.parentUnitId,
    })),
  };
}

export function clearMergeLedger(cwd) {
  const path = join(cwd, MERGE_LEDGER_FILENAME);
  if (existsSync(path)) unlinkSync(path);
}

export async function concludeConflict({ cwd, conflict, unitId }) {
  await stageMergeChanges(cwd);
  const remaining = await unmergedPaths(cwd);
  if (remaining.length > 0) {
    return { ok: false, reason: `unresolved merge paths remain: ${remaining.join(', ')}` };
  }
  if (await mergeHeadExists(cwd)) {
    await commitMerge(cwd, `resolve ${conflict.parentUnitId} into ${unitId}`);
    return { ok: true };
  }
  const ancestor = await spawnCapture('git', [
    '-C', cwd, 'merge-base', '--is-ancestor', conflict.parentCommit, 'HEAD',
  ]);
  if (ancestor.code !== 0) {
    return { ok: false, reason: `parent ${conflict.parentUnitId} is not incorporated` };
  }
  const staged = await spawnCapture('git', ['-C', cwd, 'diff', '--cached', '--quiet', 'HEAD']);
  if (staged.code !== 0 && staged.code !== 1) {
    throw new Error(`cannot inspect staged merge repair: ${staged.stderr.trim()}`);
  }
  if (staged.code === 1) {
    await commitMerge(cwd, `complete ${conflict.parentUnitId} repair in ${unitId}`);
  }
  return { ok: true };
}

function parentLine(parent, index) {
  return `${index + 1}. ${parent.unitId} — branch ${parent.branch}; commit ${parent.commit}`;
}

export function buildMergeTask(plan, merge, conflict = null) {
  const lines = [
    plan,
    '',
    '## Merge-unit requirements',
    '',
    'This is a full merge loop run. Preserve the behavior implemented by every parent below.',
    'Add at least one new test that exercises the interaction (the seam) between the parent changes.',
    'The intent verifier must confirm that every parent behavior survives and that the seam is tested.',
    '',
    `Deterministic merge base: ${merge.mergeBase}`,
    'Deterministic parent order:',
    ...merge.parents.map(parentLine),
    '',
    `Test-count floor: ${merge.testCounts.required} `
      + `(parents ${merge.testCounts.parents.map((p) => `${p.unitId}=${p.count}`).join(', ')}; `
      + `baseline=${merge.testCounts.baseline}).`,
  ];
  if (conflict) {
    lines.push(
      '',
      '## Merge conflict repair',
      '',
      `The merge of parent ${conflict.parentUnitId} (${conflict.parentCommit}) conflicts in:`,
      ...conflict.paths.map((path) => `- ${path}`),
      '',
      'Resolve the conflicted tree without discarding either parent\'s behavior. If the parent intents',
      'genuinely conflict, do not guess: leave the conflict for a human and report conflicting-intent.',
      `For every path above, write the chosen resolution and reason to ${MERGE_LEDGER_FILENAME}.`,
      'Use this exact JSON shape:',
      '',
      '```json',
      '{',
      '  "status": "resolved",',
      '  "resolutions": [',
      '    { "path": "path/from/list", "chosen": "what was chosen", "reason": "why" }',
      '  ]',
      '}',
      '```',
      '',
      'Use status "conflicting-intent" when human direction is needed; still include one ledger entry',
      'per conflicting path, with chosen explaining what was left unresolved and reason explaining',
      'the intent conflict.',
    );
  }
  return lines.join('\n');
}
