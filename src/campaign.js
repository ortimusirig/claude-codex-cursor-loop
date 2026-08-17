import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitCodeFor } from './exit.js';
import { identifyEvent, reportEvent, UNIT_KINDS } from './events.js';
import {
  CAMPAIGN_SHAPES,
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
import { runGate as realGate } from './gate.js';
import {
  commitCampaignResult,
  prepareCampaignBase,
  withDetachedWorktree,
} from './isolation.js';
import { deriveMergeContext, withObservedTestCounts } from './merge.js';
import { countTestFiles } from './merge-test-count.js';
import { run as realRun } from './run.js';
import { resolveStageTimeouts } from './timeouts.js';
import {
  addUsage,
  checkUsageConsistency,
  EMPTY_USAGE,
  summarizeUsageConsistency,
} from './usage.js';

export {
  CAMPAIGN_SHAPES,
  DEFAULT_CONCURRENCY,
  DEFAULT_ROUNDS,
  DEFAULT_TOKEN_BUDGET,
  MAX_CONCURRENCY,
  MAX_ROUNDS,
};
export const CAMPAIGN_STOP_REASONS = Object.freeze({
  BUDGET_EXHAUSTED: 'budget-exhausted',
  MAX_ROUNDS_REACHED: 'max-rounds-reached',
  CALLER_REQUESTED: 'caller-requested',
});
export { CAMPAIGN_EVENTS_FILENAME } from './event-stream.js';

const KINDS = new Set(UNIT_KINDS);

export function countUsageTokens(usage) {
  const normalized = addUsage(EMPTY_USAGE, usage);
  // Count total input plus total output: those are the tokens actually consumed for the
  // campaign ceiling. Cached input and reasoning output are already subsets of those
  // totals, so adding either again would double-count them and overstate consumption.
  return normalized.inputTokens + normalized.outputTokens;
}

function candidateFailureReason(entry) {
  const facts = entry.facts;
  if (entry.error?.message) return entry.error.message;
  if (entry.reason) return entry.reason;
  if (!facts || exitCodeFor(facts.outcome) === 0) return null;
  const timeout = facts.timeoutEvents?.at(-1);
  if (facts.outcome === 'timed-out' && timeout) {
    return `${timeout.stage ?? 'stage'} timed out after ${timeout.timeoutMs ?? 'unknown'} ms`;
  }
  if (facts.outcome === 'timed-out') return 'candidate execution timed out';
  if (facts.gateFailure) {
    const command = [facts.gateFailure.bin, ...(facts.gateFailure.args ?? [])]
      .filter(Boolean).join(' ');
    return `${command || 'gate command'} ${facts.gateFailure.timedOut ? 'timed out' : `exited with code ${facts.gateFailure.code}`}`;
  }
  if (facts.outcome === 'verifier-failed') {
    return 'one or both verifier passes did not produce usable verdict evidence';
  }
  return facts.outcome ?? 'internal-error';
}

function candidateVerdict(facts, pass) {
  const intent = pass === 'intent';
  const consistency = intent
    ? facts?.intentVerifierConsistency?.status ?? null
    : facts?.verifierConsistency?.status ?? null;
  return {
    verdict: intent ? facts?.intentVerdict ?? null : facts?.verdict ?? null,
    source: intent ? facts?.intentVerdictSource ?? null : facts?.verdictSource ?? null,
    consistency,
    selfConsistent: consistency === null ? null : consistency === 'consistent',
  };
}

function observedCandidateTestCount(facts) {
  if (Number.isSafeInteger(facts?.testCount) && facts.testCount >= 0) return facts.testCount;
  const count = facts?.iterations?.at(-1)?.gate?.testCount;
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
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
    ...(entry.perspective === undefined ? {} : { perspective: entry.perspective }),
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
  const { explicitUnitKind: _explicitUnitKind, ...publicUnit } = unit;
  try { sink = factory({ ...publicUnit, ...identity }); } catch { return undefined; }
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

async function runCampaignRound(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('campaign options must be an object');
  }
  const {
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
    candidateSet: candidateSetDeclaration,
    _emitCampaignLifecycle = true,
    _campaignBaseReady,
    _budgetExhaustedAtLimit = false,
  } = options;
  if (typeof campaignId !== 'string' || campaignId === '') {
    throw new TypeError('campaignId must be a non-empty string');
  }
  positiveInteger(concurrency, 'concurrency', MAX_CONCURRENCY);
  positiveInteger(tokenBudget, 'tokenBudget');
  positiveInteger(round, 'round');
  if (!KINDS.has(unitKind)) throw new TypeError(`unknown campaign unit kind: ${unitKind}`);
  if (typeof runUnit !== 'function') throw new TypeError('runUnit must be a function');

  const units = normalizeUnits(tasks, unitKind, campaignId);
  const allCandidates = units.every((unit) => unit.unitKind === 'candidate');
  const candidateSet = candidateSetDeclaration === true || (allCandidates && (
    Object.hasOwn(options, 'unitKind')
    || units.every((unit) => unit.explicitUnitKind)
    || units.some((unit) => unit.perspective !== undefined)
  ));
  if (candidateSet) validateCandidateSet(units);
  validateDependencyGraph(units);
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
  if (_emitCampaignLifecycle) {
    lifecycle(campaignId, 'campaign', 'start', {
      unitCount: units.length,
      concurrency,
      tokenBudget,
      ...(candidateSet ? {
        campaignShape: CAMPAIGN_SHAPES[1],
        alternatives: true,
        candidates: units.map((unit) => ({
          unitId: unit.unitId,
          perspective: unit.perspective,
        })),
      } : { campaignShape: CAMPAIGN_SHAPES[0], alternatives: false }),
    });
  }
  lifecycle(campaignId, 'round', 'start', {
    unitCount: units.length,
    campaignShape: candidateSet ? CAMPAIGN_SHAPES[1] : CAMPAIGN_SHAPES[0],
    alternatives: candidateSet,
  });
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
      if (typeof _campaignBaseReady === 'function') _campaignBaseReady(campaignBase);
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
      if (_emitCampaignLifecycle) {
        lifecycle(campaignId, 'campaign', 'finish', {
          outcome: 'internal-error',
          phase: 'campaign-base',
        });
      }
      throw error;
    }
  }
  const hasMerge = units.some((unit) => unit.parents.length > 1);
  const gateCommands = runUnit === realRun && (hasMerge || candidateSet)
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
  const candidateBaselines = new Map();
  const measureCandidateBaseline = (commit, unit, captureGateCount) => {
    if (candidateBaselines.has(commit)) return candidateBaselines.get(commit);
    lifecycle(campaignId, 'isolate', 'start', {
      scope: 'candidate-test-baseline',
      baseRef: commit,
    });
    const measurement = withDetachedWorktree({
      repository: campaignBase.repository,
      commit,
      dir: join(scratchRoot, campaignId, `.candidate-test-count-${unit.index}`),
      action: async (cwd) => {
        const files = countTestFiles(cwd);
        if (!captureGateCount) return { gate: null, files };
        const gateRunner = runOptions.adapters?.runGate ?? realGate;
        const result = await gateRunner({
          commands: gateCommands,
          cwd,
          timeoutMs: resolveStageTimeouts().gate,
          runId: `${unit.unitId}-candidate-baseline-count`,
          attempt: 0,
          captureTestCount: true,
        });
        return {
          gate: Number.isSafeInteger(result?.testCount) ? result.testCount : null,
          files,
        };
      },
    }).then((counts) => {
      lifecycle(campaignId, 'isolate', 'finish', {
        scope: 'candidate-test-baseline',
        baseRef: commit,
        verdict: 'measured',
        gateTestCount: counts.gate,
        testFileCount: counts.files,
      });
      return counts;
    }).catch((error) => {
      lifecycle(campaignId, 'isolate', 'finish', {
        scope: 'candidate-test-baseline',
        baseRef: commit,
        verdict: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
      });
      return { gate: null, files: null };
    });
    candidateBaselines.set(commit, measurement);
    return measurement;
  };
  const entries = units.map(({
    index, unitId, unitKind: kind, dependsOn, parents, perspective,
  }) => ({
    index,
    unitId,
    unitKind: kind,
    round,
    status: parents.length === 0 ? 'pending' : 'waiting',
    facts: null,
    ...(perspective === undefined ? {} : { perspective }),
    ...(parents.length === 0 ? {} : { dependsOn }),
  }));
  let aggregateUsage = EMPTY_USAGE;
  const usageChecks = [];
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
        lifecycle(unit.unitId, 'unit', 'start', {
          index: unit.index,
          ...(unit.perspective === undefined ? {} : { perspective: unit.perspective }),
          ...(candidateSet ? { alternative: true } : {}),
        }, identity);
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
            ...(unit.perspective === undefined ? {} : { perspective: unit.perspective }),
            scratchRoot,
            runId: unit.unitId,
            ...(campaignBase ? { campaignBase } : {}),
            ...runTopology,
            ...(runUnit === realRun && (hasMerge || candidateSet)
              ? { captureTestCount: true }
              : {}),
            ...(unit.branch === undefined ? {} : { branch: unit.branch }),
            ...(unitReporter ? { reporter: unitReporter } : {}),
          });
        }).then(async (facts) => {
          entry.facts = unit.perspective === undefined
            || facts === null || typeof facts !== 'object' || Array.isArray(facts)
            ? facts
            : { ...facts, perspective: unit.perspective };
          const unitUsage = addUsage(EMPTY_USAGE, entry.facts?.tokens?.total);
          usageChecks.push({
            unitId: unit.unitId,
            ...checkUsageConsistency(unitUsage),
          });
          aggregateUsage = addUsage(aggregateUsage, unitUsage);
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
            ...(unit.perspective === undefined ? {} : { perspective: unit.perspective }),
            ...(candidateSet ? { alternative: true } : {}),
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
              ...(unit.perspective === undefined ? {} : { perspective: unit.perspective }),
              ...(candidateSet ? { alternative: true } : {}),
            }, identity);
          }
          inFlight--;
          concluded++;
          settleDependents(unitIndex);
          if (_budgetExhaustedAtLimit
            ? consumedTokens >= tokenBudget
            : consumedTokens > tokenBudget) budgetExceeded = true;
          dispatch();
          concludeIfDone();
        });
      }
      concludeIfDone();
    };

    dispatch();
  });
  const candidateTestCounts = new Map();
  if (candidateSet && runUnit === realRun) {
    const captureGateCount = entries.some((entry) => (
      observedCandidateTestCount(entry.facts) !== null
    ));
    for (const unit of units) {
      const entry = entries[unit.index];
      const commit = entry.facts?.baseCommit;
      if (typeof commit !== 'string' || commit === '') continue;
      const baseline = await measureCandidateBaseline(commit, unit, captureGateCount);
      const observed = observedCandidateTestCount(entry.facts);
      let candidateFiles = null;
      if (observed === null && typeof entry.facts?.dir === 'string') {
        try { candidateFiles = countTestFiles(entry.facts.dir); } catch { /* unavailable */ }
      }
      const source = observed !== null && baseline.gate !== null ? 'gate-output' : 'test-files';
      const before = source === 'gate-output' ? baseline.gate : baseline.files;
      const after = source === 'gate-output' ? observed : candidateFiles;
      candidateTestCounts.set(unit.index, {
        baseline: Number.isSafeInteger(before) ? before : null,
        candidate: Number.isSafeInteger(after) ? after : null,
        delta: Number.isSafeInteger(before) && Number.isSafeInteger(after)
          ? after - before
          : null,
        source,
      });
    }
  }
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
  const everyCandidateFailed = candidateSet
    && failedEntries.length === entries.length;
  const outcome = candidateSet
    ? (everyCandidateFailed
        ? 'campaign-failed'
        : budgetExceeded ? 'budget-exhausted' : 'review-ready')
    : (failedEntries.length > 0 || skippedEntries.length > 0
        ? 'campaign-failed'
        : budgetExceeded ? 'budget-exhausted' : 'review-ready');
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
    usageConsistency: summarizeUsageConsistency(usageChecks),
    consumedTokens,
    budgetExceeded,
  };
  const alternatives = candidateSet ? {
    status: 'awaiting-planner-decision',
    statement: 'These candidates are alternatives for one goal. No selection has been made; a planner must choose or synthesize from the evidence.',
    candidates: entries.map((entry) => {
      const facts = entry.facts;
      const correctness = candidateVerdict(facts, 'correctness');
      const intent = candidateVerdict(facts, 'intent');
      const consistencyValues = [correctness.selfConsistent, intent.selfConsistent];
      const evidenceSelfConsistent = consistencyValues.includes(false)
        ? false
        : consistencyValues.every((value) => value === true) ? true : null;
      let testCount = candidateTestCounts.get(entry.index) ?? null;
      if (testCount === null && facts?.testCounts && typeof facts.testCounts === 'object') {
        testCount = {
          baseline: facts.testCounts.baseline ?? null,
          candidate: facts.testCounts.candidate ?? facts.testCounts.actual ?? null,
          delta: facts.testCounts.delta ?? null,
          source: facts.testCounts.source ?? null,
        };
      }
      if (testCount === null && Number.isSafeInteger(facts?.testCountDelta)) {
        testCount = {
          baseline: null,
          candidate: observedCandidateTestCount(facts),
          delta: facts.testCountDelta,
          source: facts.testCountSource ?? null,
        };
      }
      testCount ??= { baseline: null, candidate: null, delta: null, source: null };
      const candidateOutcome = facts?.outcome
        ?? (entry.status === 'failed' ? 'internal-error' : entry.status);
      const successful = entry.status === 'completed' && exitCodeFor(candidateOutcome) === 0;
      const tokens = addUsage(EMPTY_USAGE, facts?.tokens?.total);
      const proposedDiffPath = typeof facts?.dir === 'string'
        ? join(facts.dir, 'CHANGES.diff')
        : null;
      return {
        unitId: entry.unitId,
        perspective: entry.perspective,
        status: successful ? 'succeeded' : entry.status === 'not-dispatched'
          ? 'not-dispatched' : 'failed',
        outcome: candidateOutcome,
        successful,
        reason: successful ? null : candidateFailureReason(entry),
        verdicts: { correctness, intent },
        evidenceSelfConsistent,
        diffPath: proposedDiffPath !== null && existsSync(proposedDiffPath)
          ? proposedDiffPath
          : null,
        branch: facts?.branch ?? null,
        baseCommit: facts?.baseCommit ?? null,
        testCount,
        testCountDelta: testCount.delta,
        tokens,
        tokenCost: countUsageTokens(tokens),
      };
    }),
  } : null;

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
      if (_emitCampaignLifecycle) {
        lifecycle(campaignId, 'campaign', 'finish', {
          outcome: 'internal-error',
          phase: 'planner-synthesis',
          counts: rollup.counts,
          consumedTokens,
        });
      }
      throw error;
    }
  }

  lifecycle(campaignId, 'round', 'finish', {
    outcome,
    counts: rollup.counts,
    consumedTokens,
  });
  if (_emitCampaignLifecycle) {
    lifecycle(campaignId, 'campaign', 'finish', {
      outcome,
      counts: rollup.counts,
      consumedTokens,
    });
  }

  return {
    campaignId,
    round,
    target,
    limits: { concurrency, tokenBudget },
    units: entries,
    rollup,
    ...(alternatives === null ? {} : { alternatives }),
    ...(plannerSynthesis === undefined ? {} : { planner: { synthesis } }),
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function roundDeclaration(value, name) {
  if (Array.isArray(value)) return { tasks: value };
  if (!isRecord(value)) {
    throw new TypeError(`${name} must be an array of tasks or an object with tasks`);
  }
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new TypeError(`${name}.tasks must be a non-empty array`);
  }
  return value;
}

