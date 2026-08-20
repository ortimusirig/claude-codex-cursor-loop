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
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.js';
import { CLI_COMMANDS } from '../src/cli-help.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const installerPath = fileURLToPath(new URL('../install.mjs', import.meta.url));
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const skillPath = fileURLToPath(new URL('../skills/uroboros/SKILL.md', import.meta.url));
const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
const workflowPath = fileURLToPath(new URL('../.github/workflows/tests.yml', import.meta.url));
const currentName = 'uroboros';
const previousName = ['c', 'cube', 'loop'].join('-');

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
  return spawnSync(process.execPath, [installerPath, ...args], {
    encoding: 'utf8',
    env,
  });
}

function output(result) {
  return `${result.stdout}${result.stderr}`;
}

function expectedRemovalCommand(path) {
  if (process.platform === 'win32') {
    return `Remove-Item -LiteralPath '${path.replaceAll("'", "''")}' -Recurse -Force`;
  }
  return `rm -rf -- '${path.replaceAll("'", "'\\''")}'`;
}

test('package and skill identifiers are uroboros and shipped text has no stale identifier', () => {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  const skill = frontmatter(skillPath);
  assert.equal(pkg.name, currentName);
  assert.notEqual(pkg.name, previousName);
  assert.equal(skill.name, currentName);
  assert.notEqual(skill.name, previousName);

  const shippableTextRoots = [
    'package.json', 'README.md', 'PORTING.md', 'diag.mjs', 'bin', 'src',
    'fixtures', 'test', 'docs', 'cursor-plugin', 'commands', 'skills', '.claude-plugin',
  ];
  if (existsSync(installerPath)) shippableTextRoots.push('install.mjs');
  const checked = shippableTextRoots
    .flatMap((entry) => walk(join(root, entry)))
    .filter((path) => /[.](?:js|mjs|json|jsonl|md|ps1|cmd)$/i.test(path));
  assert.ok(checked.length > 0, 'positive control: source, documentation, and config files were found');
  const stale = checked
    .filter((path) => readFileSync(path, 'utf8').includes(previousName));
  assert.deepEqual(stale, [], `stale skill identifier remains in: ${stale.join(', ')}`);

  assert.ok(
    `the ${previousName} skill`.includes(previousName),
    'positive control: the stale-identifier scan must detect the superseded name',
  );
});

test('README names the renamed repository and contains no superseded repository name', () => {
  const readme = readFileSync(readmePath, 'utf8');
  assert.ok(readme.includes('ortimusirig/uroboros'),
    'positive control: README must contain the current GitHub owner and repository');
  assert.ok(readme.includes(
    '[![tests](https://github.com/ortimusirig/uroboros/actions/workflows/tests.yml/badge.svg)](https://github.com/ortimusirig/uroboros/actions/workflows/tests.yml)',
  ), 'the CI badge and link must use the renamed repository');
  assert.equal(readme.includes(previousName), false,
    'README must contain no occurrence of the superseded repository name');
});

test('CI runs plugin validation in dry-run mode alongside the test suite', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /^on:\r?\n  push:\r?\n  pull_request:/m,
    'the workflow must run for every push and pull request');
  assert.match(workflow, /^[ \t]*- run: node --test[ \t]*$/m,
    'positive control: the workflow must still run the test suite');
  assert.match(workflow, /^[ \t]*- run: node install[.]mjs --dry-run[ \t]*$/m,
    'push and pull-request CI must validate the plugin without rerunning the suite');
});

test('SKILL.md description covers campaigns and diagnostics', () => {
  const description = frontmatter(skillPath).description;
  assert.ok(description, 'description must be non-empty');
  assert.match(description, /campaign/i);
  assert.match(description, /diagnostic|doctor/i);
});

