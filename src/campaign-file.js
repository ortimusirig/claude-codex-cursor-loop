import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_ROUNDS,
  DEFAULT_TOKEN_BUDGET,
  MAX_CONCURRENCY,
  MAX_ROUNDS,
  normalizeUnits,
  positiveInteger,
  validateCandidateSet,
  validateDependencyGraph,
} from './campaign-validation.js';
import { UNIT_KINDS } from './events.js';

const TOP_LEVEL_KEYS = new Set([
  'target', 'gate', 'gateRetries', 'concurrency', 'tokenBudget', 'rounds',
  'executorModel', 'executorEffort', 'verifierModel', 'units',
]);
const UNIT_KEYS = new Set([
  'id', 'task', 'dependsOn', 'perspective', 'round', 'unitKind',
]);
const UNIT_KIND_SET = new Set(UNIT_KINDS);
const EXECUTOR_EFFORTS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function declaredPath(value, field, directory) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`campaign "${field}" must be a non-empty path string`);
  }
  return isAbsolute(value) ? value : resolve(directory, value);
}

function unitName(raw, index) {
  return typeof raw?.id === 'string' && raw.id !== ''
    ? `campaign unit "${raw.id}"`
    : `campaign unit at index ${index + 1} (missing id)`;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateTaskPath(taskPath, unitId) {
  if (!existsSync(taskPath)) {
    throw new Error(`campaign unit "${unitId}" task file does not exist: ${taskPath}`);
  }
  let isFile;
  try {
    isFile = statSync(taskPath).isFile();
  } catch (error) {
    throw new Error(`campaign unit "${unitId}" task path cannot be inspected: ${error.message}`);
  }
  if (!isFile) {
    throw new Error(`campaign unit "${unitId}" task path is not a file: ${taskPath}`);
  }
}

function validateKnownKeys(value, allowed, owner) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`${owner} has unknown key "${unknown}"`);
}

function validatePerspectiveDuplicates(units, rounds) {
  const owners = new Map();
  for (let index = 0; index < units.length; index++) {
    const perspective = units[index].perspective;
    if (perspective === undefined) continue;
    const key = `${rounds[index]}\0${perspective.trim().toLocaleLowerCase('en-US')}`;
    const previous = owners.get(key);
    if (previous !== undefined) {
      throw new Error(
        `duplicate candidate perspective "${perspective.trim()}" on `
        + `"${previous}" and "${units[index].unitId}"`,
      );
    }
    owners.set(key, units[index].unitId);
  }
}

function validateEngineRules(tasks, candidateSet, taskRounds, maxRounds) {
  // A global normalization pass preserves the engine's duplicate-id and unit-field rules.
  // Iterative candidate rules are then applied per round, just as runCampaign applies them.
  const normalized = normalizeUnits(tasks, 'candidate', 'campaign-file');
  if (maxRounds > DEFAULT_ROUNDS) {
    for (let round = 1; round <= Math.max(...taskRounds); round++) {
      const roundTasks = tasks.filter((_, index) => taskRounds[index] === round);
      const roundUnits = normalizeUnits(roundTasks, 'candidate', 'campaign-file');
      validateCandidateSet(roundUnits);
      validateDependencyGraph(roundUnits);
    }
    return;
  }
  if (candidateSet) validateCandidateSet(normalized);
  validateDependencyGraph(normalized);
}

/**
 * Load a JSON campaign declaration into the same normalized batch options produced by args.js.
 * This function performs no execution and has no runtime-module dependencies.
 */