function iterativeConfiguration(options) {
  const declaredRounds = options.roundPlans
    ?? (Array.isArray(options.rounds) ? options.rounds : null);
  if (declaredRounds !== null && (!Array.isArray(declaredRounds) || declaredRounds.length === 0)) {
    throw new TypeError('rounds must be a non-empty array');
  }
  const numericRounds = typeof options.rounds === 'number' ? options.rounds : undefined;
  const maxRounds = options.maxRounds
    ?? numericRounds
    ?? declaredRounds?.length
    ?? DEFAULT_ROUNDS;
  positiveInteger(maxRounds, 'maxRounds', MAX_ROUNDS);
  if (declaredRounds !== null && declaredRounds.length > maxRounds) {
    throw new TypeError(`round plans exceed configured maximum of ${maxRounds}`);
  }
  return {
    maxRounds,
    declarations: declaredRounds?.map((value, index) => (
      roundDeclaration(value, `rounds[${index}]`)
    )) ?? null,
  };
}

function withRoundUnitIds(tasks, campaignId, round) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new TypeError(`round ${round} tasks must be a non-empty array`);
  }
  return tasks.map((raw, index) => {
    const generated = `${campaignId}-r${round}-u${String(index + 1).padStart(3, '0')}`;
    if (!isRecord(raw)) return { task: raw, unitId: generated, unitKind: 'candidate' };
    if (raw.unitId !== undefined || raw.runId !== undefined) return { ...raw };
    return { ...raw, unitId: generated };
  });
}

