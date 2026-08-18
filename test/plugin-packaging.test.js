import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_COMMANDS, CLI_USAGE } from '../src/cli-help.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const commandDirectory = join(root, 'commands');
const metadataDirectory = join(root, '.claude-plugin');
const pluginManifestPath = join(metadataDirectory, 'plugin.json');
const marketplaceManifestPath = join(metadataDirectory, 'marketplace.json');
const packagePath = join(root, 'package.json');
const installerPath = join(root, 'install.mjs');
const readmePath = join(root, 'README.md');
const skillPath = join(root, 'skills', 'c-cube-loop', 'SKILL.md');

function parseFrontmatter(path) {
  const document = readFileSync(path, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
  assert.ok(match, `${path} must start with parseable YAML front matter`);
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    assert.notEqual(separator, -1, `front matter line must contain a colon: ${line}`);
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { document, fields };
}

function commandDescriptions() {
  const block = /\nCommands:\r?\n([\s\S]+)$/.exec(CLI_USAGE);
  assert.ok(block, 'CLI_USAGE must expose a Commands block');
  return Object.fromEntries([...block[1].matchAll(/^\s{2}([a-z][a-z-]*)\s{2,}(.+)$/gm)]
    .map((match) => [match[1], match[2].trim()]));
}

function coverageErrors(cliCommands, commandFiles) {
  return {
    missing: cliCommands.filter((command) => !commandFiles.includes(command)),
    extra: commandFiles.filter((command) => !cliCommands.includes(command)),
  };
}

function placementErrors(paths) {
  const normalized = paths.map((path) => path.replaceAll('\\', '/'));
  const errors = [];
  if (!normalized.includes('.claude-plugin/plugin.json')) errors.push('missing plugin.json');
  for (const component of ['commands', 'skills']) {
    if (!normalized.some((path) => path.startsWith(`${component}/`))) {
      errors.push(`missing root ${component}`);
    }
    if (normalized.some((path) => path.startsWith(`.claude-plugin/${component}/`))) {
      errors.push(`nested ${component}`);
    }
  }
  return errors;
}

function runInstaller(home, ...args) {
  return spawnSync(process.execPath, [installerPath, '--dry-run', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

function output(result) {
  return `${result.stdout}${result.stderr}`;
}

test('CLI commands and plugin command files cover one another exactly', () => {
  const entries = readdirSync(commandDirectory, { withFileTypes: true });
  assert.ok(entries.every((entry) => entry.isFile() && entry.name.endsWith('.md')),
    'commands/ must contain only flat Markdown command files');
  const commandFiles = entries.map((entry) => entry.name.slice(0, -3)).sort();
  const actual = coverageErrors([...CLI_COMMANDS], commandFiles);
  assert.deepEqual(actual.missing, [], `missing command files: ${actual.missing.join(', ')}`);
  assert.deepEqual(actual.extra, [], `stale command files: ${actual.extra.join(', ')}`);

  const fabricated = 'fabricated-command';
  const missingControl = coverageErrors([...CLI_COMMANDS, fabricated], commandFiles);
  assert.deepEqual(missingControl.missing, [fabricated],
    'positive control: a fabricated CLI command must be reported missing');
  const staleControl = coverageErrors([...CLI_COMMANDS], [...commandFiles, fabricated]);
  assert.deepEqual(staleControl.extra, [fabricated],
    'positive control: a fabricated command file must be reported stale');
});

test('every command has valid front matter, the CLI description, and controller safety law', () => {
  const descriptions = commandDescriptions();
  assert.deepEqual(Object.keys(descriptions), [...CLI_COMMANDS],
    'the parsed Commands block must itself cover CLI_COMMANDS in order');

  for (const command of CLI_COMMANDS) {
    const path = join(commandDirectory, `${command}.md`);
    const { document, fields } = parseFrontmatter(path);
    assert.ok(fields.description, `${command}.md description must be non-empty`);
    assert.equal(fields.description, descriptions[command],
      `${command}.md description must not contradict CLI_USAGE`);
    assert.equal(fields['disable-model-invocation'], 'true');
    assert.ok(document.includes('$ARGUMENTS'), `${command}.md must forward $ARGUMENTS`);
    assert.match(document, /true exit code/i);
    assert.match(document, /never through a pipe|never acceptable/i);
    assert.match(document, new RegExp(`bin/loop[.]js" ${command} \\$ARGUMENTS`));
  }

  for (const command of ['run', 'batch']) {
    const document = readFileSync(join(commandDirectory, `${command}.md`), 'utf8');
    assert.match(document, /skills\/c-cube-loop\/SKILL[.]md/);
    assert.match(document, /planner authors[\s\S]*Codex implements[\s\S]*planner\s+never/i);
    assert.match(document, /usable `--task`/);
    assert.match(document, /author[\s\S]*or ask the user/);
    assert.match(document, /Do not\s+invent[\s\S]*spend tokens/i);
  }
});

test('plugin and marketplace manifests have the required identity and root layout', () => {
  if (!existsSync(installerPath) && !existsSync(pluginManifestPath)) {
    assert.ok(existsSync(join(root, 'SKILL.md')),
      'the opt-in standalone installation must retain its root SKILL.md');
    return;
  }
  assert.ok(existsSync(pluginManifestPath), 'plugin.json must exist inside .claude-plugin/');
  assert.ok(existsSync(marketplaceManifestPath), 'marketplace.json must exist inside .claude-plugin/');
  const plugin = JSON.parse(readFileSync(pluginManifestPath, 'utf8'));
  const marketplace = JSON.parse(readFileSync(marketplaceManifestPath, 'utf8'));
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));

  assert.equal(plugin.name, 'c-cube-loop');
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
  assert.ok(plugin.description);
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.devDependencies ?? {}, {});
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.equal(marketplace.plugins[0].source, './');

  assert.ok(existsSync(join(root, 'commands')));
  assert.ok(existsSync(join(root, 'skills', 'c-cube-loop', 'SKILL.md')));
  assert.equal(existsSync(join(metadataDirectory, 'commands')), false);
  assert.equal(existsSync(join(metadataDirectory, 'skills')), false);
  assert.equal(existsSync(join(root, 'SKILL.md')), false, 'the root skill must have been moved');

  const correctShape = [
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    'commands/run.md',
    'skills/c-cube-loop/SKILL.md',
  ];
  assert.deepEqual(placementErrors(correctShape), [],
    'positive valid-layout control must be accepted');
  const misplaced = placementErrors([...correctShape, '.claude-plugin/commands/run.md']);
  assert.ok(misplaced.includes('nested commands'),
    'misplacement control: nesting commands in .claude-plugin must fail validation');
});

test('installer dry-run leaves all Claude Code managed state byte-identical', () => {
  if (!existsSync(installerPath)) {
    assert.ok(existsSync(packagePath), 'installed-copy self-test must still run from the payload');
    return;
  }
  const home = mkdtempSync(join(tmpdir(), 'ccc-managed-state-'));
  const statePaths = [
    join(home, '.claude', 'plugins', 'known_marketplaces.json'),
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    join(home, '.claude', 'settings.json'),
  ];
  try {
    const sentinels = [
      Buffer.from('{"sentinel":"marketplaces"}\n'),
      Buffer.from('{"sentinel":"plugins"}\n'),
      Buffer.from('{"sentinel":"settings"}\n'),
    ];
    for (const [index, path] of statePaths.entries()) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, sentinels[index]);
    }

    const bytesEqual = (left, right) => Buffer.compare(left, right) === 0;
    assert.equal(bytesEqual(Buffer.from([0x01]), Buffer.from([0x02])), false,
      'positive control: the byte comparison must detect a change');
    assert.equal(bytesEqual(Buffer.from([0x01]), Buffer.from([0x01])), true);

    const result = runInstaller(home);
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /MODE=plugin-verifier/);
    assert.ok(output(result).includes(normalize(root).replace(/[\\/]$/, '')),
      'installer instructions must contain this checkout absolute path');
    assert.match(output(result), /\/plugin marketplace add/);
    assert.match(output(result), /\/plugin install c-cube-loop@c-cube-loop/);
    assert.match(output(result), /PLUGIN_STATUS=PREPARED mode=plugin/);
    assert.doesNotMatch(output(result), /PLUGIN_STATUS=INSTALLED/);

    for (const [index, path] of statePaths.entries()) {
      assert.equal(bytesEqual(readFileSync(path), sentinels[index]), true,
        `${path} must remain byte-identical`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('README and the governing skill document plugin installation and every command surface', () => {
  const readme = readFileSync(readmePath, 'utf8');
  const skill = readFileSync(skillPath, 'utf8');
  for (const document of [readme, skill]) {
    assert.match(document, /\/plugin marketplace add/);
    assert.match(document, /\/plugin install c-cube-loop@c-cube-loop/);
    for (const command of CLI_COMMANDS) {
      assert.ok(document.includes(`/c-cube-loop:${command}`),
        `documentation must name /c-cube-loop:${command}`);
      assert.ok(document.includes(`node bin/loop.js ${command}`),
        `documentation must retain node bin/loop.js ${command}`);
    }
  }
});