export function loadCampaignFile(file) {
  if (typeof file !== 'string' || file === '') {
    throw new TypeError('campaign file must be a non-empty path string');
  }
  const campaignPath = resolve(file);
  let document;
  try {
    document = JSON.parse(readFileSync(campaignPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot load campaign file ${campaignPath}: ${error.message}`);
  }
  if (!isRecord(document)) throw new TypeError('campaign file must contain a JSON object');
  validateKnownKeys(document, TOP_LEVEL_KEYS, 'campaign file');

  const directory = dirname(campaignPath);
  const target = declaredPath(document.target, 'target', directory);
  const gate = declaredPath(document.gate, 'gate', directory);
  if (!Array.isArray(document.units) || document.units.length === 0) {
    throw new TypeError('campaign "units" must be a non-empty array');
  }

  const taskRounds = [];
  const tasks = document.units.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new TypeError(`${unitName(raw, index)} must be a JSON object`);
    }
    const owner = unitName(raw, index);
    validateKnownKeys(raw, UNIT_KEYS, owner);
    if (typeof raw.id !== 'string' || raw.id === '') {
      throw new TypeError(`${owner} must declare a non-empty "id"`);
    }
    if (typeof raw.task !== 'string' || raw.task === '') {
      throw new TypeError(`campaign unit "${raw.id}" must declare a non-empty "task" path`);
    }
    if (raw.dependsOn !== undefined) {
      const parents = Array.isArray(raw.dependsOn) ? raw.dependsOn : [raw.dependsOn];
      if (!((typeof raw.dependsOn === 'string' || Array.isArray(raw.dependsOn))
        && parents.every((parent) => typeof parent === 'string' && parent !== ''))) {
        throw new TypeError(
          `campaign unit "${raw.id}" dependsOn must be a string or an array of non-empty strings`,
        );
      }
    }
    if (raw.perspective !== undefined
      && (typeof raw.perspective !== 'string' || raw.perspective.trim() === '')) {
      throw new TypeError(
        `campaign unit "${raw.id}" perspective must be a non-empty string`,
      );
    }
    const round = raw.round === undefined
      ? DEFAULT_ROUNDS
      : boundedInteger(raw.round, `campaign unit "${raw.id}" round`, 1, MAX_ROUNDS);
    taskRounds.push(round);
    const unitKind = raw.unitKind ?? 'candidate';
    if (!UNIT_KIND_SET.has(unitKind)) {
      throw new TypeError(
        `campaign unit "${raw.id}" has unknown unitKind "${unitKind}"; `
        + `expected one of: ${UNIT_KINDS.join(', ')}`,
      );
    }
    const task = declaredPath(raw.task, `unit "${raw.id}" task`, directory);
    validateTaskPath(task, raw.id);
    const dependsOn = Array.isArray(raw.dependsOn)
      ? (raw.dependsOn.length === 0
        ? undefined
        : raw.dependsOn.length === 1 ? raw.dependsOn[0] : raw.dependsOn)
      : raw.dependsOn;
    return {
      task,
      unitKind,
      unitId: raw.id,
      ...(raw.perspective === undefined ? {} : { perspective: raw.perspective }),
      ...(dependsOn === undefined ? {} : { dependsOn }),
    };
  });

  const maxRounds = document.rounds === undefined
    ? Math.max(...taskRounds)
    : boundedInteger(document.rounds, 'rounds', 1, MAX_ROUNDS);
  const roundTooHigh = taskRounds.findIndex((round) => round > maxRounds);
  if (roundTooHigh !== -1) {
    throw new Error(
      `campaign unit "${tasks[roundTooHigh].unitId}" round ${taskRounds[roundTooHigh]} `
      + `cannot exceed configured rounds ${maxRounds}`,
    );
  }
  if (maxRounds > DEFAULT_ROUNDS) {
    const nonCandidate = tasks.find((unit) => unit.unitKind !== 'candidate');
    if (nonCandidate !== undefined) {
      throw new Error(
        `campaign unit "${nonCandidate.unitId}" is ${nonCandidate.unitKind}; `
        + 'iterative rounds may contain only candidate units',
      );
    }
    const highestDeclaredRound = Math.max(...taskRounds);
    for (let round = 1; round <= highestDeclaredRound; round++) {
      if (!taskRounds.includes(round)) {
        throw new Error(`campaign round declarations must be contiguous; round ${round} is missing`);
      }
    }
  }

  validatePerspectiveDuplicates(tasks, taskRounds);
  const candidateSet = maxRounds > DEFAULT_ROUNDS || (
    tasks.every((unit) => unit.unitKind === 'candidate')
    && tasks.some((unit) => unit.perspective !== undefined)
  );
  validateEngineRules(tasks, candidateSet, taskRounds, maxRounds);

  // Match positional batch parsing: any fan-in is a merge unit, while parent order remains
  // the declaration's order until the engine applies its deterministic graph ordering.
  for (const unit of tasks) {
    if (Array.isArray(unit.dependsOn) && unit.dependsOn.length > 1) unit.unitKind = 'merge';
  }

  const concurrency = document.concurrency ?? DEFAULT_CONCURRENCY;
  positiveInteger(concurrency, 'concurrency', MAX_CONCURRENCY);
  const tokenBudget = document.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  positiveInteger(tokenBudget, 'tokenBudget');
  const gateRetries = document.gateRetries ?? 2;
  boundedInteger(gateRetries, 'gateRetries', 0, 3);
  for (const field of ['executorModel', 'verifierModel']) {
    if (document[field] !== undefined && typeof document[field] !== 'string') {
      throw new TypeError(`${field} must be a string`);
    }
  }
  if (document.executorEffort !== undefined
    && !EXECUTOR_EFFORTS.has(document.executorEffort)) {
    throw new Error(
      `invalid executorEffort: ${document.executorEffort}; expected one of: `
      + [...EXECUTOR_EFFORTS].join(', '),
    );
  }

  const loaded = {
    tasks,
    candidateSet,
    target,
    gate,
    gateRetries,
    executorModel: document.executorModel,
    executorEffort: document.executorEffort,
    verifierModel: document.verifierModel,
    concurrency,
    tokenBudget,
  };
  if (maxRounds > DEFAULT_ROUNDS) {
    const highestDeclaredRound = Math.max(...taskRounds);
    loaded.maxRounds = maxRounds;
    loaded.roundPlans = Array.from({ length: highestDeclaredRound }, (_, roundIndex) => (
      tasks.filter((_, taskIndex) => taskRounds[taskIndex] === roundIndex + 1)
    ));
  }
  return loaded;
}
