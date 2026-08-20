// Variables a user sets themselves. Only these keep a deprecated CCC_ alias; every other
// CCC_ name was internal or test-only and is renamed outright.
const ALIASED = Object.freeze(new Set([
  'SCRATCH_ROOT',
  'PUBLISH_BLOCKLIST',
  'NO_DASHBOARD',
  'EXECUTOR_TIMEOUT_MS',
  'GATE_TIMEOUT_MS',
  'VERIFIER_TIMEOUT_MS',
  'STALL_POLICY',
  'STALL_RESTARTS',
  'STALL_THRESHOLD_MS',
]));

const warned = new Set();

export function resetDeprecationWarnings() {
  warned.clear();
}

export function readEnv(env, suffix, { warn = console.warn } = {}) {
  const current = env?.[`URO_${suffix}`];
  if (current !== undefined) return current;
  if (!ALIASED.has(suffix)) return undefined;

  const legacy = env?.[`CCC_${suffix}`];
  if (legacy === undefined) return undefined;

  if (!warned.has(suffix)) {
    warned.add(suffix);
    warn(`CCC_${suffix} is deprecated; rename it to URO_${suffix}`);
  }
  return legacy;
}
