import { exitCodeFor } from './exit.js';
import { identifyEvent, reportEvent, UNIT_KINDS } from './events.js';
import { commitCampaignResult, prepareCampaignBase } from './isolation.js';
import { run as realRun } from './run.js';
import { addUsage, EMPTY_USAGE } from './usage.js';

export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 16;
export const DEFAULT_TOKEN_BUDGET = 12_500_000;
export const CAMPAIGN_EVENTS_FILENAME = 'campaign-events.jsonl';

const KINDS = new Set(UNIT_KINDS);

export function countUsageTokens(usage) {
  const normalized = addUsage(EMPTY_USAGE, usage);
  // cachedInputTokens is a subset of inputTokens and reasoningOutputTokens is a subset
  // of outputTokens. Counting either again would overstate campaign consumption.
  return normalized.inputTokens + normalized.outputTokens;
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
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
  if (parents.length > 1) {
    throw new Error(
      `campaign unit "${unitId}" declares more than one parent (${parents.map(String).join(', ')}); `
      + 'fan-in is not supported',
    );
  }
  if (parents.length === 1 && (typeof parents[0] !== 'string' || parents[0] === '')) {
    throw new TypeError(`campaign unit "${unitId}" dependency must name a non-empty unitId`);
  }
  return parents;
}

function validateDependencyGraph(units) {
  const byId = new Map(units.map((unit) => [unit.unitId, unit]));
  for (const unit of units) {
    if (unit.dependsOn === undefined) continue;
    if (unit.dependsOn === unit.unitId) {
      throw new Error(`campaign unit "${unit.unitId}" cannot depend on itself`);
    }
    if (!byId.has(unit.dependsOn)) {
      throw new Error(
        `campaign unit "${unit.unitId}" depends on unknown unit "${unit.dependsOn}"`,
      );
    }
  }

  const state = new Map();
  const stack = [];
  const visit = (unit) => {
    state.set(unit.unitId, 1);
    stack.push(unit.unitId);
    if (unit.dependsOn !== undefined) {
      const parentState = state.get(unit.dependsOn) ?? 0;
      if (parentState === 1) {
        const start = stack.indexOf(unit.dependsOn);
        const cycle = [...stack.slice(start), unit.dependsOn];
        throw new Error(
          `campaign dependency cycle involving units ${cycle.slice(0, -1).join(', ')}: `
          + cycle.join(' -> '),
        );
      }
      if (parentState === 0) visit(byId.get(unit.dependsOn));
    }
    stack.pop();
    state.set(unit.unitId, 2);
  };
  for (const unit of units) {
    if ((state.get(unit.unitId) ?? 0) === 0) visit(unit);
  }
}

function normalizeUnits(tasks, unitKind, campaignId) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new TypeError('campaign tasks must be a non-empty array');
  }
  const seen = new Set();
  const units = tasks.map((raw, index) => {
    const task = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw.task
      : raw;
    const kind = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw.unitKind ?? unitKind)
      : unitKind;
    const unitId = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
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
    const baseRef = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw.baseRef
      : undefined;
    const branch = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw.branch ?? raw.branchName)
      : undefined;
    const parents = declaredParents(raw, unitId);
    return {
      index, task, unitKind: kind, unitId, baseRef, branch,
      ...(parents.length === 0 ? {} : { dependsOn: parents[0] }),
    };
  });
  validateDependencyGraph(units);
  return units;
}

function reporterForUnit(factory, unit, identity) {
  if (typeof factory !== 'function') return undefined;
  let sink;
  try { sink = factory({ ...unit, ...identity }); } catch { return undefined; }
  if (typeof sink !== 'function') return undefined;
  return (event) => {
    try {
      const result = sink(identifyEvent(event, identity));
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Per-unit observability is disposable; execution is not.
    }
  };
}