test('installer accepts dry-run and rejects retired personal-skill arguments', () => {
  assert.ok(existsSync(installerPath), 'the repository checkout must contain install.mjs');
  const home = mkdtempSync(join(tmpdir(), 'ccc-installer-home-'));
  try {
    const dryRun = runInstaller(home, '--dry-run');
    assert.equal(dryRun.status, 0, output(dryRun));
    assert.match(output(dryRun), /MODE=plugin-verifier/);
    assert.match(output(dryRun), /PLUGIN_STATUS=PREPARED mode=plugin dry-run=true/);
    assert.match(output(dryRun), /self-test was not run/);
    assert.doesNotMatch(output(dryRun), /^target:/m,
      'plugin verification must not pretend to choose an install destination');

    for (const retiredArgument of ['--personal-skill', '--name']) {
      const rejected = runInstaller(home, retiredArgument);
      assert.notEqual(rejected.status, 0,
        `${retiredArgument} must be rejected even though --dry-run is accepted`);
      assert.match(output(rejected), new RegExp(`unknown argument: ${retiredArgument}`));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installer warns about the current personal skill without deleting it and is silent otherwise', () => {
  assert.ok(existsSync(installerPath), 'the repository checkout must contain install.mjs');
  const home = mkdtempSync(join(tmpdir(), 'ccc-installer-duplicate-'));
  const personalPath = normalize(join(home, '.claude', 'skills', currentName));
  try {
    const absent = runInstaller(home, '--dry-run');
    assert.equal(absent.status, 0, output(absent));
    assert.doesNotMatch(output(absent), /WARNING: personal skill install detected:/,
      'the warning must stay silent when the personal directory is absent');

    mkdirSync(personalPath, { recursive: true });
    const present = runInstaller(home, '--dry-run');
    assert.equal(present.status, 0, output(present));
    assert.match(output(present), /WARNING: personal skill install detected:/);
    assert.ok(output(present).includes(personalPath), 'the warning must name the personal directory');
    assert.ok(output(present).includes(expectedRemovalCommand(personalPath)),
      'the warning must print the exact platform removal command');
    assert.ok(existsSync(personalPath), 'the installer must not remove the personal skill');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installer warns about a superseded install without deleting it and is silent otherwise', () => {
  assert.ok(existsSync(installerPath), 'the repository checkout must contain install.mjs');
  const home = mkdtempSync(join(tmpdir(), 'ccc-installer-legacy-'));
  const previousPath = normalize(join(home, '.claude', 'skills', previousName));
  try {
    const absent = runInstaller(home, '--dry-run');
    assert.equal(absent.status, 0, output(absent));
    assert.doesNotMatch(output(absent), /WARNING: previous skill install detected:/,
      'the warning must stay silent when the old directory is absent');

    mkdirSync(previousPath, { recursive: true });
    const present = runInstaller(home, '--dry-run');
    assert.equal(present.status, 0, output(present));
    assert.match(output(present), /WARNING: previous skill install detected:/);
    assert.ok(output(present).includes(previousPath), 'the warning must name the old directory');
    assert.match(output(present), /superseded by uroboros/);
    assert.ok(output(present).includes(expectedRemovalCommand(previousPath)),
      'the warning must print the exact platform removal command');
    assert.ok(existsSync(previousPath), 'the installer must not remove the previous install');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('README teaches marketplace installation first and retains the contributor checkout', () => {
  const readme = readFileSync(readmePath, 'utf8');
  // Keep both placement and exact commands strict so a secondary install path cannot pass.
  const firstSection = /^## ([^\r\n]+)$/m.exec(readme);
  assert.equal(firstSection?.[1], 'Install', 'Install must be the first README section');

  const codeBlocks = [...readme.matchAll(/^```([^\r\n]*)\r?\n([\s\S]*?)\r?\n```/gm)];
  assert.ok(codeBlocks.length > 0, 'README must contain a copyable install block');
  assert.equal(codeBlocks[0][1], 'text', 'the primary install commands run in Claude Code');
  assert.deepEqual(codeBlocks[0][2].split(/\r?\n/), [
    '/plugin marketplace add ortimusirig/uroboros',
    '/plugin install uroboros@uroboros',
  ]);
  const beforePrimaryCommands = readme.slice(0, codeBlocks[0].index);
  assert.match(beforePrimaryCommands, /inside Claude Code \(not a terminal\)/);
  assert.doesNotMatch(beforePrimaryCommands, /git clone|node install[.]mjs/,
    'clone and local verifier instructions must not precede the marketplace install');

  const developmentHeading = readme.indexOf('## Contributor/development setup');
  assert.ok(developmentHeading > codeBlocks[0].index,
    'the contributor/development heading must follow the primary install');
  const development = readme.slice(developmentHeading);
  assert.match(development,
    /only for people who intend to work on the project[\s\S]*only intend to\s+use uroboros[\s\S]*instead of cloning/i);
  const checkoutBlock = /```sh\r?\n([\s\S]*?)\r?\n```/.exec(development);
  assert.ok(checkoutBlock, 'the contributor/development section must retain the checkout path');
  const lines = checkoutBlock[1].split(/\r?\n/);
  assert.deepEqual(lines, [
    'git clone https://github.com/ortimusirig/uroboros.git uroboros',
    'cd uroboros',
    'node install.mjs',
    'node bin/loop.js doctor',
    'node bin/loop.js init ../uroboros-demo',
    'node bin/loop.js run --task ../uroboros-demo/plan.md --target ../uroboros-demo --gate ../uroboros-demo/gate.json',
  ]);

  const loopArgv = lines.slice(3).map((line) => line.split(' ').slice(2));
  const documentedCommands = loopArgv.map((argv) => argv[0]);
  assert.deepEqual(documentedCommands, ['doctor', 'init', 'run']);
  for (const argv of loopArgv) {
    assert.ok(CLI_COMMANDS.includes(argv[0]), `${argv[0]} is absent from the real command list`);
    assert.equal(parseArgs(argv).command, argv[0], `${argv[0]} is documented but not accepted by the parser`);
  }
});

test('the reference documentation files exist and are substantial', () => {
  for (const relative of ['docs/usage.md', 'docs/publishing.md']) {
    const path = fileURLToPath(new URL(`../${relative}`, import.meta.url));
    assert.ok(existsSync(path), `${relative} must exist`);
    assert.ok(readFileSync(path, 'utf8').trim().length > 500,
      `${relative} must hold real reference content, not a stub`);
  }
});

test('every relative link in README resolves to a file that exists', () => {
  const readme = readFileSync(readmePath, 'utf8');
  const targets = [...readme.matchAll(/]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((href) => !/^(https?:|#|mailto:)/.test(href))
    .map((href) => href.split('#')[0])
    .filter((href) => href !== '');
  assert.ok(targets.length > 0,
    'positive control: README must link to at least one local file');
  for (const target of targets) {
    const path = fileURLToPath(new URL(`../${target}`, import.meta.url));
    assert.ok(existsSync(path), `README links to a missing file: ${target}`);
  }
});

test('commands documented in docs/usage.md are accepted by the real parser', () => {
  const usagePath = fileURLToPath(new URL('../docs/usage.md', import.meta.url));
  const usage = readFileSync(usagePath, 'utf8');
  const documented = [...usage.matchAll(/^\s*node bin\/loop\.js ([a-z]+)/gm)]
    .map((match) => match[1]);
  const requiredArgv = new Map([
    ['run', ['run', '--task', 'write docs', '--target', '.', '--gate', 'gate.json']],
    ['batch', ['batch', '--task', 'write docs', '--target', '.', '--gate', 'gate.json']],
    ['status', ['status', 'run-directory']],
    ['publish', ['publish', 'run-directory']],
    ['init', ['init', 'demo-directory']],
  ]);
  assert.ok(documented.length > 0,
    'positive control: docs/usage.md must document at least one command invocation');
  for (const command of new Set(documented)) {
    assert.ok(CLI_COMMANDS.includes(command),
      `${command} is documented but absent from the real command list`);
    assert.equal(parseArgs(requiredArgv.get(command) ?? [command]).command, command,
      `${command} is documented but not accepted by the parser`);
  }
});
