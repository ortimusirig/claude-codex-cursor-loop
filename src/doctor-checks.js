import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildCodexArgs } from './executor.js';
import { assertSafeScratchRoot } from './isolation.js';
import { commandExists, spawnCapture } from './spawn.js';
import { buildCursorArgs } from './verifier.js';

const MINIMUM_NODE_MAJOR = 24;
const CHEAP_PROBE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 180_000;
const WRITE_FILENAME = 'ccc-doctor-write.txt';
const WRITE_CONTENT = 'CCC_DOCTOR_WRITE_OK\n';

export const CURSOR_AGENT_INSTALL_COMMANDS = Object.freeze({
  win32: "irm 'https://cursor.com/install?win32=true' | iex",
  other: 'curl https://cursor.com/install -fsS | bash',
});

export function cursorAgentInstallCommand(platform = process.platform) {
  return platform === 'win32'
    ? CURSOR_AGENT_INSTALL_COMMANDS.win32
    : CURSOR_AGENT_INSTALL_COMMANDS.other;
}

function spawnCommand(binary, args) {
  return Object.freeze({ type: 'spawn', binary, args: Object.freeze(args) });
}

function shellCommand(command, platform) {
  return Object.freeze({ type: 'shell', command, platform });
}

function remediation(prose, command, autoFixable, variants = undefined) {
  return Object.freeze({
    prose,
    command,
    autoFixable,
    ...(variants ? { variants: Object.freeze(variants) } : {}),
  });
}

async function installedAndUsable(bin, args) {
  if (!(await commandExists(bin))) return { installed: false, usable: false, result: null };
  try {
    const result = await spawnCapture(bin, args, { timeoutMs: CHEAP_PROBE_TIMEOUT_MS });
    return { installed: true, usable: result.code === 0 && !result.timedOut, result };
  } catch (error) {
    return { installed: true, usable: false, result: null, error };
  }
}

async function signInStatus(bin, args) {
  try {
    const result = await spawnCapture(bin, args, { timeoutMs: CHEAP_PROBE_TIMEOUT_MS });
    return { signedIn: result.code === 0 && !result.timedOut, result };
  } catch (error) {
    return { signedIn: false, result: null, error };
  }
}

function signInFailureDetail(command, status) {
  if (status.error) return `\`${command}\` could not run: ${status.error.message}`;
  if (status.result.timedOut) return `\`${command}\` timed out`;
  return `\`${command}\` exited ${status.result.code}`;
}

