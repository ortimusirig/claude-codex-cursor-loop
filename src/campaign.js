import { exitCodeFor } from './exit.js';
import { identifyEvent, reportEvent, UNIT_KINDS } from './events.js';
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

function normalizeUnits(tasks, unitKind, campaignId) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new TypeError('campaign tasks must be a non-empty array');
  }
  const seen = new Set();
  return tasks.map((raw, index) => {
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
    return { index, task, unitKind: kind, unitId };
  });
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
  const entries = units.map(({ index, unitId, unitKind: kind }) => ({
    index,
    unitId,
    unitKind: kind,
    round,
    status: 'pending',
    facts: null,
  }));
  let aggregateUsage = EMPTY_USAGE;
  let consumedTokens = 0;
  let nextIndex = 0;
  let inFlight = 0;
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

  const markUndispatched = () => {
    while (nextIndex < units.length) {
      const unit = units[nextIndex];
      const entry = entries[nextIndex];
      nextIndex++;
      entry.status = 'not-dispatched';
      entry.reason = 'token-budget-exceeded';
      lifecycle(unit.unitId, 'unit', 'not_dispatched', {
        reason: entry.reason,
        consumedTokens,
        tokenBudget,
      }, { campaignId, round, unitId: unit.unitId, unitKind: unit.unitKind });
    }
  };

  await new Promise((resolve) => {
    const concludeIfDone = () => {
      if (finished || inFlight !== 0 || nextIndex < units.length) return;
      finished = true;
      resolve();
    };

    const dispatch = () => {
      if (budgetExceeded) markUndispatched();
      while (!budgetExceeded && inFlight < concurrency && nextIndex < units.length) {
        const unit = units[nextIndex];
        const entry = entries[nextIndex];
        nextIndex++;
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

        Promise.resolve().then(() => runUnit({
          ...runOptions,
          task: unit.task,
          target,
          gate,
          scratchRoot,
          runId: unit.unitId,
          ...(unitReporter ? { reporter: unitReporter } : {}),
        })).then((facts) => {
          entry.status = 'completed';
          entry.facts = facts;
          aggregateUsage = addUsage(aggregateUsage, facts?.tokens?.total);
          consumedTokens = countUsageTokens(aggregateUsage);
          lifecycle(unit.unitId, 'unit', 'finish', {
            index: unit.index,
            outcome: facts?.outcome ?? 'unknown',
            consumedTokens,
          }, identity);
        }, (error) => {
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
          if (consumedTokens > tokenBudget) budgetExceeded = true;
          dispatch();
          concludeIfDone();
        });
      }
      concludeIfDone();
    };

    dispatch();
  });
  const concludedEntries = entries.filter((entry) => entry.status !== 'not-dispatched');
  const failedEntries = concludedEntries.filter((entry) => (
    entry.status === 'failed' || exitCodeFor(entry.facts?.outcome) !== 0
  ));
  const succeededEntries = concludedEntries.filter((entry) => (
    entry.status === 'completed' && exitCodeFor(entry.facts?.outcome) === 0
  ));
  const undispatchedEntries = entries.filter((entry) => entry.status === 'not-dispatched');
  const outcome = failedEntries.length > 0
    ? 'campaign-failed'
    : budgetExceeded ? 'budget-exhausted' : 'review-ready';
  const rollup = {
    outcome,
    counts: {
      planned: entries.length,
      dispatched: concludedEntries.length,
      completed: concludedEntries.length,
      succeeded: succeededEntries.length,
      failed: failedEntries.length,
      notDispatched: undispatchedEntries.length,
    },
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
