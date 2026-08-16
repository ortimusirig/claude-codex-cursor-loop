import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.js';
import { CLI_COMMANDS } from '../src/cli-help.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const installerPath = fileURLToPath(new URL('../install.mjs', import.meta.url));
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const skillPath = fileURLToPath(new URL('../SKILL.md', import.meta.url));
const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
const currentName = 'claude-codex-cursor-loop';
const previousName = ['run', 'claude', 'codex', 'cursor', 'loop'].join('-');

function frontmatter(path) {
  const text = readFileSync(path, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  assert.ok(match, `${path} must start with YAML frontmatter`);
  return Object.fromEntries(match[1].split(/\r?\n/).map((line) => {
    const separator = line.indexOf(':');
    assert.notEqual(separator, -1, `frontmatter line must contain a colon: ${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
}

function walk(path, out = []) {
  if (!existsSync(path)) return out;
  if (!statSync(path).isDirectory()) {
    out.push(path);
    return out;
  }
  for (const entry of readdirSync(path)) walk(join(path, entry), out);
  return out;
}

function runInstaller(home, ...args) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
  };
  return spawnSync(process.execPath, [installerPath, '--dry-run', ...args], {
    encoding: 'utf8',
    env,
  });
}

function output(result) {
  return `${result.stdout}${result.stderr}`;
}

function targetFrom(result) {
  const match = /^target: (.+)$/m.exec(result.stdout);
  assert.ok(match, `installer did not report a target:\n${output(result)}`);
  return normalize(match[1].trim());
}

function expectedRemovalCommand(path) {
  if (process.platform === 'win32') {
    return `Remove-Item -LiteralPath '${path.replaceAll("'", "''")}' -Recurse -Force`;
  }
  return `rm -rf -- '${path.replaceAll("'", "'\\''")}'`;
}

test('package and skill identifiers are claude-codex-cursor-loop and shipped text has no stale identifier', () => {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const skill = frontmatter(skillPath);
  assert.equal(pkg.name, currentName);
  assert.notEqual(pkg.name, previousName);
  assert.equal(skill.name, currentName);
  assert.notEqual(skill.name, previousName);

  const shippableTextRoots = [
    'package.json', 'SKILL.md', 'README.md', 'PORTING.md', 'diag.mjs', 'bin', 'src',
    'fixtures', 'test', 'docs', 'cursor-plugin',
  ];
  if (existsSync(installerPath)) shippableTextRoots.push('install.mjs');
  const checked = shippableTextRoots
    .flatMap((entry) => walk(join(root, entry)))
    .filter((path) => /[.](?:js|mjs|json|jsonl|md|ps1|cmd)$/i.test(path));
  assert.ok(checked.length > 0, 'positive control: source, documentation, and config files were found');
  const stale = checked.filter((path) => readFileSync(path, 'utf8').includes(previousName));
  assert.deepEqual(stale, [], `stale skill identifier remains in: ${stale.join(', ')}`);
});

test('SKILL.md description covers campaigns and diagnostics', () => {
  const description = frontmatter(skillPath).description;
  assert.ok(description, 'description must be non-empty');
  assert.match(description, /campaign/i);
  assert.match(description, /diagnostic|doctor/i);
});

test('installer defaults to claude-codex-cursor-loop and --name overrides the install directory', () => {
  if (!existsSync(installerPath)) {
    assert.ok(existsSync(packagePath), 'installed-copy self-test must still run from the payload');
    return;
  }
  const home = mkdtempSync(join(tmpdir(), 'ccc-installer-home-'));
  try {
    const defaultRun = runInstaller(home);
    assert.equal(defaultRun.status, 0, output(defaultRun));
    const defaultTarget = targetFrom(defaultRun);
    assert.equal(basename(defaultTarget), currentName);
    assert.equal(dirname(defaultTarget), normalize(join(home, '.claude', 'skills')));

    const customRun = runInstaller(home, '--name', 'side-by-side-name');
    assert.equal(customRun.status, 0, output(customRun));
    const customTarget = targetFrom(customRun);
    assert.equal(basename(customTarget), 'side-by-side-name');
    assert.notEqual(customTarget, defaultTarget, '--name must override rather than retain the default');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installer warns about a superseded install without deleting it and is silent otherwise', () => {
  if (!existsSync(installerPath)) {
    assert.ok(existsSync(packagePath), 'installed-copy self-test must still run from the payload');
    return;
  }
  const home = mkdtempSync(join(tmpdir(), 'ccc-installer-legacy-'));
  const previousPath = normalize(join(home, '.claude', 'skills', previousName));
  try {
    const absent = runInstaller(home);
    assert.equal(absent.status, 0, output(absent));
    assert.doesNotMatch(output(absent), /WARNING: previous skill install detected:/,
      'the warning must stay silent when the old directory is absent');

    mkdirSync(previousPath, { recursive: true });
    const present = runInstaller(home);
    assert.equal(present.status, 0, output(present));
    assert.match(output(present), /WARNING: previous skill install detected:/);
    assert.ok(output(present).includes(previousPath), 'the warning must name the old directory');
    assert.match(output(present), /superseded by claude-codex-cursor-loop/);
    assert.ok(output(present).includes(expectedRemovalCommand(previousPath)),
      'the warning must print the exact platform removal command');
    assert.ok(existsSync(previousPath), 'the installer must not remove the previous install');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('README starts with a copyable quickstart whose loop commands are real commands', () => {
  const readme = readFileSync(readmePath, 'utf8');
  // One badge line may sit between the heading and the description — universal convention,
  // and it buries nothing. Everything else stays strict.
  const match = /^# claude-codex-cursor-loop\r?\n\r?\n(?:\[!\[[^\r\n]*\r?\n\r?\n)?([^\r\n]+)\r?\n\r?\n```sh\r?\n([\s\S]*?)\r?\n```/.exec(readme);
  assert.ok(match, 'the heading, an optional single badge line, and a one-line description must be followed immediately by the quickstart');
  const lines = match[2].split(/\r?\n/);
  assert.deepEqual(lines, [
    'git clone https://github.com/ortimusirig/claude-codex-cursor-loop.git',
    'cd claude-codex-cursor-loop',
    'node install.mjs',
    'node bin/loop.js doctor',
    'node bin/loop.js init ../ccc-loop-demo',
    'node bin/loop.js run --task ../ccc-loop-demo/plan.md --target ../ccc-loop-demo --gate ../ccc-loop-demo/gate.json',
  ]);

  const loopArgv = lines.slice(3).map((line) => line.split(' ').slice(2));
  const documentedCommands = loopArgv.map((argv) => argv[0]);
  assert.deepEqual(documentedCommands, ['doctor', 'init', 'run']);
  for (const argv of loopArgv) {
    assert.ok(CLI_COMMANDS.includes(argv[0]), `${argv[0]} is absent from the real command list`);
    assert.equal(parseArgs(argv).command, argv[0], `${argv[0]} is documented but not accepted by the parser`);
  }
});
