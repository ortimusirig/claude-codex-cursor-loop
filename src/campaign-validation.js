import { UNIT_KINDS } from './events.js';

export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 16;
export const DEFAULT_TOKEN_BUDGET = 12_500_000;
export const DEFAULT_ROUNDS = 1;
export const MAX_ROUNDS = 3;
export const CAMPAIGN_SHAPES = Object.freeze([
  'task-set', 'candidate-set', 'iterative-candidate-set',
]);

const KINDS = new Set(UNIT_KINDS);

export function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function declaredParents(raw, unitId) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const parents = [];
  for (const field of ['dependsOn', 'dependencies']) {
    if (!Object.hasOwn(raw, field) || raw[field] === undefined || raw[field] === null) continue;
    if (Array.isArray(raw[field])) parents.push(...raw[field]);
    else parents.push(raw[field]);
  }
  for (const parent of parents) {
    if (typeof parent !== 'string' || parent === '') {
      throw new TypeError(`campaign unit "${unitId}" dependency must name a non-empty unitId`);
    }
  }
  const duplicate = parents.find((parent, index) => parents.indexOf(parent) !== index);
  if (duplicate !== undefined) {
    throw new Error(`campaign unit "${unitId}" declares duplicate parent "${duplicate}"`);
  }
  return parents;
}

export function validateDependencyGraph(units) {
  const byId = new Map(units.map((unit) => [unit.unitId, unit]));
  for (const unit of units) {
    for (const parent of unit.parents) {
      if (parent === unit.unitId) {
        throw new Error(`campaign unit "${unit.unitId}" cannot depend on itself`);
      }
      if (!byId.has(parent)) {
        throw new Error(
          `campaign unit "${unit.unitId}" depends on unknown unit "${parent}"`,
        );
      }
    }
    // Graph declaration order, not completion timing or caller array order, defines every
    // fan-in. That makes the primary merge parent and all subsequent merges reproducible.
    unit.parents.sort((a, b) => byId.get(a).index - byId.get(b).index);
    unit.dependsOn = unit.parents.length === 0
      ? undefined
      : unit.parents.length === 1 ? unit.parents[0] : [...unit.parents];
    if (unit.parents.length > 1) unit.unitKind = 'merge';
  }

  const state = new Map();
  const stack = [];
  const visit = (unit) => {
    state.set(unit.unitId, 1);
    stack.push(unit.unitId);
    for (const parent of unit.parents) {
      const parentState = state.get(parent) ?? 0;
      if (parentState === 1) {
        const start = stack.indexOf(parent);
        const cycle = [...stack.slice(start), parent];
        throw new Error(
          `campaign dependency cycle involving units ${cycle.slice(0, -1).join(', ')}: `
          + cycle.join(' -> '),
        );
      }
      if (parentState === 0) visit(byId.get(parent));
    }
    stack.pop();
    state.set(unit.unitId, 2);
  };
  for (const unit of units) {
    if ((state.get(unit.unitId) ?? 0) === 0) visit(unit);
  }
}

export function normalizeUnits(tasks, unitKind, campaignId) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new TypeError('campaign tasks must be a non-empty array');
  }
  const seen = new Set();
  const units = tasks.map((raw, index) => {
    const task = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw.task
      : raw;
    const isObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
    const kind = isObject
      ? (raw.unitKind ?? unitKind)
      : unitKind;
    const unitId = isObject
      ? (raw.unitId ?? raw.runId ?? `${campaignId}-u${String(index + 1).padStart(3, '0')}`)
      : `${campaignId}-u${String(index + 1).padStart(3, '0')}`;
    if (typeof task !== 'string' || task === '') {
      throw new TypeError(`campaign task ${index + 1} must be a non-empty string`);
    }
    if (!KINDS.has(kind)) throw new TypeError(`unknown campaign unit kind: ${kind}`);
    if (typeof unitId !== 'string' || unitId === '') {
      throw new TypeError(`campaign unit ${index + 1} must have a non-empty unitId`);
    }
    if (seen.has(unitId)) throw new TypeError(`duplicate campaign unitId: ${unitId}`);
    seen.add(unitId);
    const baseRef = isObject
      ? raw.baseRef
      : undefined;
    const branch = isObject
      ? (raw.branch ?? raw.branchName)
      : undefined;
    const parents = declaredParents(raw, unitId);
    const perspective = isObject
      ? raw.perspective
      : undefined;
    if (perspective !== undefined && (typeof perspective !== 'string' || perspective.trim() === '')) {
      throw new TypeError(`campaign unit "${unitId}" perspective must be a non-empty string`);
    }
    return {
      index, task, unitKind: kind, unitId, baseRef, branch, parents,
      perspective: perspective?.trim(),
      explicitUnitKind: isObject && Object.hasOwn(raw, 'unitKind'),
    };
  });
  return units;
}

export function validateCandidateSet(units) {
  if (!units.every((unit) => unit.unitKind === 'candidate')) {
    throw new Error('a candidate set may contain only candidate units');
  }
  for (const unit of units) {
    if (unit.perspective === undefined) {
      throw new Error(`candidate "${unit.unitId}" must declare a perspective`);
    }
    if (unit.parents.length > 0) {
      throw new Error(
        `candidate "${unit.unitId}" cannot declare dependencies; candidates are alternatives`,
      );
    }
  }
  const perspectiveOwners = new Map();
  for (const unit of units) {
    const key = unit.perspective.toLocaleLowerCase('en-US');
    const previous = perspectiveOwners.get(key);
    if (previous !== undefined) {
      throw new Error(
        `duplicate candidate perspective "${unit.perspective}" on "${previous}" and "${unit.unitId}"`,
      );
    }
    perspectiveOwners.set(key, unit.unitId);
  }
  const baseRefs = new Set(units.map((unit) => unit.baseRef ?? 'HEAD'));
  if (baseRefs.size !== 1) {
    throw new Error('all candidates must declare the same base ref');
  }
}