function validateIterativeRound(tasks, campaignId, seenUnitIds, expectedBaseRef) {
  const normalized = normalizeUnits(tasks, 'candidate', campaignId);
  validateCandidateSet(normalized);
  validateDependencyGraph(normalized);
  for (const unit of normalized) {
    if (seenUnitIds.has(unit.unitId)) {
      throw new TypeError(`duplicate campaign unitId across rounds: ${unit.unitId}`);
    }
  }
  const baseRef = normalized[0].baseRef ?? 'HEAD';
  if (expectedBaseRef !== undefined && baseRef !== expectedBaseRef) {
    throw new Error('every iterative round must use the same campaign base ref');
  }
  return { baseRef, unitIds: normalized.map((unit) => unit.unitId) };
}

function groupedRoundResult(result) {
  const alternatives = result.alternatives === undefined ? undefined : {
    ...result.alternatives,
    candidates: result.alternatives.candidates.map((candidate) => ({
      ...candidate,
      round: result.round,
    })),
  };
  return {
    round: result.round,
    units: result.units,
    rollup: result.rollup,
    ...(alternatives === undefined ? {} : { alternatives }),
    ...(result.planner === undefined ? {} : { planner: result.planner }),
  };
}

function iterativeRollup(rounds, tokenBudget, stopReason) {
  const units = rounds.flatMap((round) => round.units);
  const counts = {
    planned: 0,
    dispatched: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    notDispatched: 0,
  };
  let skipped = 0;
  let tokens = EMPTY_USAGE;
  const usageChecks = [];
  for (const round of rounds) {
    for (const key of Object.keys(counts)) counts[key] += round.rollup.counts[key] ?? 0;
    skipped += round.rollup.counts.skipped ?? 0;
    tokens = addUsage(tokens, round.rollup.tokens);
    usageChecks.push(...(round.rollup.usageConsistency?.checks ?? []).map((check) => ({
      round: round.round,
      ...check,
    })));
  }
  if (skipped > 0) counts.skipped = skipped;
  const consumedTokens = countUsageTokens(tokens);
  const everyCandidateFailed = units.length > 0 && units.every((entry) => (
    (entry.status === 'completed' || entry.status === 'failed')
      && (entry.status === 'failed' || exitCodeFor(entry.facts?.outcome) !== 0)
  ));
  const budgetExceeded = stopReason === CAMPAIGN_STOP_REASONS.BUDGET_EXHAUSTED;
  return {
    outcome: everyCandidateFailed
      ? 'campaign-failed'
      : budgetExceeded ? 'budget-exhausted' : 'review-ready',
    counts,
    tokens,
    usageConsistency: summarizeUsageConsistency(usageChecks),
    consumedTokens,
    budgetExceeded,
    tokenBudget,
  };
}

