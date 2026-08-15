#!/usr/bin/env node
// bin/loop.js
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from '../src/args.js';
import { preflight } from '../src/preflight.js';
import { run } from '../src/run.js';
import { CAMPAIGN_EVENTS_FILENAME, runCampaign } from '../src/campaign.js';
import { exitCodeFor } from '../src/exit.js';
import { formatEventSummary } from '../src/events.js';
import { formatStatus, readStatus } from '../src/status.js';

// Short path, outside OneDrive and outside AppData (both are rejected by
// assertSafeScratchRoot; AppData is MSIX-redirected under a packaged host).
const DEFAULT_SCRATCH = process.platform === 'win32'
  ? 'C:/ccc/w'
  : join(homedir(), '.ccc', 'w');
const SCRATCH_ROOT = process.env.CCC_SCRATCH_ROOT ?? DEFAULT_SCRATCH;

function createCliReporter({ eventsPath, quiet }) {
  // isolate/start precedes creation of the isolated directory. Hold only those opening
  // lines until the directory exists, then append every line exactly once. After that,
  // each event is its own append so a killed process still leaves valid partial NDJSON.
  const pending = [];
  return (event) => {
    if (!quiet) {
      try { process.stderr.write(`${formatEventSummary(event)}\n`); } catch { /* drop sink */ }
    }
    try {
      const line = `${JSON.stringify(event)}\n`;
      if (!existsSync(dirname(eventsPath))) {
        pending.push(line);
        return;
      }
      if (pending.length > 0) appendFileSync(eventsPath, pending.splice(0).join(''));
      appendFileSync(eventsPath, line);
    } catch {
      // Observability must never decide a run's outcome.
    }
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`arg error: ${e.message}\n`);
    process.exit(2);
  }
  if (opts.command === 'status') {
    process.stdout.write(formatStatus(readStatus(opts.runDirectory)));
    return;
  }
  if (opts.command === 'dashboard') {
    // Keep the dashboard entirely out of the run path: its server and file polling code
    // are not even loaded unless this separate command was selected.
    const { startDashboard } = await import('../src/dashboard.js');
    try {
      const dashboard = await startDashboard({
        runDirectory: opts.runDirectory,
        scratchRoot: opts.scratchRoot ?? (opts.runDirectory ? undefined : SCRATCH_ROOT),
        port: opts.port,
      });
      process.stdout.write(`${dashboard.url}\n`);
    } catch (error) {
      process.stderr.write(`dashboard failed: ${error.message}\n`);
      process.exit(2);
    }
    return;
  }
  if (opts.command === 'publish') {
    // Publishing is deliberately absent from the run path. Load its filesystem, Git,
    // and HTTP code only after the operator selects this separate command.
    const { publishRunToForge, redactForgeError } = await import('../src/forge-publisher.js');
    try {
      const published = await publishRunToForge({ runDirectory: opts.runDirectory });
      process.stdout.write(`${published.url}\n`);
    } catch (error) {
      process.stderr.write(`publish failed: ${redactForgeError(error)}\n`);
      process.exit(2);
    }
    return;
  }
  const pf = await preflight({
    task: opts.command === 'run' ? opts.task : undefined,
    tasks: opts.command === 'batch' ? opts.tasks.map((unit) => unit.task) : undefined,
    target: opts.target,
    gate: opts.gate,
    scratchRoot: SCRATCH_ROOT,
  });
  if (!pf.ok) {
    process.stderr.write(`preflight failed: ${pf.reason}\n`);
    process.exit(2);
  }
  if (opts.command === 'batch') {
    const campaignId = `campaign-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const campaignDirectory = join(SCRATCH_ROOT, campaignId);
    const campaignEventsPath = join(campaignDirectory, CAMPAIGN_EVENTS_FILENAME);
    mkdirSync(campaignDirectory, { recursive: true });
    const campaignReporter = createCliReporter({
      eventsPath: campaignEventsPath,
      quiet: opts.quiet,
    });
    const firstRoundTasks = opts.roundPlans?.[0] ?? opts.tasks;
    const aggregate = await runCampaign({
      campaignId,
      tasks: opts.candidateSet ? firstRoundTasks : firstRoundTasks.map((unit) => {
        if (unit.unitKind !== 'candidate') return unit;
        const { unitKind: _legacyDefault, ...legacyUnit } = unit;
        return legacyUnit;
      }),
      ...(opts.candidateSet ? { candidateSet: true } : {}),
      ...(opts.roundPlans === undefined ? {} : {
        maxRounds: opts.maxRounds,
        roundPlans: opts.roundPlans,
      }),
      target: opts.target,
      gate: opts.gate,
      concurrency: opts.concurrency,
      tokenBudget: opts.tokenBudget,
      scratchRoot: SCRATCH_ROOT,
      reporter: campaignReporter,
      unitReporterFactory: ({ unitId }) => createCliReporter({
        eventsPath: join(SCRATCH_ROOT, unitId, 'w', 'events.jsonl'),
        quiet: opts.quiet,
      }),
      runOptions: {
        gateRetries: opts.gateRetries,
        executorModel: opts.executorModel,
        executorEffort: opts.executorEffort,
        verifierModel: opts.verifierModel,
      },
    });
    aggregate.campaignEventsPath = campaignEventsPath;
    process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
    process.exit(exitCodeFor(aggregate.rollup.outcome));
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const eventsPath = join(SCRATCH_ROOT, runId, 'w', 'events.jsonl');
  const reporter = createCliReporter({ eventsPath, quiet: opts.quiet });
  const facts = await run({
    task: opts.task,
    target: opts.target,
    gate: opts.gate,
    gateRetries: opts.gateRetries,
    executorModel: opts.executorModel,
    executorEffort: opts.executorEffort,
    verifierModel: opts.verifierModel,
    scratchRoot: SCRATCH_ROOT,
    runId,
    reporter,
  });
  process.stdout.write(JSON.stringify(facts, null, 2) + '\n');
  process.exit(exitCodeFor(facts.outcome));
}

main().catch((e) => { process.stderr.write(`fatal: ${e.stack}\n`); process.exit(3); });
