import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolate } from './isolation.js';
import {
  DEFAULT_EXECUTOR_EFFORT,
  DEFAULT_EXECUTOR_MODEL,
  runExecutor as realExecutor,
} from './executor.js';
import { runGate as realGate } from './gate.js';
import {
  DEFAULT_PROMPT,
  DEFAULT_VERIFIER_MODEL,
  INTENT_PROMPT,
  runVerifier as realVerifier,
} from './verifier.js';
import { buildRunFacts, writeReport } from './report.js';
import { spawnCapture } from './spawn.js';
import { addUsage, EMPTY_USAGE } from './usage.js';
import { resolveTask } from './task.js';
import { resolveStageTimeouts } from './timeouts.js';
import { reportEvent } from './events.js';
import { createGapWatchdog, resolveStallConfig } from './stall-watchdog.js';

// Files the harness itself writes into the isolated directory. They must never enter
// CHANGES.diff (an artifact in the diff would make the `no-op` outcome unreachable) and
// must never be treated as shippable by the installer's payload check. Both consumers
// read this one list so a new artifact cannot be added to one and forgotten in the other.
export const HARNESS_ARTIFACTS = Object.freeze([
  'TASK.md',
  'CHANGES.diff',
  'ccc-report.md',
  'ccc-runfacts.json',
  'events.jsonl',
  'campaign-events.jsonl',
]);

export async function diffText(dir) {
  // Stage first so NEW (untracked) files appear — `git diff HEAD` alone omits them.
  // Harness artifacts live in the worktree so the agents can read them, but must not
  // become part of the proposed change. A pathspec keeps linked worktrees isolated;
  // .git/info/exclude would resolve into and mutate the user's shared common git dir.
  const add = await spawnCapture('git', [
    '-C', dir, 'add', '-A', '--', '.',
    ...HARNESS_ARTIFACTS.map((name) => `:(exclude)${name}`),
  ]);
  if (add.code !== 0) throw new Error(`git add failed in ${dir}: ${add.stderr.trim()}`);
  const r = await spawnCapture('git', ['-C', dir, 'diff', '--cached', 'HEAD']);
  if (r.code !== 0) throw new Error(`git diff failed in ${dir}: ${r.stderr.trim()}`);
  return r.stdout;
}

export function mergeVerifierVerdicts(correctnessVerdict, intentVerdict) {
  return correctnessVerdict === 'NO_BLOCKERS' && intentVerdict === 'NO_BLOCKERS'
    ? 'NO_BLOCKERS'
    : 'ISSUES';
}

function planWithGateFailure(plan, gateResult) {
  const failed = gateResult.results.find((result) => result.code !== 0);
  if (!failed) {
    return `${plan}\n\n## Previous gate attempt failed\n\n` +
      'The previous executor attempt failed the gate, but no failing command details were ' +
      'available. Repair the previous attempt while continuing to follow the original task above.';
  }

  const command = JSON.stringify({ bin: failed.bin, args: failed.args });
  return `${plan}\n\n## Previous gate attempt failed\n\n` +
    'The previous executor attempt failed the gate. Repair this failure while continuing to ' +
    'follow the original task above. This section is retry context, not a new task requirement.\n\n' +
    `Command: ${command}\n` +
    `Exit code: ${failed.code}\n\n` +
    `### Output tail\n\n${failed.outputTail}`;
}

export function planWithStallNotice(plan, stall) {
  const last = stall?.lastEvent ?? {};
  const lastEvent = `${last.stage ?? 'unknown'}/${last.type ?? 'unknown'}`;
  return `${plan}\n\n## Previous executor attempt stalled\n\n` +
    `The previous executor attempt was stopped after ${stall?.gapMs ?? 'an unknown number of'} ` +
    'milliseconds without an event. Continue the original task above, but first inspect the ' +
    'partial work already present in the isolated directory. This section is retry context, ' +
    'not a new task requirement.\n\n' +
    `Last event: ${lastEvent}`;
}

