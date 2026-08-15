export const DEFAULT_EXECUTOR_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_VERIFIER_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_GATE_TIMEOUT_MS = 60 * 60 * 1000;

const MAX_TIMEOUT_MS = 2_147_483_647;

function fromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer number of milliseconds`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`${name} must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
  }
  return value;
}

export function resolveStageTimeouts(env = process.env) {
  return {
    executor: fromEnv(env, 'CCC_EXECUTOR_TIMEOUT_MS', DEFAULT_EXECUTOR_TIMEOUT_MS),
    verifier: fromEnv(env, 'CCC_VERIFIER_TIMEOUT_MS', DEFAULT_VERIFIER_TIMEOUT_MS),
    gate: fromEnv(env, 'CCC_GATE_TIMEOUT_MS', DEFAULT_GATE_TIMEOUT_MS),
  };
}
