import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHeadlessInteraction } from '../src/cli-interaction.js';
import { runSetup } from '../src/setup.js';
import { spawnCapture } from '../src/spawn.js';

const cli = fileURLToPath(new URL('../bin/loop.js', import.meta.url));

function writePassingBin(directory, name, script) {
  if (process.platform === 'win32') {
    writeFileSync(
      join(directory, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
    return;
  }
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(path, 0o755);
}

function failingAutoCheck(id = 'auto-fix') {
  return {
    id,
    phase: 'prerequisite',
    kind: 'required',
    name: `Human ${id}`,
    remediation: {
      prose: `install ${id} manually`,
      command: { type: 'spawn', binary: 'fake-installer', args: [id] },
      autoFixable: true,
    },
    probe: async () => ({
      status: 'FAIL', detail: `${id} is missing`, remediationKey: 'default',
    }),
  };
}

test('real setup CLI is headless-safe on a failing required check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-headless-cli-'));
  const operatorDirectory = join(root, 'operator');
  const scratchRoot = join(root, 'AppData', 'scratch');
  const shims = join(root, 'bin');
  const passingBin = join(root, 'passing-bin.mjs');
  mkdirSync(operatorDirectory);
  mkdirSync(shims);
  writeFileSync(passingBin, "process.stdout.write('ok\\n');\n");
  for (const name of ['git', 'codex', 'agent']) writePassingBin(shims, name, passingBin);
  const pathKey = Object.keys(process.env)
    .find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const env = {
    ...process.env,
    [pathKey]: `${shims}${delimiter}${process.env[pathKey] ?? ''}`,
  };
  try {
    const result = await spawnCapture(process.execPath, [
      cli, 'setup', '--scratch-root', scratchRoot,
    ], {
      cwd: operatorDirectory,
      env,
      timeoutMs: 15_000,
    });
    const output = result.stdout + result.stderr;

    assert.equal(result.timedOut, false, 'headless setup must finish before the bounded timeout');
    assert.notEqual(result.code, 0, 'incomplete prerequisites must exit non-zero');
    assert.doesNotMatch(output, /ERR_USE_AFTER_CLOSE/,
      'headless setup must not expose ERR_USE_AFTER_CLOSE');
    assert.doesNotMatch(output, /readline was closed/,
      'headless setup must not report that readline was closed');
    assert.doesNotMatch(output, /^\s+at /m,
      'headless prerequisite failures must not emit stack-trace frames');
    assert.match(output, /SETUP STATUS: prerequisite-incomplete/);
    assert.ok(result.stdout.includes(
      'NEEDS: scratch-root-location\tScratch root location\t'
      + 'set `URO_SCRATCH_ROOT` to a short local path outside AppData and OneDrive '
      + '(for example `C:\\uro\\w`) and rerun doctor.',
    ), 'the structured remaining-work record must be emitted on stdout');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real doctor --fix refuses installs headlessly without constructing readline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uro-headless-doctor-'));
  const operatorDirectory = join(root, 'operator');
  const scratchRoot = join(root, 'AppData', 'scratch');
  mkdirSync(operatorDirectory);
  const pathKey = Object.keys(process.env)
    .find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const env = { ...process.env, [pathKey]: '' };
  try {
    const result = await spawnCapture(process.execPath, [
      cli, 'doctor', '--fix', '--scratch-root', scratchRoot,
    ], {
      cwd: operatorDirectory,
      env,
      timeoutMs: 15_000,
    });
    const output = result.stdout + result.stderr;

    assert.equal(result.timedOut, false);
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(output, /ERR_USE_AFTER_CLOSE|readline was closed|^\s+at /m);
    assert.match(output, /Consent refused in headless mode; NOT RUN: npm install -g @openai\/codex/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('headless consent refuses an auto-fix and names the exact command without executing it', async () => {
  let output = '';
  let executions = 0;
  const interaction = createHeadlessInteraction({
    write: (text) => { output += text; },
  });
  const result = await runSetup({
    scratchRoot: join(tmpdir(), 'uro-headless-refusal'),
    checks: [failingAutoCheck()],
    consent: interaction.consent,
    wait: interaction.wait,
    write: (text) => { output += text; },
    remediationExecutor: async () => { executions++; return { code: 0 }; },
  });

  assert.equal(result.status, 'prerequisite-incomplete');
  assert.equal(executions, 0, 'refused remediation must not reach the executor');
  assert.match(output, /Consent refused in headless mode; NOT RUN: fake-installer auto-fix/);
});

test('headless --yes grants consent at the remediation call site and prints the command', async () => {
  let output = '';
  const executed = [];
  const interaction = createHeadlessInteraction({
    yes: true,
    write: (text) => { output += text; },
  });
  await runSetup({
    scratchRoot: join(tmpdir(), 'uro-headless-yes'),
    checks: [failingAutoCheck()],
    consent: interaction.consent,
    wait: interaction.wait,
    write: (text) => { output += text; },
    remediationExecutor: async (command) => {
      executed.push(command);
      return { code: 0 };
    },
  });

  assert.deepEqual(executed, [
    { type: 'spawn', binary: 'fake-installer', args: ['auto-fix'] },
  ]);
  assert.match(output, /About to run: fake-installer auto-fix/);
  assert.doesNotMatch(output, /NOT RUN:/);
});

test('interactive injected consent and wait behavior is unchanged', async () => {
  const consentCalls = [];
  const waitCalls = [];
  const result = await runSetup({
    scratchRoot: join(tmpdir(), 'uro-interactive-injected'),
    checks: [failingAutoCheck()],
    consent: async (question, context) => {
      consentCalls.push({ question, commandText: context.commandText });
      return 'no';
    },
    wait: async (question, context) => {
      waitCalls.push({ question, checkId: context.check.id });
      return false;
    },
    remediationExecutor: async () => {
      throw new Error('declined remediation must not execute');
    },
  });

  assert.equal(result.status, 'stopped');
  assert.deepEqual(consentCalls, [{
    question: 'Run this command? [y/N] ',
    commandText: 'fake-installer auto-fix',
  }]);
  assert.deepEqual(waitCalls, [{
    question: 'Press Enter after following the instruction for Human auto-fix, or type q to stop: ',
    checkId: 'auto-fix',
  }]);
});
