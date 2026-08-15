import { parseArgs as nodeParseArgs } from 'node:util';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_ROUNDS,
  DEFAULT_TOKEN_BUDGET,
  MAX_CONCURRENCY,
  MAX_ROUNDS,
} from './campaign.js';
import { UNIT_KINDS } from './events.js';

const EXECUTOR_EFFORTS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);
const UNIT_KIND_SET = new Set(UNIT_KINDS);

function clampInt(v, def, lo, hi) {
  if (v === undefined) return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new Error(`value out of range [${lo}-${hi}]: ${v}`);
  }
  return n;
}

function strictInt(v, def, lo, hi) {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v)) throw new Error(`value out of range [${lo}-${hi}]: ${v}`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < lo || n > hi) {
    throw new Error(`value out of range [${lo}-${hi}]: ${v}`);
  }
  return n;
}

function validateExecutorEffort(executorEffort) {
  if (executorEffort !== undefined && !EXECUTOR_EFFORTS.has(executorEffort)) {
    throw new Error(`invalid --executor-effort: ${executorEffort}; expected one of: ${
      [...EXECUTOR_EFFORTS].join(', ')}`);
  }
}

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
  if (command !== 'run' && command !== 'batch') {
    throw new Error(`unknown command: ${command ?? '(none)'}`);
  }
  const { values } = nodeParseArgs({
    args: argv.slice(1),
    options: {
      task: { type: 'string', ...(command === 'batch' ? { multiple: true } : {}) },
      target: { type: 'string' },
      gate: { type: 'string' },
      'gate-retries': { type: 'string' },
      'executor-model': { type: 'string' },
      'executor-effort': { type: 'string' },
      'verifier-model': { type: 'string' },
      ...(command === 'batch' ? {
        concurrency: { type: 'string' },
        'token-budget': { type: 'string' },
        rounds: { type: 'string' },
        round: { type: 'string', multiple: true },
        'unit-kind': { type: 'string', multiple: true },
        'unit-id': { type: 'string', multiple: true },
        perspective: { type: 'string', multiple: true },
        'depends-on': { type: 'string', multiple: true },
      } : {}),
      quiet: { type: 'boolean' },
    },
    strict: true,
  });
  for (const req of ['task', 'target', 'gate']) {
    if (!values[req]) throw new Error(`missing required option: --${req}`);
  }
  const executorEffort = values['executor-effort'];
  validateExecutorEffort(executorEffort);
  if (command === 'run') {
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

  const tasks = values.task;
  let maxRounds = strictInt(values.rounds, DEFAULT_ROUNDS, 1, MAX_ROUNDS);
  const rawTaskRounds = values.round;
  if (rawTaskRounds !== undefined && rawTaskRounds.length !== tasks.length) {
    throw new Error('--round must be given once per --task');
  }
  const taskRounds = rawTaskRounds?.map((value) => (
    strictInt(value, undefined, 1, MAX_ROUNDS)
  ));
  if (values.rounds === undefined && taskRounds !== undefined) {
    maxRounds = Math.max(...taskRounds);
  }
  if (taskRounds?.some((value) => value > maxRounds)) {
    throw new Error(`--round cannot exceed configured --rounds ${maxRounds}`);
  }
  const rawKinds = values['unit-kind'] ?? ['candidate'];
  for (const kind of rawKinds) {
    if (!UNIT_KIND_SET.has(kind)) {
      throw new Error(`invalid --unit-kind: ${kind}; expected one of: ${UNIT_KINDS.join(', ')}`);
    }
  }
  if (rawKinds.length !== 1 && rawKinds.length !== tasks.length) {
    throw new Error('--unit-kind must be given once for all tasks or once per --task');
  }
  if (maxRounds > 1 && !rawKinds.every((kind) => kind === 'candidate')) {
    throw new Error('iterative --rounds may contain only candidate units');
  }
  const unitIds = values['unit-id'];
  if (unitIds !== undefined && unitIds.length !== tasks.length) {
    throw new Error('--unit-id must be given once per --task');
  }
  if (unitIds?.some((unitId) => unitId === '')) {
    throw new Error('--unit-id values must be non-empty');
  }
  if (unitIds && new Set(unitIds).size !== unitIds.length) {
    throw new Error(`duplicate --unit-id: ${unitIds.find((id, index) => unitIds.indexOf(id) !== index)}`);
  }
  const perspectives = values.perspective;
  if (perspectives !== undefined && perspectives.length !== tasks.length) {
    throw new Error('--perspective must be given once per --task');
  }
  if (perspectives?.some((perspective) => perspective.trim() === '')) {
    throw new Error('--perspective values must be non-empty');
  }
  if (perspectives !== undefined) {
    const normalized = perspectives.map((perspective, index) => ({
      value: perspective.trim().toLocaleLowerCase('en-US'),
      round: taskRounds?.[index] ?? 1,
    }));
    const duplicateIndex = normalized.findIndex((candidate, index) => normalized.some(
      (other, otherIndex) => otherIndex < index
        && other.round === candidate.round
        && other.value === candidate.value,
    ));
    if (duplicateIndex !== -1) {
      throw new Error(`duplicate --perspective: ${perspectives[duplicateIndex]}`);
    }
  }
  const rawEdges = values['depends-on'] ?? [];
  if (maxRounds > 1 && perspectives === undefined) {
    throw new Error('iterative --rounds require one --perspective per --task');
  }
  if (maxRounds > 1 && rawEdges.length > 0) {
    throw new Error('iterative candidate rounds cannot declare --depends-on edges');
  }
  if (rawEdges.length > 0 && unitIds === undefined) {
    throw new Error('--depends-on requires one --unit-id per --task');
  }
  const parentsByChild = new Map();
  for (const edge of rawEdges) {
    const separator = edge.indexOf('=');
    const child = separator < 0 ? '' : edge.slice(0, separator);
    const parent = separator < 0 ? '' : edge.slice(separator + 1);
    if (!child || !parent) {
      throw new Error(`invalid --depends-on ${edge}; expected CHILD=PARENT`);
    }
    if (!unitIds.includes(child)) {
      throw new Error(`--depends-on names unknown child unit "${child}"`);
    }
    const parents = parentsByChild.get(child) ?? [];
    parents.push(parent);
    parentsByChild.set(child, parents);
  }
  const campaignTasks = tasks.map((task, index) => {
    const unit = {
      task,
      unitKind: rawKinds.length === 1 ? rawKinds[0] : rawKinds[index],
      ...(unitIds === undefined ? {} : { unitId: unitIds[index] }),
      ...(perspectives === undefined ? {} : { perspective: perspectives[index] }),
    };
    const parents = parentsByChild.get(unit.unitId) ?? [];
    if (parents.length === 1) unit.dependsOn = parents[0];
    else if (parents.length > 1) {
      unit.dependsOn = parents;
      unit.unitKind = 'merge';
    }
    return unit;
  });
  const parsed = {
    command,
    tasks: campaignTasks,
    // Mode A is keyed off --perspective ALONE. `candidate` is the documented default
    // unit kind, so naming it explicitly must not change behaviour: a batch of
    // independent tasks passing `--unit-kind candidate` without perspectives stayed a
    // plain batch before and must stay one now. Including --unit-kind in this condition
    // is redundant when perspectives are present and breaks compatibility when they are
    // absent, because validateCandidateSet then rejects the batch for missing
    // perspectives before any executor runs.
    candidateSet: perspectives !== undefined
      && rawKinds.every((kind) => kind === 'candidate'),
    target: values.target,
    gate: values.gate,
    gateRetries: clampInt(values['gate-retries'], 2, 0, 3),
    executorModel: values['executor-model'],
    executorEffort,
    verifierModel: values['verifier-model'],
    concurrency: strictInt(values.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    tokenBudget: strictInt(
      values['token-budget'], DEFAULT_TOKEN_BUDGET, 1, Number.MAX_SAFE_INTEGER,
    ),
  };
  if (maxRounds > DEFAULT_ROUNDS) {
    const declaredTaskRounds = taskRounds ?? tasks.map(() => 1);
    const highestDeclaredRound = Math.max(...declaredTaskRounds);
    for (let round = 1; round <= highestDeclaredRound; round++) {
      if (!declaredTaskRounds.includes(round)) {
        throw new Error(`--round declarations must be contiguous; round ${round} is missing`);
      }
    }
    parsed.maxRounds = maxRounds;
    parsed.roundPlans = Array.from({ length: highestDeclaredRound }, (_, roundIndex) => (
      campaignTasks.filter((_, taskIndex) => declaredTaskRounds[taskIndex] === roundIndex + 1)
    ));
  }
  if (values.quiet) parsed.quiet = true;
  return parsed;
}
