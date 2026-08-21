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
import { CLI_USAGE } from '../src/cli-help.js';
import {
  createHeadlessInteraction,
  formatHeadlessSetupSummary,
} from '../src/cli-interaction.js';
import {
  formatDashboardAnnouncement,
  launchDashboard,
} from '../src/dashboard-launcher.js';
import { readEnv } from '../src/env-compat.js';

// Short path, outside OneDrive and outside AppData (both are rejected by
// assertSafeScratchRoot; AppData is MSIX-redirected under a packaged host).
const DEFAULT_SCRATCH = process.platform === 'win32'
  ? 'C:/uro/w'
  : join(homedir(), '.uro', 'w');
const SCRATCH_ROOT = readEnv(process.env, 'SCRATCH_ROOT') ?? DEFAULT_SCRATCH;

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
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stderr.write(`${CLI_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`arg error: ${e.message}\n`);
    if (/^unknown command:/.test(e.message)) process.stderr.write(`${CLI_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (opts.command === 'help') {
    process.stdout.write(`${CLI_USAGE}\n`);
    return;
  }
  if (opts.command === 'doctor') {
    const { runDoctor } = await import('../src/doctor.js');
    const headless = !process.stdin.isTTY;
    let prompt;
    let interaction;
    if (opts.fix && headless) {
      interaction = createHeadlessInteraction({
        yes: opts.yes,
        write: (text) => process.stdout.write(text),
      });
    } else if (opts.fix) {
      const { createInterface } = await import('node:readline/promises');
      prompt = createInterface({ input: process.stdin, output: process.stdout });
    }
    let result;
    try {
      result = await runDoctor({
        deep: opts.deep,
        fix: opts.fix,
        scratchRoot: opts.scratchRoot ?? SCRATCH_ROOT,
        repository: opts.repository,
        ...(opts.fix ? {
          consent: interaction?.consent ?? ((question) => prompt.question(question)),
          write: (text) => process.stdout.write(text),
        } : {}),
      });
    } finally {
      prompt?.close();
    }
    process.stdout.write(result.output);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (opts.command === 'setup') {
    const { runSetup } = await import('../src/setup.js');
    const headless = !process.stdin.isTTY;
    let prompt;
    let interaction;
    if (headless) {
      interaction = createHeadlessInteraction({
        yes: opts.yes,
        write: (text) => process.stdout.write(text),
      });
    } else {
      const { createInterface } = await import('node:readline/promises');
      prompt = createInterface({ input: process.stdin, output: process.stdout });
    }
    let result;
    try {
      result = await runSetup({
        scratchRoot: opts.scratchRoot ?? SCRATCH_ROOT,
        operatorDirectory: process.cwd(),
        consent: interaction?.consent ?? ((question) => prompt.question(question)),
        wait: interaction?.wait ?? ((question) => prompt.question(question)),
        write: (text) => process.stdout.write(text),
      });
    } finally {
      prompt?.close();
    }
    if (headless && !result.ok) {
      process.stdout.write(formatHeadlessSetupSummary(result.outcomes, {
        scratchRoot: opts.scratchRoot ?? SCRATCH_ROOT,
        status: result.status,
        restartRequired: result.restartRequired,
      }));
    }
    if (!result.ok && (headless || !['restart-required', 'stopped'].includes(result.status))) {
      process.exitCode = 1;
    }
    return;
  }
  if (opts.command === 'init') {
    const { scaffold } = await import('../src/init.js');
    try {
      const result = scaffold(opts.directory);
      process.stdout.write(`Created ${result.planPath}\nCreated ${result.gatePath}\n`);
    } catch (error) {
      process.stderr.write(`init failed: ${error.message}\n`);
      process.exitCode = 2;
    }
    return;
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
    // and GitHub CLI code only after the operator selects this separate command.
    const { publishRunToGitHub } = await import('../src/github-publisher.js');
    try {
      const published = await publishRunToGitHub({
        runDirectory: opts.runDirectory,
        ghBin: readEnv(process.env, 'GH_BIN') ?? 'gh',
      });
      process.stdout.write(`${published.url}\n`);
    } catch (error) {
      process.stderr.write(`publish failed: ${error.message}\n`);
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
    correctsRunId: opts.command === 'run' ? opts.correctsRunId : undefined,
  });
  if (!pf.ok) {
    process.stderr.write(`preflight failed: ${pf.reason}\n`);
    process.exit(2);
  }
  // The launcher only starts the separate dashboard command. The run path never
  // imports the dashboard server or its view/polling implementation.
  let dashboardResult;
  try {
    dashboardResult = await launchDashboard(SCRATCH_ROOT, {
      disabled: opts.noDashboard,
      open: opts.open,
      port: opts.port,
    });
  } catch (error) {
    // Defense in depth: observability can never decide the run's outcome.
    dashboardResult = {
      status: 'unavailable',
      reason: `dashboard launcher failed: ${error?.message ?? String(error)}`,
    };
  }
  if (!opts.quiet) {
    const announcement = formatDashboardAnnouncement(dashboardResult, SCRATCH_ROOT, {
      port: opts.port,
    });
    if (announcement) {
      try { process.stderr.write(announcement); } catch { /* drop sink */ }
    }
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
    correctsRunId: opts.correctsRunId,
    scratchRoot: SCRATCH_ROOT,
    runId,
    reporter,
  });
  process.stdout.write(JSON.stringify(facts, null, 2) + '\n');
  process.exit(exitCodeFor(facts.outcome));
}

main().catch((e) => { process.stderr.write(`fatal: ${e.stack}\n`); process.exit(3); });
