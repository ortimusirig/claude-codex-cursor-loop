import { resolve } from 'node:path';
import {
  cleanupDoctorProbeState,
  createDoctorProbeState,
  DOCTOR_CHECKS,
} from './doctor-checks.js';
import { fixFailedCheck, selectedRemediation } from './remediation.js';

export {
  CURSOR_AGENT_INSTALL_COMMANDS,
  cursorAgentInstallCommand,
} from './doctor-checks.js';

function statusLine(status, kind, name, detail, next) {
  return [
    `${status} [${kind}] ${name}: ${detail}`,
    ...(next ? [`  Next: ${next}`] : []),
  ];
}

export async function runDoctor({
  deep = false,
  fix = false,
  scratchRoot,
  repository = process.cwd(),
  nodeVersion = process.versions.node,
  bins = { git: 'git', codex: 'codex', agent: 'agent', gh: 'gh', logdy: 'logdy' },
  consent,
  remediationExecutor,
  write = () => {},
} = {}) {
  if (typeof scratchRoot !== 'string' || scratchRoot === '') {
    throw new TypeError('doctor scratchRoot must be a non-empty string');
  }
  if (fix && deep) throw new Error('doctor --fix cannot be combined with --deep');
  if (fix && typeof consent !== 'function') {
    throw new TypeError('doctor --fix requires a consent function');
  }

  const lines = ['uroboros doctor', '', 'Required checks:'];
  const resolvedScratchRoot = resolve(scratchRoot);
  const state = createDoctorProbeState(resolvedScratchRoot);
  const context = {
    deep,
    scratchRoot: resolvedScratchRoot,
    repository: resolve(repository),
    nodeVersion,
    bins,
    state,
  };
  let requiredFailed = false;

  const runChecks = async (phase) => {
    for (const check of DOCTOR_CHECKS) {
      if (check.phase !== phase) continue;
      const outcome = await check.probe(context);
      if (check.kind === 'required' && outcome.status === 'FAIL') requiredFailed = true;
      const next = selectedRemediation(check, outcome.remediationKey)?.prose;
      lines.push(...statusLine(outcome.status, check.kind, check.name, outcome.detail, next));
      if (fix) {
        await fixFailedCheck({
          check,
          outcome,
          inputs: { scratchRoot: resolvedScratchRoot },
          consent,
          ...(remediationExecutor === undefined ? {} : { executor: remediationExecutor }),
          write,
        });
      }
    }
  };

  try {
    await runChecks('prerequisite');
    await runChecks('deep');

    lines.push('', 'Optional features (these do not affect loop health):');
    lines.push('INFO [optional] GitHub publishing: optional; the loop is fully usable without it.');
    await runChecks('optional');
    lines.push('INFO [optional] Offline run journal: available through `node bin/generate-run-journal.js --help`; no external integration is required.');
  } finally {
    cleanupDoctorProbeState(state);
  }

  lines.push('');
  if (requiredFailed) {
    lines.push('Loop health: UNHEALTHY (one or more required checks failed).');
  } else if (deep) {
    lines.push('Loop health: HEALTHY (all required checks, including the write/read probes, passed).');
  } else {
    lines.push('Loop core health: HEALTHY (all performed required checks passed; Codex and Cursor sign-ins were verified).');
    lines.push('Deep readiness: UNKNOWN (sign-in was verified, but Codex write and Cursor read remain unproven until `--deep`; those probes were SKIPPED, not passed).');
  }
  lines.push('GitHub publishing and Logdy are optional; the loop is fully usable without them.');
  return { ok: !requiredFailed, output: `${lines.join('\n')}\n` };
}