export async function run(opts) {
  const {
    task, target, gate, gateRetries, scratchRoot, runId,
    baseRef = 'HEAD', branch, branchName, campaignId, campaignBase,
    executorModel = DEFAULT_EXECUTOR_MODEL,
    executorEffort = DEFAULT_EXECUTOR_EFFORT,
    verifierModel = DEFAULT_VERIFIER_MODEL,
    adapters = {}, reporter,
  } = opts;
  const runExecutor = adapters.runExecutor ?? realExecutor;
  const runGate = adapters.runGate ?? realGate;
  const runVerifier = adapters.runVerifier ?? realVerifier;
  const plan = resolveTask(task);
  const commands = Array.isArray(gate) ? gate : JSON.parse(readFileSync(gate, 'utf8'));
  const stageTimeouts = resolveStageTimeouts();

  // The reporter is the feature boundary. Without one, do not resolve watchdog settings,
  // allocate its state, arm timers, or create abort controllers.
  let watchdog = null;
  let eventReporter = reporter;
  let stallConfig = null;
  let activeExecutor = null;
  let stallRestartCount = 0;
  let stallRecords = null;
  if (typeof reporter === 'function') {
    stallConfig = {
      ...resolveStallConfig(opts.env ?? process.env),
      ...(opts.stallThresholdMs === undefined ? {} : { thresholdMs: opts.stallThresholdMs }),
      ...(opts.stallPolicy === undefined ? {} : { policy: opts.stallPolicy }),
      ...(opts.stallRestartLimit === undefined ? {} : { restartLimit: opts.stallRestartLimit }),
    };
    stallRecords = [];
    watchdog = createGapWatchdog({
      reporter,
      runId,
      thresholdMs: stallConfig.thresholdMs,
      onStall: (event) => {
        let action = 'report';
        if (stallConfig.policy === 'restart'
          && activeExecutor
          && stallRestartCount < stallConfig.restartLimit) {
          stallRestartCount++;
          action = 'restart';
          activeExecutor.restartEvent = event;
          activeExecutor.controller.abort(event);
        }
        stallRecords.push({
          ts: event.ts,
          stage: event.stage,
          gapMs: event.gapMs,
          thresholdMs: event.thresholdMs,
          lastEvent: event.lastEvent,
          policy: stallConfig.policy,
          action,
          ...(action === 'restart' ? { restart: stallRestartCount } : {}),
        });
      },
    });
    eventReporter = watchdog.reporter;
  }

  try {
  const iso = await isolate({
    target,
    runId,
    scratchRoot,
    reporter: eventReporter,
    baseRef,
    branch,
    branchName,
    campaignId,
    campaignBase,
  });
  writeFileSync(join(iso.dir, 'TASK.md'), plan);
  const iterations = [];
  let gateStatus = 'failed';
  let verdict = null;
  let outcome = 'gate-failed';
  let executorUsage = EMPTY_USAGE;
  let verifierUsage = EMPTY_USAGE;
  let gateFailure = null;
  const timeoutEvents = [];
  let gateRetryCount = 0;
  let executorLaunchCount = 0;

  const recordExecutorTimeout = (exec, iteration, attempt) => {
    if (!exec.timedOut) return;
    timeoutEvents.push({
      stage: 'executor', iteration, attempt,
      timeoutMs: exec.timeoutMs ?? stageTimeouts.executor,
    });
  };
  const recordGateTimeout = (gateResult, iteration, attempt) => {
    for (const result of gateResult?.results ?? []) {
      if (!result.timedOut) continue;
      timeoutEvents.push({
        stage: 'gate', iteration, attempt,
        timeoutMs: result.timeoutMs ?? stageTimeouts.gate,
        bin: result.bin,
        args: result.args,
      });
    }
  };

  const n = 1;
  let iterationExecutorUsage = EMPTY_USAGE;
  const executePlan = async (basePlan) => {
    let attemptPlan = basePlan;
    while (true) {
      const attempt = ++executorLaunchCount;
      const controller = stallConfig?.policy === 'restart'
        && stallRestartCount < stallConfig.restartLimit
        ? new AbortController()
        : null;
      const slot = controller ? { controller, restartEvent: null } : null;
      activeExecutor = slot;
      let result;
      try {
        result = await runExecutor({
          plan: attemptPlan, cwd: iso.dir, model: executorModel, effort: executorEffort,
          timeoutMs: stageTimeouts.executor,
          reporter: eventReporter, runId, attempt,
          ...(controller ? { signal: controller.signal } : {}),
        });
      } finally {
        if (activeExecutor === slot) activeExecutor = null;
      }
      iterationExecutorUsage = addUsage(iterationExecutorUsage, result.usage);
      executorUsage = addUsage(executorUsage, result.usage);
      recordExecutorTimeout(result, n, attempt);
      if (!slot?.restartEvent) return result;

      reportEvent(eventReporter, runId, 'executor', 'retry', {
        attempt: attempt + 1,
        source: 'stall',
        reason: `no event for ${slot.restartEvent.gapMs} ms`,
        gapMs: slot.restartEvent.gapMs,
        lastEvent: slot.restartEvent.lastEvent,
      });
      attemptPlan = planWithStallNotice(basePlan, slot.restartEvent);
    }
  };

  let exec = await executePlan(plan);
  let retries = 0;
  let executorTimedOut = Boolean(exec.timedOut);
  // Gate retries rerun the executor within this single controller-driven pass.
  let gateResult = null;
  if (!executorTimedOut) {
    gateResult = await runGate({
      commands, cwd: iso.dir, timeoutMs: stageTimeouts.gate,
      reporter: eventReporter, runId, attempt: 1,
    });
    recordGateTimeout(gateResult, n, 1);
  }
  while (!executorTimedOut && !gateResult.passed && retries < gateRetries) {
    retries++;
    gateRetryCount++;
    const retryPlan = planWithGateFailure(plan, gateResult);
    const failed = gateResult.results.find((result) => result.code !== 0);
    reportEvent(eventReporter, runId, 'executor', 'retry', {
      attempt: executorLaunchCount + 1,
      source: 'gate',
      reason: failed ? `gate command exited ${failed.code}` : 'gate did not pass',
      ...(failed ? { bin: failed.bin, args: failed.args, code: failed.code } : {}),
    });
    exec = await executePlan(retryPlan);
    executorTimedOut = Boolean(exec.timedOut);
    if (!executorTimedOut) {
      gateResult = await runGate({
        commands, cwd: iso.dir, timeoutMs: stageTimeouts.gate,
        reporter: eventReporter, runId, attempt: retries + 1,
      });
      recordGateTimeout(gateResult, n, retries + 1);
    }
  }
  const iter = { n, changedFiles: exec.changedFiles, lastMessage: exec.lastMessage,
    executorUsage: iterationExecutorUsage,
    executor: {
      exitCode: Number.isInteger(exec.exitCode) ? exec.exitCode : null,
      timedOut: executorTimedOut,
      timeoutMs: exec.timeoutMs ?? stageTimeouts.executor,
    },
    gate: gateResult, verifier: null, intentVerifier: null };

  if (executorTimedOut) {
    gateStatus = gateResult ? 'failed' : 'not-run';
    outcome = 'timed-out';
    iterations.push(iter);
  } else if (!gateResult.passed) {
    gateStatus = 'failed';
    const failed = gateResult.results.find((result) => result.code !== 0);
    outcome = failed?.timedOut ? 'timed-out' : 'gate-failed';
    if (failed) {
      gateFailure = {
        bin: failed.bin,
        args: failed.args,
        code: failed.code,
        ...(failed.timedOut ? { timedOut: true, timeoutMs: failed.timeoutMs } : {}),
        outputTail: failed.outputTail,
      };
    }
    iterations.push(iter);
  } else {
    gateStatus = 'passed';
    reportEvent(eventReporter, runId, 'diff', 'start');
    const diff = await diffText(iso.dir);
    if (diff.trim() === '') {
      reportEvent(eventReporter, runId, 'diff', 'finish', { verdict: 'empty' });
      outcome = 'no-op';
      iterations.push(iter);
    } else {
      writeFileSync(join(iso.dir, 'CHANGES.diff'), diff);
      reportEvent(eventReporter, runId, 'diff', 'finish', {
        verdict: 'produced', file: 'CHANGES.diff',
      });

      const v = await runVerifier({
        cwd: iso.dir, model: verifierModel, prompt: DEFAULT_PROMPT,
        timeoutMs: stageTimeouts.verifier,
        reporter: eventReporter, runId, pass: 'correctness',
      });
      const intentVerifier = await runVerifier({
        cwd: iso.dir, model: verifierModel, prompt: INTENT_PROMPT,
        timeoutMs: stageTimeouts.verifier,
        reporter: eventReporter, runId, pass: 'intent',
      });
      if (v.timedOut) {
        timeoutEvents.push({ stage: 'verifier', pass: 'correctness', iteration: n,
          timeoutMs: v.timeoutMs ?? stageTimeouts.verifier });
      }
      if (intentVerifier.timedOut) {
        timeoutEvents.push({ stage: 'verifier', pass: 'intent', iteration: n,
          timeoutMs: intentVerifier.timeoutMs ?? stageTimeouts.verifier });
      }
      verifierUsage = addUsage(verifierUsage, v.usage);
      verifierUsage = addUsage(verifierUsage, intentVerifier.usage);
      iter.verifier = v;
      iter.intentVerifier = intentVerifier;
      verdict = mergeVerifierVerdicts(v.verdict, intentVerifier.verdict);
      reportEvent(eventReporter, runId, 'verify', 'verdict', {
        verdict, source: 'merged',
      });
      iterations.push(iter);
      outcome = v.timedOut || intentVerifier.timedOut
        ? 'timed-out'
        : v.launchFailed || intentVerifier.launchFailed ? 'verifier-failed' : 'review-ready';
    }
  }

  const lastVerifier = iterations.at(-1)?.verifier;
  const verifierFindings = lastVerifier?.findings ?? null;
  const verdictSource = lastVerifier?.verdictSource ?? null;
  const verifierPlan = lastVerifier?.plan ?? null;
  const lastIntentVerifier = iterations.at(-1)?.intentVerifier;
  const intentVerifierFindings = lastIntentVerifier?.findings ?? null;
  const intentVerdict = lastIntentVerifier?.verdict ?? null;
  const intentVerdictSource = lastIntentVerifier?.verdictSource ?? null;
  const intentVerifierPlan = lastIntentVerifier?.plan ?? null;
  const tokens = {
    executor: executorUsage,
    verifier: verifierUsage,
    total: addUsage(executorUsage, verifierUsage),
  };
  const facts = buildRunFacts({ runId, target, dir: iso.dir, isRepo: iso.isRepo,
    baseRef: iso.baseRef, baseCommit: iso.baseCommit, branch: iso.branch,
    iterations, gateStatus, verdict, verdictSource, verifierFindings,
    verifierPlan, intentVerifierFindings, intentVerdict, intentVerdictSource,
    intentVerifierPlan, gateFailure, tokens, outcome, gateRetries,
    timeouts: stageTimeouts, timeoutEvents,
    supervision: stallConfig ? {
      policy: stallConfig.policy,
      thresholdMs: stallConfig.thresholdMs,
      restartLimit: stallConfig.restartLimit,
      restartCount: stallRestartCount,
      gateRetryCount,
      stallEvents: stallRecords,
    } : null,
    models: {
      executor: executorModel,
      executorEffort,
      verifier: verifierModel,
    } });
  writeReport({ dir: iso.dir, facts, reporter: eventReporter, runId });
  return facts;
  } finally {
    watchdog?.dispose();
  }
}
