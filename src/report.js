import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reportEvent } from './events.js';
import { DEFAULT_EXECUTOR_EFFORT, DEFAULT_EXECUTOR_MODEL } from './executor.js';
import { DEFAULT_VERIFIER_MODEL } from './verifier.js';
import { addUsage, EMPTY_USAGE } from './usage.js';

export function buildRunFacts({
  runId,
  target,
  dir,
  isRepo,
  baseRef = 'HEAD',
  baseCommit = null,
  branch,
  iterations,
  gateStatus,
  verdict,
  verdictSource = null,
  verifierFindings,
  verifierPlan = null,
  intentVerifierFindings,
  intentVerdict = null,
  intentVerdictSource = null,
  intentVerifierPlan = null,
  gateFailure = null,
  tokens = {},
  models = {},
  outcome,
  gateRetries,
  timeouts = {},
  timeoutEvents = [],
  supervision = null,
}) {
  const facts = {
    runId, target, dir, isRepo, baseRef, baseCommit, branch,
    model: {
      executor: models?.executor ?? DEFAULT_EXECUTOR_MODEL,
      executorEffort: models?.executorEffort ?? DEFAULT_EXECUTOR_EFFORT,
      verifier: models?.verifier ?? DEFAULT_VERIFIER_MODEL,
    },
    limits: {
      gateRetries,
      timeoutsMs: {
        executor: timeouts.executor ?? null,
        verifier: timeouts.verifier ?? null,
        gate: timeouts.gate ?? null,
      },
    },
    timeoutEvents: Array.isArray(timeoutEvents) ? timeoutEvents : [],
    iterations, gateStatus, verdict,
    verdictSource: verdictSource ?? null,
    verifierFindings: verifierFindings ?? null,
    verifierPlan: verifierPlan ?? null,
    intentVerifierFindings: intentVerifierFindings ?? null,
    intentVerdict: intentVerdict ?? null,
    intentVerdictSource: intentVerdictSource ?? null,
    intentVerifierPlan: intentVerifierPlan ?? null,
    gateFailure: gateFailure ?? null,
    tokens: {
      executor: addUsage(EMPTY_USAGE, tokens?.executor),
      verifier: addUsage(EMPTY_USAGE, tokens?.verifier),
      total: addUsage(EMPTY_USAGE, tokens?.total),
    },
    outcome,
  };
  if (supervision !== null) {
    facts.limits.stall = {
      thresholdMs: supervision.thresholdMs,
      policy: supervision.policy,
      restartLimit: supervision.restartLimit,
    };
    facts.retryCounts = {
      gate: supervision.gateRetryCount,
      stall: supervision.restartCount,
    };
    facts.stallEvents = Array.isArray(supervision.stallEvents) ? supervision.stallEvents : [];
  }
  return facts;
}

function formatUsage(usage) {
  const normalized = addUsage(EMPTY_USAGE, usage);
  return `input: ${normalized.inputTokens}; cached input: ${normalized.cachedInputTokens}; `
    + `output: ${normalized.outputTokens}; reasoning output: ${normalized.reasoningOutputTokens}; `
    + `cache write: ${normalized.cacheWriteTokens}`;
}

function tokenTableRow(label, usage) {
  const normalized = addUsage(EMPTY_USAGE, usage);
  return `| ${label} | ${normalized.inputTokens} | ${normalized.cachedInputTokens} `
    + `| ${normalized.outputTokens} | ${normalized.reasoningOutputTokens} `
    + `| ${normalized.cacheWriteTokens} |`;
}

function tokenLines(facts, style) {
  if (style === 'table') {
    return [
      '| Seat | Input | Cached input | Output | Reasoning output | Cache write |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
      tokenTableRow('Executor', facts.tokens?.executor),
      tokenTableRow('Verifier', facts.tokens?.verifier),
      tokenTableRow('Total', facts.tokens?.total),
    ];
  }
  return [
    `- **Executor:** ${formatUsage(facts.tokens?.executor)}`,
    `- **Verifier:** ${formatUsage(facts.tokens?.verifier)}`,
    `- **Total:** ${formatUsage(facts.tokens?.total)}`,
  ];
}