export async function runCampaign(options) {
  if (!isRecord(options)) throw new TypeError('campaign options must be an object');
  const configuration = iterativeConfiguration(options);
  const firstDeclaration = configuration.declarations?.[0];

  // The ordinary path is intentionally the pre-v3-stage-7 function call. In particular,
  // it adds no stop reason or rounds collection and emits the same lifecycle records.
  if (configuration.maxRounds === DEFAULT_ROUNDS) {
    if (firstDeclaration === undefined) return runCampaignRound(options);
    const {
      rounds: _rounds,
      roundPlans: _roundPlans,
      maxRounds: _maxRounds,
      nextRound: _nextRound,
      shouldStop: _shouldStop,
      ...singleOptions
    } = options;
    return runCampaignRound({ ...singleOptions, ...firstDeclaration });
  }

  if (options.round !== undefined && options.round !== 1) {
    throw new TypeError('an iterative campaign must start at round 1');
  }
  if (options.nextRound !== undefined && typeof options.nextRound !== 'function') {
    throw new TypeError('nextRound must be a function');
  }
  if (options.shouldStop !== undefined && typeof options.shouldStop !== 'function') {
    throw new TypeError('shouldStop must be a function');
  }
  const {
    campaignId,
    target,
    concurrency = DEFAULT_CONCURRENCY,
    tokenBudget = DEFAULT_TOKEN_BUDGET,
    reporter,
    runUnit = realRun,
  } = options;
  if (typeof campaignId !== 'string' || campaignId === '') {
    throw new TypeError('campaignId must be a non-empty string');
  }
  positiveInteger(concurrency, 'concurrency', MAX_CONCURRENCY);
  positiveInteger(tokenBudget, 'tokenBudget');
  const initial = firstDeclaration ?? { tasks: options.tasks };
  let next = initial;
  let campaignBase = options.runOptions?.campaignBase;
  let expectedBaseRef;
  let consumedTokens = 0;
  let stopReason = null;
  const seenUnitIds = new Set();
  const completedRounds = [];
  let campaignStarted = false;

  try {
    for (let round = 1; round <= configuration.maxRounds; round++) {
      const tasks = withRoundUnitIds(next.tasks, campaignId, round);
      const validation = validateIterativeRound(tasks, campaignId, seenUnitIds, expectedBaseRef);
      expectedBaseRef ??= validation.baseRef;
      for (const unitId of validation.unitIds) seenUnitIds.add(unitId);

      if (!campaignStarted) {
        campaignStarted = true;
        reportEvent(reporter, campaignId, 'campaign', 'start', {
          unitCount: tasks.length,
          concurrency,
          tokenBudget,
          maxRounds: configuration.maxRounds,
          campaignShape: CAMPAIGN_SHAPES[2],
          alternatives: true,
          candidates: tasks.map((task) => ({
            unitId: task.unitId ?? task.runId,
            perspective: task.perspective,
          })),
        }, { campaignId, round: 1, unitId: null, unitKind: null });
      }

      const remainingBudget = tokenBudget - consumedTokens;
      if (remainingBudget <= 0) {
        stopReason = CAMPAIGN_STOP_REASONS.BUDGET_EXHAUSTED;
        break;
      }
      const result = await runCampaignRound({
        ...options,
        ...next,
        tasks,
        candidateSet: true,
        round,
        tokenBudget: remainingBudget,
        runOptions: {
          ...options.runOptions,
          ...(campaignBase === undefined ? {} : { campaignBase }),
        },
        _emitCampaignLifecycle: false,
        _campaignBaseReady: (prepared) => { campaignBase = prepared; },
        _budgetExhaustedAtLimit: true,
      });
      const grouped = groupedRoundResult(result);
      completedRounds.push(grouped);
      consumedTokens += result.rollup.consumedTokens;

      if (consumedTokens >= tokenBudget || result.rollup.budgetExceeded) {
        stopReason = CAMPAIGN_STOP_REASONS.BUDGET_EXHAUSTED;
        break;
      }
      if (round === configuration.maxRounds) {
        stopReason = CAMPAIGN_STOP_REASONS.MAX_ROUNDS_REACHED;
        break;
      }
      if (options.shouldStop !== undefined && await options.shouldStop({
        campaignId,
        round,
        result: grouped,
        rounds: completedRounds.map((value) => ({ ...value })),
        consumedTokens,
        remainingTokens: tokenBudget - consumedTokens,
      })) {
        stopReason = CAMPAIGN_STOP_REASONS.CALLER_REQUESTED;
        break;
      }

      let proposed = configuration.declarations?.[round];
      if (proposed === undefined && options.nextRound !== undefined) {
        proposed = await options.nextRound({
          campaignId,
          round,
          result: grouped,
          rounds: completedRounds.map((value) => ({ ...value })),
          consumedTokens,
          remainingTokens: tokenBudget - consumedTokens,
        });
      }
      if (proposed === undefined || proposed === null || proposed === false
        || (isRecord(proposed) && proposed.stop === true)) {
        stopReason = CAMPAIGN_STOP_REASONS.CALLER_REQUESTED;
        break;
      }
      next = roundDeclaration(proposed, `round ${round + 1}`);
    }

    stopReason ??= CAMPAIGN_STOP_REASONS.MAX_ROUNDS_REACHED;
    const rollup = iterativeRollup(completedRounds, tokenBudget, stopReason);
    const alternativesByRound = completedRounds.map((round) => ({
      round: round.round,
      candidates: round.alternatives.candidates,
    }));
    const aggregate = {
      campaignId,
      target,
      limits: { concurrency, tokenBudget, maxRounds: configuration.maxRounds },
      rounds: completedRounds,
      units: completedRounds.flatMap((round) => round.units),
      rollup,
      stopReason,
      alternatives: {
        status: 'awaiting-planner-decision',
        statement: 'These candidates are alternatives for one goal, grouped by round. No selection has been made; a planner must choose, synthesize, or supply another round.',
        rounds: alternativesByRound,
        candidates: alternativesByRound.flatMap((round) => round.candidates),
      },
    };
    const finalRound = completedRounds.at(-1)?.round ?? 1;
    reportEvent(reporter, campaignId, 'campaign', 'finish', {
      outcome: rollup.outcome,
      counts: rollup.counts,
      consumedTokens: rollup.consumedTokens,
      stopReason,
      completedRounds: completedRounds.length,
      maxRounds: configuration.maxRounds,
    }, { campaignId, round: finalRound, unitId: null, unitKind: null });
    return aggregate;
  } catch (error) {
    if (campaignStarted) {
      reportEvent(reporter, campaignId, 'campaign', 'finish', {
        outcome: 'internal-error',
        phase: 'iterative-rounds',
        completedRounds: completedRounds.length,
        error: error instanceof Error ? error.message : String(error),
      }, {
        campaignId,
        round: completedRounds.at(-1)?.round ?? 1,
        unitId: null,
        unitKind: null,
      });
    }
    throw error;
  }
}
