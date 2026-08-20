import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  DEFAULT_GATE_TIMEOUT_MS,
  DEFAULT_VERIFIER_TIMEOUT_MS,
  resolveStageTimeouts,
} from '../src/timeouts.js';

test('stage timeout defaults are 30m executor, 10m verifier, and 60m gate', () => {
  assert.deepEqual(resolveStageTimeouts({}), {
    executor: DEFAULT_EXECUTOR_TIMEOUT_MS,
    verifier: DEFAULT_VERIFIER_TIMEOUT_MS,
    gate: DEFAULT_GATE_TIMEOUT_MS,
  });
  assert.equal(DEFAULT_EXECUTOR_TIMEOUT_MS, 30 * 60 * 1000);
  assert.equal(DEFAULT_VERIFIER_TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(DEFAULT_GATE_TIMEOUT_MS, 60 * 60 * 1000);
});

test('each stage timeout is overridable by its URO_ environment variable', () => {
  assert.deepEqual(resolveStageTimeouts({
    URO_EXECUTOR_TIMEOUT_MS: '101',
    URO_VERIFIER_TIMEOUT_MS: '202',
    URO_GATE_TIMEOUT_MS: '303',
  }), { executor: 101, verifier: 202, gate: 303 });
});

test('invalid configured timeouts fail loudly', () => {
  assert.throws(() => resolveStageTimeouts({ URO_EXECUTOR_TIMEOUT_MS: '0' }),
    /URO_EXECUTOR_TIMEOUT_MS/);
  assert.throws(() => resolveStageTimeouts({ URO_GATE_TIMEOUT_MS: 'tomorrow' }),
    /URO_GATE_TIMEOUT_MS/);
});