export function buildReportMarkdown(facts, {
  changedFiles = facts.iterations.at(-1)?.changedFiles ?? [],
  formatChangedFile = (file) => file,
  tokenStyle = 'list',
} = {}) {
  const last = facts.iterations.at(-1) ?? {};
  const configuredTimeouts = facts.limits?.timeoutsMs;
  const md = [
    `# CCC run ${facts.runId}`,
    ``,
    `- **Outcome:** ${facts.outcome}`,
    `- **Gate:** ${facts.gateStatus}`,
    `- **Verdict:** ${facts.verdict ?? 'n/a'} (source: ${facts.verdictSource ?? 'n/a'})`,
    `- **Intent verdict:** ${facts.intentVerdict ?? 'n/a'} (source: ${facts.intentVerdictSource ?? 'n/a'})`,
    `- **Base ref:** ${facts.baseRef}`,
    `- **Base commit:** ${facts.baseCommit}`,
    `- **Branch:** ${facts.branch}`,
    `- **Iterations:** ${facts.iterations.length}`,
    ...(configuredTimeouts && Object.values(configuredTimeouts).some((value) => value !== null)
      ? [`- **Timeouts (ms):** executor ${configuredTimeouts.executor}; verifier ${configuredTimeouts.verifier}; gate ${configuredTimeouts.gate}`]
      : []),
    ...(facts.limits?.stall
      ? [
          `- **Stall policy:** ${facts.limits.stall.policy}; gap ${facts.limits.stall.thresholdMs} ms`,
          `- **Retries used:** gate ${facts.retryCounts?.gate ?? 0}/${facts.limits.gateRetries}; ` +
            `stall ${facts.retryCounts?.stall ?? 0}/${facts.limits.stall.restartLimit}`,
        ]
      : []),
    ...(facts.verdictSource === 'none'
      ? [``, `Correctness verifier: no verdict marker was found; ISSUES is the fail-safe default.`]
      : []),
    ...(facts.intentVerdictSource === 'none'
      ? [``, `Intent verifier: no verdict marker was found; ISSUES is the fail-safe default.`]
      : []),
    ``,
    `## What changed`,
    changedFiles.map((file) => `- ${formatChangedFile(file)}`).join('\n') || '- (nothing)',
    ``,
    `## Why / reasoning`,
    last.lastMessage ?? '(no executor message)',
    ``,
    `## Verifier findings`,
    facts.verifierFindings || '(none recorded)',
    ``,
    `## Intent verifier findings`,
    facts.intentVerifierFindings || '(none recorded)',
  ];
  if (facts.verifierPlan !== null) {
    md.push(``, `## Verifier plan artifact`, facts.verifierPlan || '(empty plan artifact)');
  }
  if (facts.intentVerifierPlan !== null) {
    md.push(``, `## Intent verifier plan artifact`, facts.intentVerifierPlan || '(empty plan artifact)');
  }
  if (facts.gateFailure !== null) {
    const command = [facts.gateFailure.bin, ...(facts.gateFailure.args ?? [])].join(' ');
    md.push(
      ``,
      `## Gate failure`,
      `- **Command:** ${command}`,
      `- **Exit code:** ${facts.gateFailure.code}`,
      ...(facts.gateFailure.timedOut
        ? [`- **Timed out:** yes, after ${facts.gateFailure.timeoutMs} ms`]
        : []),
      ``,
      '```text',
      facts.gateFailure.outputTail ?? '',
      '```',
    );
  }
  if ((facts.timeoutEvents ?? []).length > 0) {
    md.push(``, `## Stage timeouts`);
    for (const event of facts.timeoutEvents) {
      const pass = event.pass ? ` (${event.pass} pass)` : '';
      const attempt = event.attempt ? `, attempt ${event.attempt}` : '';
      const command = event.bin
        ? `, command ${[event.bin, ...(event.args ?? [])].join(' ')}`
        : '';
      md.push(`- ${event.stage}${pass}: timed out after ${event.timeoutMs} ms `
        + `(iteration ${event.iteration}${attempt}${command})`);
    }
  }
  if ((facts.stallEvents ?? []).length > 0) {
    md.push(``, `## Stalls`);
    for (const event of facts.stallEvents) {
      const last = event.lastEvent ?? {};
      const action = event.action === 'restart'
        ? `restart ${event.restart}`
        : 'reported only';
      md.push(`- ${event.stage}: ${event.gapMs} ms gap after ` +
        `${last.stage ?? 'unknown'}/${last.type ?? 'unknown'}; ${action}`);
    }
  }
  md.push(
    ``,
    `## Tokens`,
    ...tokenLines(facts, tokenStyle),
    ``,
  );
  return md.join('\n');
}

export function writeReport({ dir, facts, reporter, runId = facts.runId }) {
  const jsonPath = join(dir, 'ccc-runfacts.json');
  const mdPath = join(dir, 'ccc-report.md');
  reportEvent(reporter, runId, 'report', 'start', {
    files: ['ccc-runfacts.json', 'ccc-report.md'],
  });
  writeFileSync(jsonPath, JSON.stringify(facts, null, 2));
  const markdown = buildReportMarkdown(facts);
  writeFileSync(mdPath, markdown);
  reportEvent(reporter, runId, 'report', 'finish', {
    file: 'ccc-runfacts.json', files: ['ccc-runfacts.json', 'ccc-report.md'],
  });
  return { jsonPath, mdPath };
}