function missingDirectories(path) {
  const missing = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

function removeCreatedDirectories(missing) {
  for (const path of missing) {
    try { rmdirSync(path); } catch { /* Retain a directory if another process used it. */ }
  }
}

async function initializeProbeRepository(gitBin, directory) {
  const init = await spawnCapture(gitBin, ['init', '-b', 'ccc-doctor'], {
    cwd: directory,
    timeoutMs: 30_000,
  });
  if (init.code !== 0 || init.timedOut) {
    throw new Error(init.stderr.trim() || `git init exited ${init.code}`);
  }
  writeFileSync(join(directory, 'README.md'), 'Disposable ccc doctor repository.\n');
  const add = await spawnCapture(gitBin, ['add', '-A'], { cwd: directory, timeoutMs: 30_000 });
  if (add.code !== 0 || add.timedOut) throw new Error(add.stderr.trim() || `git add exited ${add.code}`);
  const commit = await spawnCapture(gitBin, [
    '-c', 'user.email=ccc@local', '-c', 'user.name=ccc doctor',
    'commit', '-m', 'doctor baseline',
  ], { cwd: directory, timeoutMs: 30_000 });
  if (commit.code !== 0 || commit.timedOut) {
    throw new Error(commit.stderr.trim() || `git commit exited ${commit.code}`);
  }
}

async function probeCodex(bin, gitBin, workspace) {
  const directory = join(workspace, 'codex-write');
  mkdirSync(directory);
  await initializeProbeRepository(gitBin, directory);
  const outputPath = join(directory, WRITE_FILENAME);
  const prompt = `Create ${WRITE_FILENAME} in the current repository with exactly ${WRITE_CONTENT.trim()} followed by a newline. You must write the file; do not merely describe it.`;
  const result = await spawnCapture(bin, buildCodexArgs({ cwd: directory }), {
    cwd: directory,
    input: prompt,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const wroteExpectedFile = existsSync(outputPath)
    && readFileSync(outputPath, 'utf8') === WRITE_CONTENT;
  return { passed: result.code === 0 && !result.timedOut && wroteExpectedFile, result };
}

async function probeAgent(bin, workspace) {
  const directory = join(workspace, 'cursor-read');
  mkdirSync(directory);
  const token = `CCC_DOCTOR_READ_${randomUUID()}`;
  const inputPath = join(directory, 'ccc-doctor-read.txt');
  writeFileSync(inputPath, `${token}\n`);
  const prompt = 'Read ccc-doctor-read.txt and return its exact contents. This is a read-only diagnostic; do not create, edit, or delete any file.';
  const before = readdirSync(directory).sort();
  const result = await spawnCapture(bin, buildCursorArgs({ prompt }), {
    cwd: directory,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const after = readdirSync(directory).sort();
  const stayedReadOnly = JSON.stringify(after) === JSON.stringify(before)
    && readFileSync(inputPath, 'utf8') === `${token}\n`;
  return {
    passed: result.code === 0 && !result.timedOut && result.stdout.includes(token) && stayedReadOnly,
    result,
  };
}

async function githubRemote(gitBin, repository) {
  try {
    const result = await spawnCapture(gitBin, ['-C', repository, 'remote', '-v'], {
      timeoutMs: 30_000,
    });
    return result.code === 0 && /github[.]com(?::|\/)/i.test(result.stdout);
  } catch {
    return false;
  }
}

const cursorInstallPlatform = process.platform === 'win32' ? 'win32' : 'posix';
const cursorInstallProse = `run \`${cursorAgentInstallCommand()}\`${process.platform === 'win32' ? ' in Windows PowerShell' : ''}, reopen the terminal, confirm the binary is \`agent\`, and run \`agent login\`.`;
const deepRerunProse = '`node bin/loop.js doctor --deep` (this spends Codex/Cursor tokens).';

export const DOCTOR_CHECKS = Object.freeze([
  Object.freeze({
    id: 'node-version',
    phase: 'prerequisite',
    kind: 'required',
    name: 'Node version',
    remediation: remediation(
      '`node --version`; install Node.js 24 or newer from https://nodejs.org/ and rerun doctor.',
      null,
      false,
    ),
    probe: async ({ nodeVersion }) => {
      const nodeMajor = Number.parseInt(nodeVersion.split('.')[0], 10);
      return Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR
        ? { status: 'PASS', detail: `${nodeVersion} meets >=${MINIMUM_NODE_MAJOR}` }
        : {
            status: 'FAIL',
            detail: `${nodeVersion} does not meet >=${MINIMUM_NODE_MAJOR}`,
            reason: 'version-unsupported',
            remediationKey: 'default',
          };
    },
  }),
  Object.freeze({
    id: 'git-usable',
    phase: 'prerequisite',
    kind: 'required',
    name: 'git usable',
    remediation: remediation(
      'install Git from https://git-scm.com/downloads, reopen the terminal, and run `git --version`.',
      null,
      false,
      {
        unusable: Object.freeze({
          prose: 'repair Git until `git --version` exits 0, then rerun doctor.',
          command: null,
          autoFixable: false,
        }),
      },
    ),
    probe: async ({ bins, state }) => {
      const git = await installedAndUsable(bins.git, ['--version']);
      state.git = git;
      if (!git.installed) {
        return {
          status: 'FAIL',
          detail: `${bins.git} was not found on PATH`,
          reason: 'not-on-path',
          remediationKey: 'default',
        };
      }
      if (!git.usable) {
        return {
          status: 'FAIL',
          detail: '`git --version` did not complete successfully',
          remediationKey: 'unusable',
        };
      }
      return { status: 'PASS', detail: git.result.stdout.trim() || 'command exited 0' };
    },
  }),
  Object.freeze({
    id: 'codex-cli-installed',
    phase: 'prerequisite',
    kind: 'required',
    name: 'Codex CLI installed',
    remediation: remediation(
      'run `npm install -g @openai/codex`, then run `codex` in a terminal to sign in.',
      spawnCommand('npm', ['install', '-g', '@openai/codex']),
      true,
    ),
    probe: async ({ bins, state }) => {
      const present = await commandExists(bins.codex);
      state.codexPresent = present;
      return present
        ? { status: 'PASS', detail: `${bins.codex} was found; write ability is reported separately` }
        : {
            status: 'FAIL',
            detail: `${bins.codex} was not found on PATH`,
            reason: 'not-on-path',
            remediationKey: 'default',
          };
    },
  }),
  Object.freeze({
    id: 'codex-signed-in',
    phase: 'prerequisite',
    kind: 'required',
    name: 'Codex signed in',
    remediation: remediation(
      'run `codex login`; if that does not help, update or reinstall the Codex CLI, then rerun doctor.',
      spawnCommand('codex', ['login']),
      false,
    ),
    probe: async ({ bins, state }) => {
      if (!state.codexPresent) {
        return {
          status: 'SKIP',
          detail: 'not checked because the Codex CLI is not installed yet',
        };
      }
      const status = await signInStatus(bins.codex, ['login', 'status']);
      return status.signedIn
        ? { status: 'PASS', detail: '`codex login status` exited 0' }
        : {
            status: 'FAIL',
            detail: signInFailureDetail('codex login status', status),
            remediationKey: 'default',
          };
    },
  }),
  Object.freeze({
    id: 'cursor-agent-installed',
    phase: 'prerequisite',
    kind: 'required',
    name: 'Cursor agent installed',
    remediation: remediation(
      cursorInstallProse,
      shellCommand(cursorAgentInstallCommand(), cursorInstallPlatform),
      true,
    ),
    probe: async ({ bins, state }) => {
      const present = await commandExists(bins.agent);
      state.agentPresent = present;
      return present
        ? { status: 'PASS', detail: `${bins.agent} was found; read ability is reported separately` }
        : {
            status: 'FAIL',
            detail: `${bins.agent} was not found on PATH`,
            reason: 'not-on-path',
            remediationKey: 'default',
          };
    },
  }),
  Object.freeze({
    id: 'cursor-signed-in',
    phase: 'prerequisite',
    kind: 'required',
    name: 'Cursor signed in',
    remediation: remediation(
      'run `agent login`; if that does not help, run `agent update` or reinstall the Cursor Agent CLI, then rerun doctor.',
      spawnCommand('agent', ['login']),
      false,
    ),
    probe: async ({ bins, state }) => {
      if (!state.agentPresent) {
        return {
          status: 'SKIP',
          detail: 'not checked because the Cursor Agent CLI is not installed yet',
        };
      }
      const status = await signInStatus(bins.agent, ['status']);
      return status.signedIn
        ? { status: 'PASS', detail: '`agent status` exited 0' }
        : {
            status: 'FAIL',
            detail: signInFailureDetail('agent status', status),
            remediationKey: 'default',
          };
    },
  }),
  Object.freeze({
    id: 'scratch-root-location',
    phase: 'prerequisite',
    kind: 'required',
    name: 'Scratch root location',
    remediation: remediation(
      'set `CCC_SCRATCH_ROOT` to a short local path outside AppData and OneDrive (for example `C:\\ccc\\w`) and rerun doctor.',
      null,
      false,
    ),
    probe: async ({ scratchRoot, state }) => {
      try {
        assertSafeScratchRoot(scratchRoot);
        state.scratchSafe = true;
        return { status: 'PASS', detail: `${scratchRoot} is outside AppData and OneDrive` };
      } catch (error) {
        state.scratchSafe = false;
        return { status: 'FAIL', detail: error.message, remediationKey: 'default' };
      }
    },
  }),
  Object.freeze({
    id: 'scratch-root-writable',
    phase: 'prerequisite',
    kind: 'required',
    name: 'Scratch root writable',
    remediation: remediation(
      'grant write access to this directory or set `CCC_SCRATCH_ROOT` to a writable local path, then rerun doctor.',
      Object.freeze({
        type: 'mkdir',
        path: Object.freeze({ from: 'input', name: 'scratchRoot' }),
        recursive: true,
      }),
      true,
      {
        unsafe: Object.freeze({
          prose: 'set `CCC_SCRATCH_ROOT` to a writable local path outside AppData and OneDrive, then rerun doctor.',
          command: null,
          autoFixable: false,
        }),
      },
    ),
    probe: async ({ scratchRoot, state }) => {
      if (!state.scratchSafe) {
        return {
          status: 'FAIL',
          detail: 'not tested because the configured path is unsafe',
          remediationKey: 'unsafe',
        };
      }
      try {
        mkdirSync(scratchRoot, { recursive: true });
        state.workspace = mkdtempSync(join(scratchRoot, '.ccc-doctor-'));
        const marker = join(state.workspace, 'write-check.txt');
        writeFileSync(marker, 'writable\n');
        state.scratchWritable = readFileSync(marker, 'utf8') === 'writable\n';
        if (!state.scratchWritable) throw new Error('disposable write did not round-trip');
      } catch (error) {
        return {
          status: 'FAIL',
          detail: `${scratchRoot}: ${error.message}`,
          remediationKey: 'default',
        };
      }
      return { status: 'PASS', detail: `${scratchRoot} accepted a disposable write` };
    },
  }),
  Object.freeze({
    id: 'codex-write-probe',
    phase: 'deep',
    kind: 'required',
    name: 'Codex write probe',
    remediation: remediation(
      deepRerunProse,
      spawnCommand('node', ['bin/loop.js', 'doctor', '--deep']),
      false,
      {
        failed: Object.freeze({
          prose: 'run `codex` to sign in, fix write-blocking hooks or sandbox errors, then rerun `node bin/loop.js doctor --deep`.',
          command: null,
          autoFixable: false,
        }),
        prerequisite: Object.freeze({
          prose: 'fix the failed prerequisite above, then rerun `node bin/loop.js doctor --deep`.',
          command: null,
          autoFixable: false,
        }),
      },
    ),
    probe: async ({ bins, deep, state }) => {
      if (!deep) {
        return {
          status: 'SKIP',
          detail: 'not performed; it was not passed off as a success',
          remediationKey: 'default',
        };
      }
      if (!(state.codexPresent && state.git.usable && state.workspace)) {
        return {
          status: 'FAIL',
          detail: 'could not run because Codex, git, or scratch storage failed a prerequisite',
          remediationKey: 'prerequisite',
        };
      }
      try {
        const probe = await probeCodex(bins.codex, bins.git, state.workspace);
        return probe.passed
          ? {
              status: 'PASS',
              detail: `created ${WRITE_FILENAME} with the requested content in a disposable Git repository`,
            }
          : {
              status: 'FAIL',
              detail: `Codex exited ${probe.result.code} or did not create the requested file`,
              remediationKey: 'failed',
            };
      } catch (error) {
        return { status: 'FAIL', detail: error.message, remediationKey: 'failed' };
      }
    },
  }),
  Object.freeze({
    id: 'cursor-read-probe',
    phase: 'deep',
    kind: 'required',
    name: 'Cursor read probe',
    remediation: remediation(
      deepRerunProse,
      spawnCommand('node', ['bin/loop.js', 'doctor', '--deep']),
      false,
      {
        failed: Object.freeze({
          prose: 'run `agent login`, disable or repair hooks blocking read tools, then rerun `node bin/loop.js doctor --deep`.',
          command: null,
          autoFixable: false,
        }),
        prerequisite: Object.freeze({
          prose: 'fix the failed prerequisite above, then rerun `node bin/loop.js doctor --deep`.',
          command: null,
          autoFixable: false,
        }),
      },
    ),
    probe: async ({ bins, deep, state }) => {
      if (!deep) {
        return {
          status: 'SKIP',
          detail: 'not performed; it was not passed off as a success',
          remediationKey: 'default',
        };
      }
      if (!(state.agentPresent && state.workspace)) {
        return {
          status: 'FAIL',
          detail: 'could not run because the agent or scratch storage failed a prerequisite',
          remediationKey: 'prerequisite',
        };
      }
      try {
        const probe = await probeAgent(bins.agent, state.workspace);
        return probe.passed
          ? {
              status: 'PASS',
              detail: 'returned the unpredictable contents of a scratch file and left the directory unchanged',
            }
          : {
              status: 'FAIL',
              detail: `agent exited ${probe.result.code}, did not return the file content, or modified the directory`,
              remediationKey: 'failed',
            };
      } catch (error) {
        return { status: 'FAIL', detail: error.message, remediationKey: 'failed' };
      }
    },
  }),
  Object.freeze({
    id: 'github-cli-installed',
    phase: 'optional',
    kind: 'optional',
    name: 'GitHub CLI installed',
    remediation: remediation(
      'create an account at https://github.com/signup, install `gh` from https://cli.github.com/, run `gh auth login`, then run `gh repo create OWNER/REPOSITORY --source=. --remote=origin --private --push` from the existing local repository (use `--public` if desired).',
      null,
      false,
    ),
    probe: async ({ bins, state }) => {
      const present = await commandExists(bins.gh);
      state.ghPresent = present;
      return present
        ? { status: 'PASS', detail: `${bins.gh} was found` }
        : {
            status: 'FAIL',
            detail: `${bins.gh} was not found on PATH`,
            remediationKey: 'default',
          };
    },
  }),
  Object.freeze({
    id: 'github-authentication',
    phase: 'optional',
    kind: 'optional',
    name: 'GitHub authentication',
    remediation: remediation(
      'run `gh auth login`, then confirm with `gh auth status`.',
      spawnCommand('gh', ['auth', 'login']),
      false,
    ),
    probe: async ({ bins, state }) => {
      let authenticated = false;
      if (state.ghPresent) {
        try {
          const auth = await spawnCapture(bins.gh, ['auth', 'status'], { timeoutMs: 30_000 });
          authenticated = auth.code === 0 && !auth.timedOut;
        } catch { /* Report the unmet precondition below. */ }
      }
      return authenticated
        ? { status: 'PASS', detail: '`gh auth status` exited 0' }
        : {
            status: 'FAIL',
            detail: state.ghPresent
              ? '`gh auth status` did not succeed'
              : 'not checkable until GitHub CLI is installed',
            remediationKey: 'default',
          };
    },
  }),
  Object.freeze({
    id: 'github-remote',
    phase: 'optional',
    kind: 'optional',
    name: 'GitHub remote',
    remediation: remediation(
      'from the existing local repository run `gh repo create OWNER/REPOSITORY --source=. --remote=origin --private --push` (or replace `--private` with `--public`).',
      spawnCommand('gh', [
        'repo', 'create', 'OWNER/REPOSITORY', '--source=.', '--remote=origin', '--private', '--push',
      ]),
      false,
    ),
    probe: async ({ bins, repository, state }) => {
      const present = state.git.usable && await githubRemote(bins.git, repository);
      return present
        ? { status: 'PASS', detail: `${repository} has a github.com remote` }
        : {
            status: 'FAIL',
            detail: `${repository} has no github.com remote`,
            remediationKey: 'default',
          };
    },
  }),
  Object.freeze({
    id: 'logdy-event-viewer',
    phase: 'optional',
    kind: 'optional',
    name: 'Logdy event viewer',
    remediation: remediation(
      'on macOS run `brew install logdy`; from a POSIX shell run `curl https://logdy.dev/install-silent.sh | sh`; on Windows install the release binary from https://github.com/logdyhq/logdy-core/releases and confirm with `logdy --version`.',
      process.platform === 'win32'
        ? null
        : process.platform === 'darwin'
          ? spawnCommand('brew', ['install', 'logdy'])
          : shellCommand('curl https://logdy.dev/install-silent.sh | sh', 'posix'),
      false,
    ),
    probe: async ({ bins }) => (await commandExists(bins.logdy))
      ? { status: 'PASS', detail: `${bins.logdy} was found` }
      : {
          status: 'FAIL',
          detail: `${bins.logdy} was not found on PATH; event files and the built-in dashboard still work`,
          remediationKey: 'default',
        },
  }),
]);

export const doctorChecks = DOCTOR_CHECKS;

export function createDoctorProbeState(scratchRoot) {
  return {
    scratchSafe: true,
    scratchWritable: false,
    workspace: null,
    createdDirectories: missingDirectories(scratchRoot),
  };
}

export function cleanupDoctorProbeState(state) {
  if (state.workspace) rmSync(state.workspace, { recursive: true, force: true });
  removeCreatedDirectories(state.createdDirectories);
}
