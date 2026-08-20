import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnv, resetDeprecationWarnings } from '../src/env-compat.js';

test('URO_ wins when both prefixes are set', () => {
  resetDeprecationWarnings();
  const warnings = [];
  const value = readEnv(
    { URO_SCRATCH_ROOT: 'C:/uro/w', CCC_SCRATCH_ROOT: 'C:/ccc/w' },
    'SCRATCH_ROOT',
    { warn: (m) => warnings.push(m) },
  );
  assert.equal(value, 'C:/uro/w');
  assert.deepEqual(warnings, [], 'no deprecation warning when the current name is set');
});

test('an aliased variable falls back to CCC_ and warns once', () => {
  resetDeprecationWarnings();
  const warnings = [];
  const env = { CCC_PUBLISH_BLOCKLIST: 'C:/uro/blocklist.txt' };
  const warn = (m) => warnings.push(m);
  assert.equal(readEnv(env, 'PUBLISH_BLOCKLIST', { warn }), 'C:/uro/blocklist.txt');
  assert.equal(readEnv(env, 'PUBLISH_BLOCKLIST', { warn }), 'C:/uro/blocklist.txt');
  assert.equal(warnings.length, 1, 'the deprecation warning is emitted once per variable');
  assert.match(warnings[0], /CCC_PUBLISH_BLOCKLIST/);
  assert.match(warnings[0], /URO_PUBLISH_BLOCKLIST/);
});

test('a non-aliased variable does not fall back to CCC_', () => {
  // Positive control: proves the alias list is consulted rather than every name
  // falling back, which would make the previous assertion pass vacuously.
  resetDeprecationWarnings();
  const warnings = [];
  const value = readEnv(
    { CCC_TEST_SCRATCH_ROOT: 'C:/legacy' },
    'TEST_SCRATCH_ROOT',
    { warn: (m) => warnings.push(m) },
  );
  assert.equal(value, undefined, 'internal variables have no compatibility alias');
  assert.deepEqual(warnings, []);
});

test('returns undefined when neither prefix is set', () => {
  resetDeprecationWarnings();
  assert.equal(readEnv({}, 'SCRATCH_ROOT', { warn: () => {} }), undefined);
});
