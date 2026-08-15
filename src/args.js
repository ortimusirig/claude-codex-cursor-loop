import { parseArgs as nodeParseArgs } from 'node:util';

const EXECUTOR_EFFORTS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);

export function parseArgs(argv) {
  const command = argv[0];
  if (command === 'status') {
    if (argv.length !== 2 || !argv[1]) {
      throw new Error('usage: status <run-directory>');
    }
    return { command, runDirectory: argv[1] };
  }
  if (command === 'dashboard') {
    const { values, positionals } = nodeParseArgs({
      args: argv.slice(1),
      options: {
        port: { type: 'string' },
        run: { type: 'string' },
        'scratch-root': { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 1) {
      throw new Error('usage: dashboard [run-directory] [--scratch-root <directory>] [--port <port>]');
    }
    if (positionals[0] && values.run) {
      throw new Error('dashboard run directory must be positional or --run, not both');
    }
    const runDirectory = values.run ?? positionals[0];
    if (runDirectory && values['scratch-root']) {
      throw new Error('dashboard accepts either a run directory or --scratch-root, not both');
    }
    const parsed = { command };
    if (runDirectory) parsed.runDirectory = runDirectory;
    if (values['scratch-root']) parsed.scratchRoot = values['scratch-root'];
    if (values.port !== undefined) {
      const port = Number(values.port);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid dashboard port: ${values.port}; expected an integer from 0 to 65535`);
      }
      parsed.port = port;
    }
    return parsed;
  }
  if (command !== 'run') throw new Error(`unknown command: ${command ?? '(none)'}`);
  const { values } = nodeParseArgs({
    args: argv.slice(1),
    options: {
      task: { type: 'string' },
      target: { type: 'string' },
      gate: { type: 'string' },
      'gate-retries': { type: 'string' },
      'executor-model': { type: 'string' },
      'executor-effort': { type: 'string' },
      'verifier-model': { type: 'string' },
      quiet: { type: 'boolean' },
    },
    strict: true,
  });
  for (const req of ['task', 'target', 'gate']) {
    if (!values[req]) throw new Error(`missing required option: --${req}`);
  }
  const clampInt = (v, def, lo, hi) => {
    if (v === undefined) return def;
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      throw new Error(`value out of range [${lo}-${hi}]: ${v}`);
    }
    return n;
  };
  const executorEffort = values['executor-effort'];
  if (executorEffort !== undefined && !EXECUTOR_EFFORTS.has(executorEffort)) {
    throw new Error(`invalid --executor-effort: ${executorEffort}; expected one of: ${
      [...EXECUTOR_EFFORTS].join(', ')}`);
  }
  const parsed = {
    command,
    task: values.task,
    target: values.target,
    gate: values.gate,
    gateRetries: clampInt(values['gate-retries'], 2, 0, 3),
    executorModel: values['executor-model'],
    executorEffort,
    verifierModel: values['verifier-model'],
  };
  if (values.quiet) parsed.quiet = true;
  return parsed;
}
