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
import { join, resolve, dirname } from 'node:path';
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

function statusLine(status, kind, name, detail, next) {
  return [
    `${status} [${kind}] ${name}: ${detail}`,
    ...(next ? [`  Next: ${next}`] : []),
  ];
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

export async function runDoctor({
  deep = false,
  scratchRoot,
  repository = process.cwd(),
  nodeVersion = process.versions.node,
  bins = { git: 'git', codex: 'codex', agent: 'agent', gh: 'gh', logdy: 'logdy' },
} = {}) {
  if (typeof scratchRoot !== 'string' || scratchRoot === '') {
    throw new TypeError('doctor scratchRoot must be a non-empty string');
  }
  const lines = ['ccc doctor', '', 'Required checks:'];
  const resolvedScratchRoot = resolve(scratchRoot);
  let requiredFailed = false;
  let workspace = null;
  let scratchSafe = true;
  let scratchWritable = false;
  const createdDirectories = missingDirectories(resolvedScratchRoot);

  const nodeMajor = Number.parseInt(nodeVersion.split('.')[0], 10);
  if (Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR) {
    lines.push(...statusLine('PASS', 'required', 'Node version', `${nodeVersion} meets >=${MINIMUM_NODE_MAJOR}`));
  } else {
    requiredFailed = true;
    lines.push(...statusLine('FAIL', 'required', 'Node version', `${nodeVersion} does not meet >=${MINIMUM_NODE_MAJOR}`,
      '`node --version`; install Node.js 24 or newer from https://nodejs.org/ and rerun doctor.'));
  }

  const git = await installedAndUsable(bins.git, ['--version']);
  if (!git.installed) {
    requiredFailed = true;
    lines.push(...statusLine('FAIL', 'required', 'git usable', `${bins.git} was not found on PATH`,
      'install Git from https://git-scm.com/downloads, reopen the terminal, and run `git --version`.'));
  } else if (!git.usable) {
    requiredFailed = true;
    lines.push(...statusLine('FAIL', 'required', 'git usable', '`git --version` did not complete successfully',
      'repair Git until `git --version` exits 0, then rerun doctor.'));
  } else {
    lines.push(...statusLine('PASS', 'required', 'git usable', git.result.stdout.trim() || 'command exited 0'));
  }

  const codexPresent = await commandExists(bins.codex);
  if (codexPresent) {
    lines.push(...statusLine('PASS', 'required', 'Codex CLI installed', `${bins.codex} was found; write ability is reported separately`));
  } else {
    requiredFailed = true;
    lines.push(...statusLine('FAIL', 'required', 'Codex CLI installed', `${bins.codex} was not found on PATH`,
      'run `npm install -g @openai/codex`, then run `codex` in a terminal to sign in.'));
  }

  if (!codexPresent) {
    lines.push(...statusLine('SKIP', 'required', 'Codex signed in', 'not checked because the Codex CLI is not installed yet'));
  } else {
    const codexSignIn = await signInStatus(bins.codex, ['login', 'status']);
    if (codexSignIn.signedIn) {
      lines.push(...statusLine('PASS', 'required', 'Codex signed in', '`codex login status` exited 0'));
    } else {
      requiredFailed = true;
      lines.push(...statusLine('FAIL', 'required', 'Codex signed in', signInFailureDetail('codex login status', codexSignIn),
        'run `codex login`; if that does not help, update or reinstall the Codex CLI, then rerun doctor.'));
    }
  }

  const agentPresent = await commandExists(bins.agent);
  if (agentPresent) {
    lines.push(...statusLine('PASS', 'required', 'Cursor agent installed', `${bins.agent} was found; read ability is reported separately`));
  } else {
    requiredFailed = true;
    lines.push(...statusLine('FAIL', 'required', 'Cursor agent installed', `${bins.agent} was not found on PATH`,
      `run \`${cursorAgentInstallCommand()}\`${process.platform === 'win32' ? ' in Windows PowerShell' : ''}, reopen the terminal, confirm the binary is \`agent\`, and run \`agent login\`.`));
  }

  if (!agentPresent) {
    lines.push(...statusLine('SKIP', 'required', 'Cursor signed in', 'not checked because the Cursor Agent CLI is not installed yet'));
  } else {
    const agentSignIn = await signInStatus(bins.agent, ['status']);
    if (agentSignIn.signedIn) {
      lines.push(...statusLine('PASS', 'required', 'Cursor signed in', '`agent status` exited 0'));
    } else {
      requiredFailed = true;
      lines.push(...statusLine('FAIL', 'required', 'Cursor signed in', signInFailureDetail('agent status', agentSignIn),
        'run `agent login`; if that does not help, run `agent update` or reinstall the Cursor Agent CLI, then rerun doctor.'));
    }
  }

  try {
    assertSafeScratchRoot(resolvedScratchRoot);
    lines.push(...statusLine('PASS', 'required', 'Scratch root location', `${resolvedScratchRoot} is outside AppData and OneDrive`));
  } catch (error) {
    scratchSafe = false;
    requiredFailed = true;
    lines.push(...statusLine('FAIL', 'required', 'Scratch root location', error.message,
      'set `CCC_SCRATCH_ROOT` to a short local path outside AppData and OneDrive (for example `C:\\ccc\\w`) and rerun doctor.'));
  }

  if (scratchSafe) {
    try {
      mkdirSync(resolvedScratchRoot, { recursive: true });
      workspace = mkdtempSync(join(resolvedScratchRoot, '.ccc-doctor-'));
      const marker = join(workspace, 'write-check.txt');
      writeFileSync(marker, 'writable\n');
      scratchWritable = readFileSync(marker, 'utf8') === 'writable\n';
      if (!scratchWritable) throw new Error('disposable write did not round-trip');
    } catch (error) {
      requiredFailed = true;
      lines.push(...statusLine('FAIL', 'required', 'Scratch root writable', `${resolvedScratchRoot}: ${error.message}`,
        'grant write access to this directory or set `CCC_SCRATCH_ROOT` to a writable local path, then rerun doctor.'));
    }
  }
  if (scratchWritable) {
    lines.push(...statusLine('PASS', 'required', 'Scratch root writable', `${resolvedScratchRoot} accepted a disposable write`));
  } else if (!scratchSafe) {
    requiredFailed = true;
    lines.push(...statusLine('FAIL', 'required', 'Scratch root writable', 'not tested because the configured path is unsafe',
      'set `CCC_SCRATCH_ROOT` to a writable local path outside AppData and OneDrive, then rerun doctor.'));
  }

  try {
    if (!deep) {
      const rerun = '`node bin/loop.js doctor --deep` (this spends Codex/Cursor tokens).';
      lines.push(...statusLine('SKIP', 'required', 'Codex write probe', 'not performed; it was not passed off as a success', rerun));
      lines.push(...statusLine('SKIP', 'required', 'Cursor read probe', 'not performed; it was not passed off as a success', rerun));
    } else {
      if (codexPresent && git.usable && workspace) {
        try {
          const probe = await probeCodex(bins.codex, bins.git, workspace);
          if (probe.passed) {
            lines.push(...statusLine('PASS', 'required', 'Codex write probe', `created ${WRITE_FILENAME} with the requested content in a disposable Git repository`));
          } else {
            requiredFailed = true;
            lines.push(...statusLine('FAIL', 'required', 'Codex write probe', `Codex exited ${probe.result.code} or did not create the requested file`,
              'run `codex` to sign in, fix write-blocking hooks or sandbox errors, then rerun `node bin/loop.js doctor --deep`.'));
          }
        } catch (error) {
          requiredFailed = true;
          lines.push(...statusLine('FAIL', 'required', 'Codex write probe', error.message,
            'run `codex` to sign in, fix write-blocking hooks or sandbox errors, then rerun `node bin/loop.js doctor --deep`.'));
        }
      } else {
        requiredFailed = true;
        lines.push(...statusLine('FAIL', 'required', 'Codex write probe', 'could not run because Codex, git, or scratch storage failed a prerequisite',
          'fix the failed prerequisite above, then rerun `node bin/loop.js doctor --deep`.'));
      }

      if (agentPresent && workspace) {
        try {
          const probe = await probeAgent(bins.agent, workspace);
          if (probe.passed) {
            lines.push(...statusLine('PASS', 'required', 'Cursor read probe', 'returned the unpredictable contents of a scratch file and left the directory unchanged'));
          } else {
            requiredFailed = true;
            lines.push(...statusLine('FAIL', 'required', 'Cursor read probe', `agent exited ${probe.result.code}, did not return the file content, or modified the directory`,
              'run `agent login`, disable or repair hooks blocking read tools, then rerun `node bin/loop.js doctor --deep`.'));
          }
        } catch (error) {
          requiredFailed = true;
          lines.push(...statusLine('FAIL', 'required', 'Cursor read probe', error.message,
            'run `agent login`, disable or repair hooks blocking read tools, then rerun `node bin/loop.js doctor --deep`.'));
        }
      } else {
        requiredFailed = true;
        lines.push(...statusLine('FAIL', 'required', 'Cursor read probe', 'could not run because the agent or scratch storage failed a prerequisite',
          'fix the failed prerequisite above, then rerun `node bin/loop.js doctor --deep`.'));
      }
    }

    lines.push('', 'Optional features (these do not affect loop health):');
    lines.push('INFO [optional] GitHub publishing: optional; the loop is fully usable without it.');
    const ghPresent = await commandExists(bins.gh);
    if (ghPresent) {
      lines.push(...statusLine('PASS', 'optional', 'GitHub CLI installed', `${bins.gh} was found`));
    } else {
      lines.push(...statusLine('FAIL', 'optional', 'GitHub CLI installed', `${bins.gh} was not found on PATH`,
        'create an account at https://github.com/signup, install `gh` from https://cli.github.com/, run `gh auth login`, then run `gh repo create OWNER/REPOSITORY --source=. --remote=origin --private --push` from the existing local repository (use `--public` if desired).'));
    }

    let ghAuthenticated = false;
    if (ghPresent) {
      try {
        const auth = await spawnCapture(bins.gh, ['auth', 'status'], { timeoutMs: 30_000 });
        ghAuthenticated = auth.code === 0 && !auth.timedOut;
      } catch { /* Report the unmet precondition below. */ }
    }
    if (ghAuthenticated) {
      lines.push(...statusLine('PASS', 'optional', 'GitHub authentication', '`gh auth status` exited 0'));
    } else {
      lines.push(...statusLine('FAIL', 'optional', 'GitHub authentication', ghPresent
        ? '`gh auth status` did not succeed'
        : 'not checkable until GitHub CLI is installed',
      'run `gh auth login`, then confirm with `gh auth status`.'));
    }

    const remotePresent = git.usable && await githubRemote(bins.git, resolve(repository));
    if (remotePresent) {
      lines.push(...statusLine('PASS', 'optional', 'GitHub remote', `${resolve(repository)} has a github.com remote`));
    } else {
      lines.push(...statusLine('FAIL', 'optional', 'GitHub remote', `${resolve(repository)} has no github.com remote`,
        'from the existing local repository run `gh repo create OWNER/REPOSITORY --source=. --remote=origin --private --push` (or replace `--private` with `--public`).'));
    }

    const logdyPresent = await commandExists(bins.logdy);
    if (logdyPresent) {
      lines.push(...statusLine('PASS', 'optional', 'Logdy event viewer', `${bins.logdy} was found`));
    } else {
      lines.push(...statusLine('FAIL', 'optional', 'Logdy event viewer', `${bins.logdy} was not found on PATH; event files and the built-in dashboard still work`,
        'on macOS run `brew install logdy`; from a POSIX shell run `curl https://logdy.dev/install-silent.sh | sh`; on Windows install the release binary from https://github.com/logdyhq/logdy-core/releases and confirm with `logdy --version`.'));
    }

    lines.push('INFO [optional] Offline run journal: available through `node bin/generate-run-journal.js --help`; no external integration is required.');
  } finally {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    removeCreatedDirectories(createdDirectories);
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