export async function runCampaign({
  campaignId,
  tasks,
  target,
  gate,
  concurrency = DEFAULT_CONCURRENCY,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
  unitKind = 'candidate',
  scratchRoot,
  runOptions = {},
  reporter,
  unitReporterFactory,
  runUnit = realRun,
}) {
  const round = 1;
  if (typeof campaignId !== 'string' || campaignId === '') {
    throw new TypeError('campaignId must be a non-empty string');
  }
  positiveInteger(concurrency, 'concurrency', MAX_CONCURRENCY);
  positiveInteger(tokenBudget, 'tokenBudget');
  if (!KINDS.has(unitKind)) throw new TypeError(`unknown campaign unit kind: ${unitKind}`);
  if (typeof runUnit !== 'function') throw new TypeError('runUnit must be a function');

  const units = normalizeUnits(tasks, unitKind, campaignId);
  const indexById = new Map(units.map((unit) => [unit.unitId, unit.index]));
  const children = units.map(() => []);
  for (const unit of units) {
    if (unit.dependsOn !== undefined) children[indexById.get(unit.dependsOn)].push(unit.index);
  }
  const campaignBase = runOptions.campaignBase ?? (runUnit === realRun
    ? await prepareCampaignBase({ target, campaignId, scratchRoot })
    : undefined);
  const entries = units.map(({ index, unitId, unitKind: kind, dependsOn }) => ({
    index,
    unitId,
    unitKind: kind,
    round,
    status: dependsOn === undefined ? 'pending' : 'waiting',
    facts: null,
    ...(dependsOn === undefined ? {} : { dependsOn }),
  }));
  let aggregateUsage = EMPTY_USAGE;
  let consumedTokens = 0;
  const ready = units.filter((unit) => unit.dependsOn === undefined).map((unit) => unit.index);
  const inheritedBaseRefs = new Map();
  let inFlight = 0;
  let concluded = 0;
  let budgetExceeded = false;
  let finished = false;

  const campaignIdentity = { campaignId, round, unitId: null, unitKind: null };
  const lifecycle = (runId, stage, type, fields, identity = campaignIdentity) => {
    reportEvent(reporter, runId, stage, type, fields, identity);
  };

  lifecycle(campaignId, 'campaign', 'start', {
    unitCount: units.length,
    concurrency,
    tokenBudget,
  });
  lifecycle(campaignId, 'round', 'start', { unitCount: units.length });
  for (const unit of units) {
    if (unit.dependsOn === undefined) continue;
    lifecycle(unit.unitId, 'unit', 'waiting', {
      index: unit.index,
      predecessorUnitId: unit.dependsOn,
    }, { campaignId, round, unitId: unit.unitId, unitKind: unit.unitKind });
  }

  const markUndispatched = () => {
    for (const unit of units) {
      const entry = entries[unit.index];
      if (entry.status !== 'pending' && entry.status !== 'waiting') continue;
      entry.status = 'not-dispatched';
      entry.reason = 'token-budget-exceeded';
      concluded++;
      lifecycle(unit.unitId, 'unit', 'not_dispatched', {
        reason: entry.reason,
        consumedTokens,
        tokenBudget,
      }, { campaignId, round, unitId: unit.unitId, unitKind: unit.unitKind });
    }
    ready.length = 0;
  };

  await new Promise((resolve) => {
    const concludeIfDone = () => {
      if (finished || inFlight !== 0 || concluded !== units.length) return;
      finished = true;
      resolve();
    };

    const skipDescendants = (parentIndex, blockedByUnitId, blockedByOutcome) => {
      const parentUnit = units[parentIndex];
      const parentEntry = entries[parentIndex];
      for (const childIndex of children[parentIndex]) {
        const child = units[childIndex];
        const childEntry = entries[childIndex];
        if (childEntry.status !== 'waiting') continue;
        childEntry.status = 'skipped';
        childEntry.reason = parentEntry.status === 'skipped'
          ? 'predecessor-skipped'
          : 'predecessor-failed';
        childEntry.predecessorUnitId = parentUnit.unitId;
        childEntry.predecessorOutcome = parentEntry.status === 'failed'
          ? 'internal-error'
          : (parentEntry.facts?.outcome ?? 'skipped');
        childEntry.blockedByUnitId = blockedByUnitId;
        childEntry.blockedByOutcome = blockedByOutcome;
        concluded++;
        lifecycle(child.unitId, 'unit', 'skipped', {
          index: child.index,
          reason: childEntry.reason,
          predecessorUnitId: childEntry.predecessorUnitId,
          predecessorOutcome: childEntry.predecessorOutcome,
          blockedByUnitId,
          blockedByOutcome,
        }, { campaignId, round, unitId: child.unitId, unitKind: child.unitKind });
        skipDescendants(childIndex, blockedByUnitId, blockedByOutcome);
      }
    };

    const settleDependents = (parentIndex) => {
      const parentUnit = units[parentIndex];
      const parentEntry = entries[parentIndex];
      const succeeded = parentEntry.status === 'completed'
        && exitCodeFor(parentEntry.facts?.outcome) === 0;
      if (!succeeded) {
        const blockedByOutcome = parentEntry.status === 'failed'
          ? 'internal-error'
          : (parentEntry.facts?.outcome ?? 'internal-error');
        skipDescendants(parentIndex, parentUnit.unitId, blockedByOutcome);
        return;
      }

      const resultBranch = parentEntry.facts?.branch
        ?? parentUnit.branch
        ?? `ccc/${parentUnit.unitId}`;
      // A no-op is successful: its branch still names the same commit as its own base, so
      // descendants proceed from that branch instead of being confused with skipped work.
      for (const childIndex of children[parentIndex]) {
        const child = units[childIndex];
        const childEntry = entries[childIndex];
        if (childEntry.status !== 'waiting') continue;
        childEntry.status = 'pending';
        inheritedBaseRefs.set(childIndex, resultBranch);
        lifecycle(child.unitId, 'unit', 'released', {
          index: child.index,
          predecessorUnitId: parentUnit.unitId,
          predecessorOutcome: parentEntry.facts?.outcome,
          baseRef: resultBranch,
        }, { campaignId, round, unitId: child.unitId, unitKind: child.unitKind });
        ready.push(childIndex);
      }
    };

    const dispatch = () => {
      if (budgetExceeded) markUndispatched();
      while (!budgetExceeded && inFlight < concurrency && ready.length > 0) {
        const unitIndex = ready.shift();
        const unit = units[unitIndex];
        const entry = entries[unitIndex];
        if (entry.status !== 'pending') continue;
        inFlight++;
        entry.status = 'in-flight';
        const identity = {
          campaignId,
          round,
          unitId: unit.unitId,
          unitKind: unit.unitKind,
        };
        lifecycle(unit.unitId, 'unit', 'start', { index: unit.index }, identity);
        const unitReporter = reporterForUnit(unitReporterFactory, unit, identity);
        const topology = unit.dependsOn === undefined
          ? (unit.baseRef === undefined ? {} : { baseRef: unit.baseRef })
          : { baseRef: inheritedBaseRefs.get(unitIndex) };

        Promise.resolve().then(() => runUnit({
          ...runOptions,
          task: unit.task,
          target,
          gate,
          campaignId,
          scratchRoot,
          runId: unit.unitId,
          ...(campaignBase ? { campaignBase } : {}),
          ...topology,
          ...(unit.branch === undefined ? {} : { branch: unit.branch }),
          ...(unitReporter ? { reporter: unitReporter } : {}),
        })).then(async (facts) => {
          entry.facts = facts;
          aggregateUsage = addUsage(aggregateUsage, facts?.tokens?.total);
          consumedTokens = countUsageTokens(aggregateUsage);
          if (runUnit === realRun
            && children[unitIndex].length > 0
            && exitCodeFor(facts?.outcome) === 0) {
            entry.resultCommit = await commitCampaignResult({
              dir: facts?.dir,
              branch: facts?.branch,
              unitId: unit.unitId,
            });
            entry.resultBranch = facts.branch;
          }
          entry.status = 'completed';
          lifecycle(unit.unitId, 'unit', 'finish', {
            index: unit.index,
            outcome: facts?.outcome ?? 'unknown',
            consumedTokens,
          }, identity);
        }).catch((error) => {
          entry.status = 'failed';
          entry.error = { message: error instanceof Error ? error.message : String(error) };
          lifecycle(unit.unitId, 'unit', 'finish', {
            index: unit.index,
            outcome: 'internal-error',
            error: entry.error.message,
            consumedTokens,
          }, identity);
        }).finally(() => {
          inFlight--;
          concluded++;
          settleDependents(unitIndex);
          if (consumedTokens > tokenBudget) budgetExceeded = true;
          dispatch();
          concludeIfDone();
        });
      }
      concludeIfDone();
    };

    dispatch();
  });
  const dispatchedEntries = entries.filter((entry) => (
    entry.status === 'completed' || entry.status === 'failed'
  ));
  const failedEntries = dispatchedEntries.filter((entry) => (
    entry.status === 'failed' || exitCodeFor(entry.facts?.outcome) !== 0
  ));
  const succeededEntries = dispatchedEntries.filter((entry) => (
    entry.status === 'completed' && exitCodeFor(entry.facts?.outcome) === 0
  ));
  const skippedEntries = entries.filter((entry) => entry.status === 'skipped');
  const undispatchedEntries = entries.filter((entry) => entry.status === 'not-dispatched');
  const outcome = failedEntries.length > 0 || skippedEntries.length > 0
    ? 'campaign-failed'
    : budgetExceeded ? 'budget-exhausted' : 'review-ready';
  const counts = {
    planned: entries.length,
    dispatched: dispatchedEntries.length,
    completed: dispatchedEntries.length,
    succeeded: succeededEntries.length,
    failed: failedEntries.length,
    notDispatched: undispatchedEntries.length,
  };
  // Preserve the dependency-free aggregate shape byte-for-byte; tree campaigns only gain
  // the distinct skipped count when a skip actually occurred.
  if (skippedEntries.length > 0) counts.skipped = skippedEntries.length;
  const rollup = {
    outcome,
    counts,
    tokens: addUsage(EMPTY_USAGE, aggregateUsage),
    consumedTokens,
    budgetExceeded,
  };

  lifecycle(campaignId, 'round', 'finish', {
    outcome,
    counts: rollup.counts,
    consumedTokens,
  });
  lifecycle(campaignId, 'campaign', 'finish', {
    outcome,
    counts: rollup.counts,
    consumedTokens,
  });

  return {
    campaignId,
    round,
    target,
    limits: { concurrency, tokenBudget },
    units: entries,
    rollup,
  };
}
