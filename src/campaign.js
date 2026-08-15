import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitCodeFor } from './exit.js';
import { identifyEvent, reportEvent, UNIT_KINDS } from './events.js';
import { runGate as realGate } from './gate.js';
import {
  commitCampaignResult,
  prepareCampaignBase,
  withDetachedWorktree,
} from './isolation.js';
import { deriveMergeContext, withObservedTestCounts } from './merge.js';
import { run as realRun } from './run.js';
import { resolveStageTimeouts } from './timeouts.js';
import { addUsage, EMPTY_USAGE } from './usage.js';

export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 16;
export const DEFAULT_TOKEN_BUDGET = 12_500_000;
export { CAMPAIGN_EVENTS_FILENAME } from './event-stream.js';

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

function validateDependencyGraph(units) {
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
    const perspective = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw.perspective
      : undefined;
    if (perspective !== undefined && (typeof perspective !== 'string' || perspective.trim() === '')) {
      throw new TypeError(`campaign unit "${unitId}" perspective must be a non-empty string`);
    }
    return {
      index, task, unitKind: kind, unitId, baseRef, branch, parents, perspective,
    };
  });
  validateDependencyGraph(units);
  return units;
}

function plannerReview(entry) {
  const facts = entry.facts;
  const correctness = facts === null ? null : {
    verdict: facts?.verdict ?? null,
    source: facts?.verdictSource ?? null,
    findings: facts?.verifierFindings ?? null,
    consistency: facts?.verifierConsistency?.status ?? null,
  };
  const intent = facts === null ? null : {
    verdict: facts?.intentVerdict ?? null,
    source: facts?.intentVerdictSource ?? null,
    findings: facts?.intentVerifierFindings ?? null,
    consistency: facts?.intentVerifierConsistency?.status ?? null,
  };
  const reviewExpected = facts?.gateStatus === 'passed' && facts?.outcome !== 'no-op';
  const missing = reviewExpected
    ? [
        ...(correctness?.verdict ? [] : ['correctness']),
        ...(intent?.verdict ? [] : ['intent']),
      ]
    : [];
  return {
    unitId: entry.unitId,
    unitKind: entry.unitKind,
    outcome: facts?.outcome ?? (entry.status === 'failed' ? 'internal-error' : entry.status),
    gateStatus: facts?.gateStatus ?? null,
    expected: reviewExpected,
    complete: missing.length === 0,
    missing,
    correctness,
    intent,
  };
}

