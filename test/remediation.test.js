import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixFailedCheck, remediationCommandText } from '../src/remediation.js';

function check(autoFixable) {
  return {
    id: autoFixable ? 'automatic' : 'manual',
    name: autoFixable ? 'Automatic check' : 'Manual check',
    remediation: {
      prose: 'registry-owned instruction',
      command: { type: 'spawn', binary: 'fake-installer', args: ['install', 'tool'] },
      autoFixable,
    },
  };
}

const failure = { status: 'FAIL', detail: 'missing', remediationKey: 'default' };

test('fix consumer executes only an auto-fixable registry command', async () => {
  const invocations = [];
  const executor = async (command) => {
    invocations.push(command);
    return { code: 0, stdout: '', stderr: '' };
  };

  const manual = await fixFailedCheck({
    check: check(false), outcome: failure, consent: async () => true, executor,
  });
  assert.equal(manual.status, 'report-only');
  assert.equal(invocations.length, 0,
    'a failing non-auto-fixable check must never reach the observable executor');

  const automatic = await fixFailedCheck({
    check: check(true), outcome: failure, consent: async () => true, executor,
  });
  assert.equal(automatic.status, 'succeeded');
  assert.equal(invocations.length, 1,
    'positive control: the same recorder observes an allowed automatic execution');
  assert.deepEqual(invocations[0], check(true).remediation.command);
});

test('fix consumer requires recorded affirmative consent before execution', async () => {
  const invocations = [];
  const prompts = [];
  const writes = [];
  const executor = async (command) => {
    invocations.push(command);
    return { code: 0 };
  };
  const candidate = check(true);

  const refused = await fixFailedCheck({
    check: candidate,
    outcome: failure,
    consent: async (prompt) => { prompts.push(prompt); return 'no'; },
    executor,
    write: (text) => writes.push(text),
  });
  assert.equal(refused.status, 'declined');
  assert.equal(invocations.length, 0);
  assert.equal(prompts.length, 1, 'the refusal must be recorded on the live consent path');
  assert.ok(writes.join('').includes(remediationCommandText(candidate.remediation.command)));

  const accepted = await fixFailedCheck({
    check: candidate,
    outcome: failure,
    consent: async (prompt) => { prompts.push(prompt); return 'yes'; },
    executor,
  });
  assert.equal(accepted.status, 'succeeded');
  assert.equal(invocations.length, 1,
    'positive control: affirmative consent on the same path reaches the executor');
  assert.equal(prompts.length, 2);
});
