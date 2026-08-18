import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { scaffold } from '../src/init.js';
import { runSetup } from '../src/setup.js';

function fakeCheck({ id = 'fake-check', autoFixable = true, probe }) {
  return {
    id,
    phase: 'prerequisite',
    kind: 'required',
    name: id,
    remediation: {
      prose: `instruction for ${id}`,
      command: { type: 'spawn', binary: 'fake-installer', args: [id] },
      autoFixable,
    },
    probe,
  };
}

function snapshot(directory, base = directory, entries = []) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const rel = relative(base, path).replaceAll('\\', '/');
    if (statSync(path).isDirectory()) {
      entries.push(`${rel}/`);
      snapshot(path, base, entries);
    } else {
      entries.push(`${rel}:${readFileSync(path).toString('hex')}`);
    }
  }
  return entries;
}

function successfulFacts(scratchRoot) {
  return {
    outcome: 'review-ready',
    gateStatus: 'passed',
    verdict: 'NO_BLOCKERS',
    dir: join(scratchRoot, 'setup-run-fixed', 'w'),
    iterations: [{ changedFiles: ['hello-from-ccc.txt'] }],
  };
}

test('setup terminates when one automatic fix never takes effect', async () => {
  let probes = 0;
  let executions = 0;
  const neverFixed = fakeCheck({
    probe: async () => {
      probes++;
      return { status: 'FAIL', detail: 'still unavailable', remediationKey: 'default' };
    },
  });
  const result = await runSetup({
    scratchRoot: join(tmpdir(), 'ccc-setup-bounded-test'),
    checks: [neverFixed],
    consent: async () => true,
    wait: async () => '',
    remediationExecutor: async () => { executions++; return { code: 0 }; },
  });

  assert.equal(result.status, 'prerequisite-incomplete');
  assert.equal(executions, 1, 'each check has exactly one automatic attempt budget');
  assert.equal(probes, 3,
    'positive finite bound: initial probe, post-fix probe, and one post-instruction probe');
});

test('a successful install still absent from PATH becomes restart-required without retry', async () => {
  let executions = 0;
  const notVisible = fakeCheck({
    id: 'path-tool',
    probe: async () => ({
      status: 'FAIL', detail: 'fake-tool was not found on PATH', remediationKey: 'default',
    }),
  });
  const result = await runSetup({
    scratchRoot: join(tmpdir(), 'ccc-setup-restart-test'),
    checks: [notVisible],
    consent: async () => true,
    wait: async () => { throw new Error('restart-required must not wait or loop'); },
    remediationExecutor: async () => { executions++; return { code: 0 }; },
  });
  assert.equal(result.status, 'restart-required');
  assert.equal(executions, 1);
});

test('declining one fix remains report-only and continues to later checks', async () => {
  const calls = [];
  const checks = [
    fakeCheck({ id: 'declined', probe: async () => ({
      status: 'FAIL', detail: 'missing', remediationKey: 'default',
    }) }),
    fakeCheck({ id: 'accepted', probe: async () => ({
      status: 'FAIL', detail: 'missing', remediationKey: 'default',
    }) }),
  ];
  await runSetup({
    scratchRoot: join(tmpdir(), 'ccc-setup-decline-test'),
    checks,
    consent: async (_prompt, { check }) => check.id === 'accepted',
    wait: async () => false,
    remediationExecutor: async (command) => { calls.push(command.args[0]); return { code: 1 }; },
  });
  assert.deepEqual(calls, ['accepted'],
    'the declined check is never executed while the later affirmative check still is');
});

test('setup scaffolding and demo stay inside scratch and leave the operator directory unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-setup-containment-'));
  const operatorDirectory = join(root, 'operator');
  const scratchRoot = join(root, 'scratch');
  mkdirSync(operatorDirectory);
  writeFileSync(join(operatorDirectory, 'sentinel.txt'), 'unchanged\n');
  const before = snapshot(operatorDirectory);
  const green = fakeCheck({
    autoFixable: false,
    probe: async () => ({ status: 'PASS', detail: 'ready' }),
  });
  try {
    const result = await runSetup({
      scratchRoot,
      operatorDirectory,
      checks: [green],
      consent: async () => { throw new Error('green checks do not ask for consent'); },
      wait: async () => { throw new Error('green checks do not wait'); },
      scaffolder: scaffold,
      repositoryInitializer: async () => {},
      demoRunner: async () => successfulFacts(scratchRoot),
      id: () => 'fixed',
    });
    assert.equal(result.status, 'complete');
    assert.deepEqual(snapshot(operatorDirectory), before);
    assert.ok(result.demoDirectory.startsWith(scratchRoot));

    writeFileSync(join(operatorDirectory, 'positive-control.txt'), 'detected\n');
    assert.notDeepEqual(snapshot(operatorDirectory), before,
      'positive control: the same snapshot detects an added working-directory file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a gate-failed demo is distinct from a prerequisite failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-setup-demo-failure-'));
  const scratchRoot = join(root, 'scratch');
  const green = fakeCheck({
    autoFixable: false,
    probe: async () => ({ status: 'PASS', detail: 'ready' }),
  });
  try {
    const result = await runSetup({
      scratchRoot,
      checks: [green],
      consent: async () => true,
      wait: async () => '',
      repositoryInitializer: async () => {},
      demoRunner: async () => ({
        ...successfulFacts(scratchRoot),
        outcome: 'gate-failed',
        gateStatus: 'failed',
      }),
      id: () => 'gate-failure',
    });
    assert.equal(result.status, 'demo-failed');
    assert.ok(result.outcomes.every(({ outcome }) => outcome.status === 'PASS'),
      'positive control: every prerequisite was green before the demo failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