function normalizeSynthesis(value, outcome) {
  const raw = value ?? {
    decision: 'return-attributed-reviews',
    reasoning: 'No synthesis callback was supplied; return the attributed review-status set, including explicit missing passes, to the caller.',
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('planner synthesis must be an object');
  }
  const decision = raw.decision ?? raw.choice ?? raw.chosen;
  if (typeof decision !== 'string' || decision.trim() === '') {
    throw new TypeError('planner synthesis must contain a non-empty decision');
  }
  if (typeof raw.reasoning !== 'string' || raw.reasoning.trim() === '') {
    throw new TypeError('planner synthesis must contain non-empty reasoning');
  }
  return { ...raw, decision, reasoning: raw.reasoning, campaignOutcome: outcome };
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
  round = 1,
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
  plannerSynthesis,
  runUnit = realRun,
}) {
  if (typeof campaignId !== 'string' || campaignId === '') {
    throw new TypeError('campaignId must be a non-empty string');
  }
  positiveInteger(concurrency, 'concurrency', MAX_CONCURRENCY);
  positiveInteger(tokenBudget, 'tokenBudget');
  positiveInteger(round, 'round');
  if (!KINDS.has(unitKind)) throw new TypeError(`unknown campaign unit kind: ${unitKind}`);
  if (typeof runUnit !== 'function') throw new TypeError('runUnit must be a function');

  const units = normalizeUnits(tasks, unitKind, campaignId);
  if (plannerSynthesis !== undefined
    && typeof plannerSynthesis !== 'function'
    && (plannerSynthesis === null || typeof plannerSynthesis !== 'object'
      || Array.isArray(plannerSynthesis))) {
    throw new TypeError('plannerSynthesis must be an object or function');
  }
  const observed = typeof reporter === 'function';
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
  if (observed) {
    for (const unit of units.filter((candidate) => candidate.unitKind === 'candidate')) {
      lifecycle(unit.unitId, 'planner', 'candidate_generated', {
        perspective: unit.perspective ?? 'not-declared',
        perspectiveDeclared: unit.perspective !== undefined,
        task: unit.task,
      }, { campaignId, round, unitId: unit.unitId, unitKind: unit.unitKind });
    }
  }
  const indexById = new Map(units.map((unit) => [unit.unitId, unit.index]));
  const children = units.map(() => []);
  for (const unit of units) {
    for (const parent of unit.parents) children[indexById.get(parent)].push(unit.index);
  }
  let campaignBase = runOptions.campaignBase;
  if (runUnit === realRun) {
    lifecycle(campaignId, 'isolate', 'start', {
      scope: 'campaign-base',
      source: target,
      reused: campaignBase !== undefined,
    });
    try {
      campaignBase ??= await prepareCampaignBase({ target, campaignId, scratchRoot });
      lifecycle(campaignId, 'isolate', 'finish', {
        scope: 'campaign-base',
        source: campaignBase.source,
        repository: campaignBase.repository,
        reused: runOptions.campaignBase !== undefined,
        verdict: 'ready',
      });
    } catch (error) {
      lifecycle(campaignId, 'isolate', 'finish', {
        scope: 'campaign-base',
        verdict: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      lifecycle(campaignId, 'round', 'finish', {
        outcome: 'internal-error',
        phase: 'campaign-base',
      });
      lifecycle(campaignId, 'campaign', 'finish', {
        outcome: 'internal-error',
        phase: 'campaign-base',
      });
      throw error;
    }
  }
  const hasMerge = units.some((unit) => unit.parents.length > 1);
  const gateCommands = runUnit === realRun && hasMerge
    ? (Array.isArray(gate) ? gate : JSON.parse(readFileSync(gate, 'utf8')))
    : null;
  const baselineTestCounts = new Map();
  const measureBaselineTests = (commit, unit, unitReporter) => {
    if (baselineTestCounts.has(commit)) return baselineTestCounts.get(commit);
    const measurement = withDetachedWorktree({
      repository: campaignBase.repository,
      commit,
      dir: join(scratchRoot, campaignId, `.test-count-${unit.index}`),
      action: async (cwd) => {
        const gateRunner = runOptions.adapters?.runGate ?? realGate;
        const result = await gateRunner({
          commands: gateCommands,
          cwd,
          timeoutMs: resolveStageTimeouts().gate,
          runId: `${unit.unitId}-baseline-count`,
          attempt: 0,
          captureTestCount: true,
          ...(unitReporter ? {
            reporter: (event) => unitReporter({ ...event, scope: 'merge-baseline' }),
          } : {}),
        });
        return Number.isSafeInteger(result?.testCount) ? result.testCount : null;
      },
    }).catch(() => null);
    baselineTestCounts.set(commit, measurement);
    return measurement;
  };
  const entries = units.map(({ index, unitId, unitKind: kind, dependsOn, parents }) => ({
    index,
    unitId,
    unitKind: kind,
    round,
    status: parents.length === 0 ? 'pending' : 'waiting',
    facts: null,
    ...(parents.length === 0 ? {} : { dependsOn }),
  }));
  let aggregateUsage = EMPTY_USAGE;
  let consumedTokens = 0;
  const ready = units.filter((unit) => unit.parents.length === 0).map((unit) => unit.index);
  const inheritedTopologies = new Map();
  let inFlight = 0;
  let concluded = 0;
  let budgetExceeded = false;
  let finished = false;
  const plannerReviews = [];

  for (const unit of units) {
    if (unit.parents.length === 0) continue;
    lifecycle(unit.unitId, 'unit', 'waiting', {
      index: unit.index,
      ...(unit.parents.length === 1
        ? { predecessorUnitId: unit.parents[0] }
        : { predecessorUnitIds: [...unit.parents] }),
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

      // A no-op is successful: its branch still names the same commit as its own base, so
      // descendants proceed from that branch instead of being confused with skipped work.
      for (const childIndex of children[parentIndex]) {
        const child = units[childIndex];
        const childEntry = entries[childIndex];
        if (childEntry.status !== 'waiting') continue;
        const parentEntries = child.parents.map((parentId) => entries[indexById.get(parentId)]);
        if (!parentEntries.every((entry) => entry.status === 'completed'
          && exitCodeFor(entry.facts?.outcome) === 0)) continue;
        const parentTopology = child.parents.map((parentId) => {
          const declared = units[indexById.get(parentId)];
          const settled = entries[declared.index];
          return {
            unitId: parentId,
            branch: settled.facts?.branch ?? declared.branch ?? `ccc/${parentId}`,
            commit: settled.resultCommit ?? settled.facts?.baseCommit ?? null,
          };
        });
        childEntry.status = 'pending';
        inheritedTopologies.set(childIndex, {
          baseRef: parentTopology[0].branch,
          parents: parentTopology,
        });
        lifecycle(child.unitId, 'unit', 'released', {
          index: child.index,
          ...(child.parents.length === 1
            ? {
                predecessorUnitId: child.parents[0],
                predecessorOutcome: parentEntries[0].facts?.outcome,
              }
            : {
                predecessorUnitIds: [...child.parents],
                predecessorOutcomes: parentEntries.map((entry) => entry.facts?.outcome),
              }),
          baseRef: parentTopology[0].branch,
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
        const topology = unit.parents.length === 0
          ? (unit.baseRef === undefined ? {} : { baseRef: unit.baseRef })
          : inheritedTopologies.get(unitIndex);

        Promise.resolve().then(async () => {
          let runTopology = topology;
          if (unit.parents.length > 1) {
            lifecycle(unit.unitId, 'merge', 'start', {
              scope: 'campaign-context',
              parentUnitIds: topology.parents.map((parent) => parent.unitId),
            }, identity);
            let merge;
            try {
              merge = runUnit === realRun
                ? await deriveMergeContext({
                    repository: campaignBase.repository,
                    parents: topology.parents,
                  })
                : {
                    parents: topology.parents.map((parent) => ({ ...parent })),
                    parentOrder: topology.parents.map((parent) => parent.unitId),
                    mergeBase: null,
                    testCounts: null,
                  };
            } catch (error) {
              lifecycle(unit.unitId, 'merge', 'finish', {
                scope: 'campaign-context',
                verdict: 'failed',
                reason: error instanceof Error ? error.message : String(error),
              }, identity);
              throw error;
            }
            if (runUnit === realRun) {
              const observedParents = unit.parents.map((parentId) => {
                const facts = entries[indexById.get(parentId)].facts;
                return facts?.iterations?.at(-1)?.gate?.testCount ?? null;
              });
              if (observedParents.every((count) => Number.isSafeInteger(count) && count >= 0)) {
                const baseline = await measureBaselineTests(merge.mergeBase, unit, unitReporter);
                merge = withObservedTestCounts(merge, {
                  baseline,
                  parents: observedParents,
                });
              }
            }
            lifecycle(unit.unitId, 'merge', 'finish', {
              scope: 'campaign-context',
              verdict: 'prepared',
              mergeBase: merge.mergeBase,
              parentUnitIds: [...merge.parentOrder],
              requiredTestCount: merge.testCounts?.required ?? null,
              testCountSource: merge.testCounts?.source ?? null,
            }, identity);
            runTopology = { baseRef: topology.baseRef, unitKind: 'merge', merge };
          } else if (unit.parents.length === 1) {
            runTopology = { baseRef: topology.baseRef };
          }
          return runUnit({
            ...runOptions,
            task: unit.task,
            target,
            gate,
            campaignId,
            round,
            unitId: unit.unitId,
            campaignUnitKind: unit.unitKind,
            scratchRoot,
            runId: unit.unitId,
            ...(campaignBase ? { campaignBase } : {}),
            ...runTopology,
            ...(runUnit === realRun && hasMerge ? { captureTestCount: true } : {}),
            ...(unit.branch === undefined ? {} : { branch: unit.branch }),
            ...(unitReporter ? { reporter: unitReporter } : {}),
          });
        }).then(async (facts) => {
          entry.facts = facts;
          aggregateUsage = addUsage(aggregateUsage, facts?.tokens?.total);
          consumedTokens = countUsageTokens(aggregateUsage);
          if (runUnit === realRun
            && children[unitIndex].length > 0
            && exitCodeFor(facts?.outcome) === 0) {
            lifecycle(unit.unitId, 'isolate', 'start', {
              scope: 'campaign-result',
              dir: facts?.dir,
              branch: facts?.branch,
            }, identity);
            try {
              entry.resultCommit = await commitCampaignResult({
                dir: facts?.dir,
                branch: facts?.branch,
                unitId: unit.unitId,
              });
              lifecycle(unit.unitId, 'isolate', 'finish', {
                scope: 'campaign-result',
                verdict: 'committed',
                branch: facts?.branch,
                commit: entry.resultCommit,
              }, identity);
            } catch (error) {
              lifecycle(unit.unitId, 'isolate', 'finish', {
                scope: 'campaign-result',
                verdict: 'failed',
                reason: error instanceof Error ? error.message : String(error),
              }, identity);
              throw error;
            }
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
          if (observed || plannerSynthesis !== undefined) {
            const review = plannerReview(entry);
            plannerReviews.push(review);
            lifecycle(unit.unitId, 'planner', 'review_received', {
              outcome: review.outcome,
              gateStatus: review.gateStatus,
              expected: review.expected,
              complete: review.complete,
              missing: review.missing,
              correctness: review.correctness,
              intent: review.intent,
            }, identity);
          }
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

  let synthesis = null;
  if (observed || plannerSynthesis !== undefined) {
    plannerReviews.sort((left, right) => indexById.get(left.unitId) - indexById.get(right.unitId));
    try {
      const proposed = typeof plannerSynthesis === 'function'
        ? await plannerSynthesis({
            campaignId,
            round,
            reviews: plannerReviews.map((review) => ({ ...review })),
            units: entries.map((entry) => ({
              unitId: entry.unitId,
              unitKind: entry.unitKind,
              status: entry.status,
              outcome: entry.facts?.outcome ?? null,
              reason: entry.reason ?? null,
            })),
            rollup: { ...rollup, counts: { ...rollup.counts }, tokens: { ...rollup.tokens } },
          })
        : plannerSynthesis;
      synthesis = normalizeSynthesis(proposed, outcome);
      lifecycle(campaignId, 'planner', 'synthesis', synthesis);
    } catch (error) {
      const reasoning = error instanceof Error ? error.message : String(error);
      lifecycle(campaignId, 'planner', 'synthesis', {
        decision: 'planner-failed',
        reasoning,
        campaignOutcome: outcome,
      });
      lifecycle(campaignId, 'round', 'finish', {
        outcome: 'internal-error',
        phase: 'planner-synthesis',
        counts: rollup.counts,
        consumedTokens,
      });
      lifecycle(campaignId, 'campaign', 'finish', {
        outcome: 'internal-error',
        phase: 'planner-synthesis',
        counts: rollup.counts,
        consumedTokens,
      });
      throw error;
    }
  }

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
    ...(plannerSynthesis === undefined ? {} : { planner: { synthesis } }),
  };
}
