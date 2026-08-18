import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  cleanupDoctorProbeState,
  createDoctorProbeState,
  DOCTOR_CHECKS,
} from './doctor-checks.js';
import { formatEventSummary } from './events.js';
import { scaffold } from './init.js';
import { selectedRemediation, fixFailedCheck } from './remediation.js';
import { run } from './run.js';
import { spawnCapture } from './spawn.js';

const DEMO_PLAN = `# Setup demo

Create a new file named hello-from-ccc.txt containing one short sentence that says this change
was made by the CCC setup demo. Do not modify plan.md or gate.json.
`;

const DEFAULT_BINS = Object.freeze({
  git: 'git', codex: 'codex', agent: 'agent', gh: 'gh', logdy: 'logdy',
});

function isPathInside(parent, candidate) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function requiredPrerequisiteChecks(checks) {
  return checks.filter((check) => check.kind === 'required' && check.phase === 'prerequisite');
}

export async function probeSetupPrerequisites({
  checks = DOCTOR_CHECKS,
  scratchRoot,
  nodeVersion = process.versions.node,
  bins = DEFAULT_BINS,
}) {
  const resolvedScratchRoot = resolve(scratchRoot);
  const state = createDoctorProbeState(resolvedScratchRoot);
  const context = {
    deep: false,
    scratchRoot: resolvedScratchRoot,
    repository: resolvedScratchRoot,
    nodeVersion,
    bins,
    state,
  };
  const outcomes = [];
  try {
    for (const check of requiredPrerequisiteChecks(checks)) {
      outcomes.push({ check, outcome: await check.probe(context) });
    }
  } finally {
    cleanupDoctorProbeState(state);
  }
  return outcomes;
}

async function checkedGit(gitBin, args, cwd) {
  const result = await spawnCapture(gitBin, args, { cwd });
  if (result.code !== 0 || result.timedOut) {
    throw new Error(result.stderr.trim() || `${gitBin} ${args.join(' ')} exited ${result.code}`);
  }
}

export async function initializeDemoRepository(directory, { git = 'git' } = {}) {
  await checkedGit(git, ['init', '-b', 'ccc-setup'], directory);
  await checkedGit(git, ['add', '-A'], directory);
  await checkedGit(git, [
    '-c', 'user.email=ccc@local', '-c', 'user.name=ccc setup',
    'commit', '-m', 'CCC setup demo baseline',
  ], directory);
}

function printInstruction(write, remediation) {
  if (remediation?.prose) write(`${remediation.prose}\n`);
}

function stoppedResult(status, outcomes) {
  return { ok: false, status, outcomes };
}

