import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURSOR_AGENT_INSTALL_COMMANDS,
  cursorAgentInstallCommand,
} from '../src/doctor.js';
import { spawnCapture } from '../src/spawn.js';
import { CLI_COMMANDS } from '../src/cli-help.js';
import { PLAN_TEMPLATE } from '../src/init.js';

const cli = fileURLToPath(new URL('../bin/loop.js', import.meta.url));
const setupSkill = fileURLToPath(new URL('../skills/uroboros-setup/SKILL.md', import.meta.url));
const fakeGit = fileURLToPath(new URL('../fixtures/fake-doctor-git.mjs', import.meta.url));
const fakeCodex = fileURLToPath(new URL('../fixtures/fake-doctor-codex.mjs', import.meta.url));
const fakeAgent = fileURLToPath(new URL('../fixtures/fake-doctor-agent.mjs', import.meta.url));
const fakeGh = fileURLToPath(new URL('../fixtures/fake-doctor-gh.mjs', import.meta.url));
const fakeCodexNoWrite = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
const fakeAgentBlocked = fileURLToPath(new URL('../fixtures/fake-agent-broken.mjs', import.meta.url));
const SAFE_TEST_ROOT = process.env.URO_TEST_SCRATCH_ROOT ?? (process.platform === 'win32'
  ? 'C:/tmp'
  : tmpdir());

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function writeFakeBin(directory, name, script) {
  if (process.platform === 'win32') {
    const path = join(directory, `${name}.cmd`);
    writeFileSync(path, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return path;
  }
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

function isolatedPath(directory) {
  if (process.platform === 'win32') {
    const systemDirectory = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    return `${directory}${delimiter}${systemDirectory}`;
  }
  const resolver = join(directory, 'which');
  writeFileSync(resolver, `#!/bin/sh\nif [ -x ${shellQuote(directory)}/"$1" ]; then printf '%s\\n' ${shellQuote(directory)}/"$1"; exit 0; fi\nexit 1\n`);
  chmodSync(resolver, 0o755);
  return directory;
}

function doctorFixture({
  codex = true,
  agent = true,
  gh = false,
  codexScript = fakeCodex,
  agentScript = fakeAgent,
} = {}) {
  mkdirSync(SAFE_TEST_ROOT, { recursive: true });
  const root = mkdtempSync(join(SAFE_TEST_ROOT, 'ccc-first-run-'));
  const bins = join(root, 'bin');
  const repository = join(root, 'repository');
  mkdirSync(bins);
  mkdirSync(repository);
  writeFakeBin(bins, 'git', fakeGit);
  if (codex) writeFakeBin(bins, 'codex', codexScript);
  if (agent) writeFakeBin(bins, 'agent', agentScript);
  if (gh) writeFakeBin(bins, 'gh', fakeGh);
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  return {
    root,
    scratchRoot: join(root, 'scratch'),
    repository,
    env: { ...process.env, [pathKey]: isolatedPath(bins) },
  };
}

async function invokeDoctor(fixture, ...extra) {
  return spawnCapture(process.execPath, [
    cli, 'doctor', '--scratch-root', fixture.scratchRoot,
    '--repository', fixture.repository,
    ...extra,
  ], { env: fixture.env });
}

function assertCompleteUsage(text) {
  assert.match(text, /^Usage:/m);
  for (const command of CLI_COMMANDS) {
    assert.match(text, new RegExp(`node bin/loop[.]js ${command}(?:\\s|$)`),
      `usage must name the ${command} command`);
  }
  assert.match(text, /run --task .*--target .*--gate .*--gate-retries.*--quiet/);
  assert.match(text, /batch --task .*--target .*--gate .*--concurrency.*--depends-on.*--quiet/);
  assert.match(text, /doctor \[--deep\] \[--scratch-root <directory>\] \[--repository <directory>\]/);
  assert.match(text, /init <directory>/);
}

test('--help, -h, and help print complete usage while no arguments is a usage failure', async () => {
  for (const flag of ['--help', '-h', 'help']) {
    const result = await spawnCapture(process.execPath, [cli, flag]);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assertCompleteUsage(result.stdout);
    assert.equal(result.stderr, '');
  }

  const noArguments = await spawnCapture(process.execPath, [cli]);
  assert.notEqual(noArguments.code, 0, 'no arguments is a caller error, not a successful run');
  assert.equal(noArguments.stdout, '');
  assertCompleteUsage(noArguments.stderr);
});

test('an unknown command prints both its error and complete usage and exits non-zero', async () => {
  const result = await spawnCapture(process.execPath, [cli, 'definitely-not-a-command']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /arg error: unknown command: definitely-not-a-command/);
  assertCompleteUsage(result.stderr);
});

test('doctor reports a missing required binary with an actionable command and exits non-zero', async () => {
  const fixture = doctorFixture({ codex: false });
  try {
    const result = await invokeDoctor(fixture);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /FAIL \[required\] Codex CLI installed: codex was not found on PATH/);
    assert.match(result.stdout, /npm install -g @openai\/codex/);
    assert.match(result.stdout, /SKIP \[required\] Codex signed in:.*CLI is not installed yet/);
    assert.doesNotMatch(result.stdout, /FAIL \[required\] Codex signed in:/,
      'a missing CLI has one install failure, not a duplicate sign-in failure');
    assert.match(result.stdout, /Loop health: UNHEALTHY/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('doctor gives the official platform-specific Cursor install command and skips sign-in when absent', async () => {
  const fixture = doctorFixture({ agent: false });
  try {
    const result = await invokeDoctor(fixture);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /FAIL \[required\] Cursor agent installed: agent was not found on PATH/);
    assert.ok(result.stdout.includes(cursorAgentInstallCommand()),
      'the doctor remedy must contain the shared install command for this platform');
    // Positive control for the mapping itself. The assertion above compares doctor output
    // against the same helper doctor calls, so an inverted win32/other mapping would agree
    // with it and still pass. Pin each platform to a literal marker so inversion fails.
    assert.match(cursorAgentInstallCommand('win32'), /^irm /,
      'Windows must be given the PowerShell installer');
    assert.match(cursorAgentInstallCommand('linux'), /^curl /,
      'Linux must be given the curl installer');
    assert.match(cursorAgentInstallCommand('darwin'), /^curl /,
      'macOS must be given the curl installer');
    assert.notEqual(CURSOR_AGENT_INSTALL_COMMANDS.win32, CURSOR_AGENT_INSTALL_COMMANDS.other,
      'the two platform commands must be distinct or the mapping is untestable');
    assert.match(result.stdout, /binary is `agent`/);
    assert.match(result.stdout, /`agent login`/);
    assert.match(result.stdout, /SKIP \[required\] Cursor signed in:.*CLI is not installed yet/);
    assert.doesNotMatch(result.stdout, /FAIL \[required\] Cursor signed in:/,
      'a missing CLI has one install failure, not a duplicate sign-in failure');

    const documentation = readFileSync(setupSkill, 'utf8').replaceAll('\\|', '|');
    for (const command of Object.values(CURSOR_AGENT_INSTALL_COMMANDS)) {
      assert.ok(documentation.includes(command),
        `setup skill must contain the shared command: ${command}`);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('doctor requires both free local sign-in checks, with passing positive controls', async () => {
  const fixture = doctorFixture();
  try {
    const signedIn = await invokeDoctor(fixture);
    assert.equal(signedIn.code, 0, `${signedIn.stderr}\n${signedIn.stdout}`);
    assert.match(signedIn.stdout, /PASS \[required\] Codex signed in: `codex login status` exited 0/);
    assert.match(signedIn.stdout, /PASS \[required\] Cursor signed in: `agent status` exited 0/);

    fixture.env.URO_FAKE_CODEX_SIGNED_IN = 'no';
    const codexSignedOut = await invokeDoctor(fixture);
    assert.notEqual(codexSignedOut.code, 0);
    assert.match(codexSignedOut.stdout, /FAIL \[required\] Codex signed in: `codex login status` exited 1/);
    assert.match(codexSignedOut.stdout, /run `codex login`/);
    assert.match(codexSignedOut.stdout, /update or reinstall the Codex CLI/);
    assert.match(codexSignedOut.stdout, /PASS \[required\] Cursor signed in/,
      'positive control: Cursor can still pass while Codex is signed out');

    delete fixture.env.URO_FAKE_CODEX_SIGNED_IN;
    fixture.env.URO_FAKE_AGENT_SIGNED_IN = 'no';
    const cursorSignedOut = await invokeDoctor(fixture);
    assert.notEqual(cursorSignedOut.code, 0);
    assert.match(cursorSignedOut.stdout, /PASS \[required\] Codex signed in/,
      'positive control: Codex can still pass while Cursor is signed out');
    assert.match(cursorSignedOut.stdout, /FAIL \[required\] Cursor signed in: `agent status` exited 1/);
    assert.match(cursorSignedOut.stdout, /run `agent login`/);
    assert.match(cursorSignedOut.stdout, /run `agent update` or reinstall the Cursor Agent CLI/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('plain doctor invokes only local status commands and never model probes', async () => {
  const fixture = doctorFixture();
  const invocationsPath = join(fixture.root, 'agent-invocations.jsonl');
  fixture.env.URO_FAKE_DOCTOR_INVOCATIONS = invocationsPath;
  try {
    const result = await invokeDoctor(fixture);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const invocations = readFileSync(invocationsPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(invocations, [
      { cli: 'codex', args: ['login', 'status'] },
      { cli: 'agent', args: ['status'] },
    ], 'default doctor must never invoke Codex exec or Cursor -p model forms');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('doctor marks token-using probes SKIP, never PASS, unless --deep is selected', async () => {
  const fixture = doctorFixture();
  try {
    const result = await invokeDoctor(fixture);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /SKIP \[required\] Codex write probe:.*not performed/);
    assert.match(result.stdout, /SKIP \[required\] Cursor read probe:.*not performed/);
    assert.match(result.stdout, /doctor --deep/);
    assert.doesNotMatch(result.stdout, /PASS \[required\] (?:Codex write|Cursor read) probe/,
      'a skipped probe must remain distinguishable from a passed probe');
    assert.match(result.stdout, /Loop core health: HEALTHY .*sign-ins were verified/);
    assert.match(result.stdout, /Deep readiness: UNKNOWN .*sign-in was verified.*remain unproven until `--deep`.*SKIPPED, not passed/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('doctor deep probes pass with local stubs, clean scratch, and ignore missing optional tools', async () => {
  const fixture = doctorFixture();
  try {
    const result = await invokeDoctor(fixture, '--deep');
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /PASS \[required\] Codex write probe: created ccc-doctor-write[.]txt/);
    assert.match(result.stdout, /PASS \[required\] Cursor read probe: returned the unpredictable contents/);
    assert.match(result.stdout, /FAIL \[optional\] GitHub CLI installed/);
    assert.match(result.stdout, /FAIL \[optional\] GitHub authentication/);
    assert.match(result.stdout, /FAIL \[optional\] GitHub remote/);
    assert.match(result.stdout, /FAIL \[optional\] Logdy event viewer/);
    assert.match(result.stdout, /github[.]com\/signup/);
    assert.match(result.stdout, /gh auth login/);
    assert.match(result.stdout, /gh repo create OWNER\/REPOSITORY --source=[.] --remote=origin --private --push/);
    assert.match(result.stdout, /Loop health: HEALTHY/,
      'optional failures must not make the loop itself unhealthy');
    assert.match(result.stdout, /loop is fully usable without them/i);
    assert.equal(existsSync(fixture.scratchRoot), false,
      'doctor must clean the scratch root it created after deep probes');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('doctor deep probes fail when Codex does not write or Cursor cannot read', async () => {
  const noWrite = doctorFixture({ codexScript: fakeCodexNoWrite });
  const blockedRead = doctorFixture({ agentScript: fakeAgentBlocked });
  try {
    const codexResult = await invokeDoctor(noWrite, '--deep');
    assert.notEqual(codexResult.code, 0);
    assert.match(codexResult.stdout, /FAIL \[required\] Codex write probe: Codex exited 0 or did not create the requested file/);
    assert.match(codexResult.stdout, /PASS \[required\] Cursor read probe/,
      'positive control: the independent read probe still ran');

    const agentResult = await invokeDoctor(blockedRead, '--deep');
    assert.notEqual(agentResult.code, 0);
    assert.match(agentResult.stdout, /PASS \[required\] Codex write probe/,
      'positive control: the independent write probe still ran');
    assert.match(agentResult.stdout, /FAIL \[required\] Cursor read probe: agent exited 1/);
  } finally {
    rmSync(noWrite.root, { recursive: true, force: true });
    rmSync(blockedRead.root, { recursive: true, force: true });
  }
});

test('doctor reports GitHub installed, authentication, and remote preconditions distinctly', async () => {
  const fixture = doctorFixture({ gh: true });
  try {
    const result = await invokeDoctor(fixture);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /PASS \[optional\] GitHub CLI installed/);
    assert.match(result.stdout, /FAIL \[optional\] GitHub authentication: `gh auth status` did not succeed/);
    assert.match(result.stdout, /FAIL \[optional\] GitHub remote:/);

    fixture.env.URO_FAKE_GH_AUTH = 'yes';
    fixture.env.URO_FAKE_GITHUB_REMOTE = 'yes';
    const ready = await invokeDoctor(fixture);
    assert.equal(ready.code, 0, ready.stderr);
    assert.match(ready.stdout, /PASS \[optional\] GitHub CLI installed/);
    assert.match(ready.stdout, /PASS \[optional\] GitHub authentication/);
    assert.match(ready.stdout, /PASS \[optional\] GitHub remote/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the init plan template puts its dashboard title directly below the task heading', () => {
  assert.match(PLAN_TEMPLATE,
    /^# Task\r?\nTitle: <one-line summary for the dashboard>\r?\n\r?\nDescribe the user-visible outcome and why it matters[.]/);
});

test('init creates detected runnable scaffolding and refuses a second overwrite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-init-package-'));
  const directory = join(root, 'project');
  mkdirSync(directory);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  try {
    const first = await spawnCapture(process.execPath, [cli, 'init', directory]);
    assert.equal(first.code, 0, first.stderr);
    const planPath = join(directory, 'plan.md');
    const gatePath = join(directory, 'gate.json');
    assert.ok(existsSync(planPath));
    assert.ok(existsSync(gatePath));
    const plan = readFileSync(planPath, 'utf8');
    assert.match(plan, /## Invariants/);
    assert.match(plan, /## Out of scope/);
    assert.match(plan, /quietly narrow the product/);
    assert.match(plan, /fixtures that erase the signal/);

    const gate = JSON.parse(readFileSync(gatePath, 'utf8'));
    assert.deepEqual(gate.map(({ bin, args }) => ({ bin, args })), [{ bin: 'npm', args: ['test'] }]);
    for (const command of gate) {
      const executed = await spawnCapture(command.bin, command.args, { cwd: directory });
      assert.equal(executed.code, 0, `${command.bin} ${command.args.join(' ')} was not runnable: ${executed.stderr}`);
    }

    const originalPlan = readFileSync(planPath, 'utf8');
    const originalGate = readFileSync(gatePath, 'utf8');
    const second = await spawnCapture(process.execPath, [cli, 'init', directory]);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /refusing to overwrite existing files?.*plan[.]md.*gate[.]json/i);
    assert.equal(readFileSync(planPath, 'utf8'), originalPlan);
    assert.equal(readFileSync(gatePath, 'utf8'), originalGate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init fallback gate is valid commented JSON and executable as generated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ccc-init-fallback-'));
  const directory = join(root, 'plain-project');
  try {
    const result = await spawnCapture(process.execPath, [cli, 'init', directory]);
    assert.equal(result.code, 0, result.stderr);
    const gate = JSON.parse(readFileSync(join(directory, 'gate.json'), 'utf8'));
    assert.match(gate[0]._comment, /Runnable placeholder.*replace.*real/i);
    const executed = await spawnCapture(gate[0].bin, gate[0].args, { cwd: directory });
    assert.equal(executed.code, 0, executed.stderr);
    assert.match(executed.stdout, /Replace it with a real project check/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
