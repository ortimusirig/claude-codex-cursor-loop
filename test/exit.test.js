import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeFor, EXIT_UNKNOWN_OUTCOME } from '../src/exit.js';

test('only review-ready and no-op are successes', () => {
  assert.equal(exitCodeFor('review-ready'), 0);
  assert.equal(exitCodeFor('no-op'), 0);
});

test('gate-failed is non-zero', () => {
  assert.equal(exitCodeFor('gate-failed'), 1);
});

// The regression this suite exists for: verifier-failed used to exit 0, so a run
// where verification never happened looked like a success to any caller reading
// the exit code.
test('verifier-failed must never exit 0', () => {
  assert.notEqual(exitCodeFor('verifier-failed'), 0);
  assert.equal(exitCodeFor('verifier-failed'), 4);
});

test('an unknown outcome is not treated as success', () => {
  assert.equal(exitCodeFor('something-new'), EXIT_UNKNOWN_OUTCOME);
  assert.notEqual(exitCodeFor(undefined), 0);
});

test('timed-out is explicitly mapped to a non-zero exit', () => {
  assert.equal(exitCodeFor('timed-out'), 5);
});

test('campaign failure and budget exhaustion are explicit non-zero outcomes', () => {
  assert.equal(exitCodeFor('campaign-failed'), 6);
  assert.equal(exitCodeFor('budget-exhausted'), 7);
});