export async function runSetup({
  scratchRoot,
  operatorDirectory,
  nodeVersion = process.versions.node,
  bins = DEFAULT_BINS,
  checks = DOCTOR_CHECKS,
  consent,
  wait,
  write = () => {},
  remediationExecutor,
  probe = probeSetupPrerequisites,
  scaffolder = scaffold,
  repositoryInitializer = initializeDemoRepository,
  demoRunner = run,
  id = randomUUID,
} = {}) {
  if (typeof scratchRoot !== 'string' || scratchRoot === '') {
    throw new TypeError('setup scratchRoot must be a non-empty string');
  }
  if (typeof consent !== 'function') throw new TypeError('setup requires a consent function');
  if (typeof wait !== 'function') throw new TypeError('setup requires a wait function');

  const resolvedScratchRoot = resolve(scratchRoot);
  if (operatorDirectory && isPathInside(operatorDirectory, resolvedScratchRoot)) {
    write('Setup paused: the scratch root must not be the current working directory or inside it.\n');
    return stoppedResult('unsafe-destination', []);
  }
  const autoAttempted = new Set();
  const installAttemptedOrInstructed = new Set();
  const instructionWaited = new Set();
  const checkCount = Math.max(1, requiredPrerequisiteChecks(checks).length);
  let outcomes = [];

  // Every check can consume at most one automatic attempt and one instruction wait.
  // The cap is defense in depth: even adversarial injected prompts cannot make this loop unbounded.
  for (let pass = 0; pass <= (checkCount * 2); pass++) {
    outcomes = await probe({ checks, scratchRoot: resolvedScratchRoot, nodeVersion, bins });
    const incomplete = outcomes.filter(({ outcome }) => outcome.status !== 'PASS');
    if (incomplete.length === 0) {
      for (const { check, outcome } of outcomes) {
        write(`PASS [required] ${check.name}: ${outcome.detail}\n`);
      }
      break;
    }

    let shouldReprobe = false;
    let operatorStopped = false;
    const restartRequired = [];

    for (const { check, outcome } of outcomes) {
      if (outcome.status === 'PASS') {
        write(`PASS [required] ${check.name}: ${outcome.detail}\n`);
        continue;
      }
      if (outcome.status === 'SKIP') {
        write(`SKIP [required] ${check.name}: ${outcome.detail}\n`);
        continue;
      }

      if (installAttemptedOrInstructed.has(check.id) && outcome.reason === 'not-on-path') {
        write(`RESTART REQUIRED [required] ${check.name}: installed but not yet visible on PATH.\n`);
        restartRequired.push(check.id);
        continue;
      }

      write(`FAIL [required] ${check.name}: ${outcome.detail}\n`);
      const remediation = selectedRemediation(check, outcome.remediationKey);
      if (remediation?.autoFixable && remediation.command && !autoAttempted.has(check.id)) {
        autoAttempted.add(check.id);
        const fixed = await fixFailedCheck({
          check,
          outcome,
          inputs: { scratchRoot: resolvedScratchRoot },
          consent,
          ...(remediationExecutor === undefined ? {} : { executor: remediationExecutor }),
          write,
        });
        if (fixed.attempted) {
          installAttemptedOrInstructed.add(check.id);
          shouldReprobe = true;
          continue;
        }
        // Refusal is report-only, but the other checks still get their turn below.
      }

      printInstruction(write, remediation);
      if (!instructionWaited.has(check.id)) {
        instructionWaited.add(check.id);
        if (remediation?.prose) installAttemptedOrInstructed.add(check.id);
        const answer = await wait(
          `Press Enter after following the instruction for ${check.name}, or type q to stop: `,
          { check, outcome },
        );
        if (answer === false || /^(?:q|quit|stop)$/i.test(String(answer).trim())) {
          operatorStopped = true;
        } else {
          shouldReprobe = true;
        }
      }
    }

    if (restartRequired.length > 0) {
      write('Setup paused: restart the terminal, then run setup again.\n');
      return { ...stoppedResult('restart-required', outcomes), restartRequired };
    }
    if (operatorStopped) {
      write('Setup stopped by the operator.\n');
      return stoppedResult('stopped', outcomes);
    }
    if (!shouldReprobe) {
      write('Setup paused: required checks are still not green.\n');
      return stoppedResult('prerequisite-incomplete', outcomes);
    }
  }

  if (outcomes.some(({ outcome }) => outcome.status !== 'PASS')) {
    write('Setup paused: required checks are still not green.\n');
    return stoppedResult('prerequisite-incomplete', outcomes);
  }

  const invocationId = id();
  const demoDirectory = resolve(resolvedScratchRoot, `ccc-setup-demo-${invocationId}`);
  if (!isPathInside(resolvedScratchRoot, demoDirectory)) {
    throw new Error('setup demo directory escaped the scratch root');
  }

  let scaffolded;
  try {
    scaffolded = scaffolder(demoDirectory);
    if (!isPathInside(demoDirectory, scaffolded.planPath)
      || !isPathInside(demoDirectory, scaffolded.gatePath)) {
      throw new Error('init returned a path outside the setup demo directory');
    }
    writeFileSync(scaffolded.planPath, DEMO_PLAN);
    writeFileSync(join(demoDirectory, 'demo-source.txt'), 'CCC setup demo source.\n');
    await repositoryInitializer(demoDirectory, { git: bins.git });
  } catch (error) {
    write(`DEMO PREPARATION FAILED: ${error.message}\n`);
    return { ok: false, status: 'demo-preparation-failed', outcomes, error, demoDirectory };
  }

  write(`Demo project: ${demoDirectory}\n`);
  write('Starting one real observed run.\n');
  let facts;
  try {
    facts = await demoRunner({
      task: scaffolded.planPath,
      target: demoDirectory,
      gate: scaffolded.gatePath,
      gateRetries: 0,
      scratchRoot: resolvedScratchRoot,
      runId: `setup-run-${invocationId}`,
      reporter: (event) => write(`${formatEventSummary(event)}\n`),
    });
  } catch (error) {
    write(`DEMO RUN FAILED: ${error.message}\n`);
    write('Prerequisites were green; this is a demo-run failure, not a broken installation.\n');
    return { ok: false, status: 'demo-failed', outcomes, error, demoDirectory };
  }

  const changedFiles = facts.iterations?.at(-1)?.changedFiles ?? [];
  if (facts.outcome !== 'review-ready' || changedFiles.length === 0) {
    write(`DEMO RUN FAILED: outcome ${facts.outcome}; gate ${facts.gateStatus}.\n`);
    write('Prerequisites were green; this is a demo-run failure, not a broken installation.\n');
    return { ok: false, status: 'demo-failed', outcomes, facts, demoDirectory };
  }

  write(`Setup complete: isolated worktree ${facts.dir}\n`);
  write(`Gate: ${facts.gateStatus}\n`);
  write(`Verifier verdict: ${facts.verdict ?? 'n/a'}\n`);
  write(`Diff files: ${changedFiles.join(', ')}\n`);
  return { ok: true, status: 'complete', outcomes, facts, demoDirectory };
}
