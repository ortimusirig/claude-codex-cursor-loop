#!/usr/bin/env node
// Verifier and instruction printer for the uroboros Claude Code plugin.
// Cross-platform, zero dependencies, and deliberately hands Claude Code ownership
// of its marketplace, plugin, and settings state.
//
//   node install.mjs                    verify and print plugin install commands
//   node install.mjs --dry-run          verify and preview without the self-test

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_COMMANDS, CLI_USAGE } from './src/cli-help.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const META_DIRECTORY = join(SRC, '.claude-plugin');
const PLUGIN_MANIFEST = join(META_DIRECTORY, 'plugin.json');
const MARKETPLACE_MANIFEST = join(META_DIRECTORY, 'marketplace.json');
const PLUGIN_SKILL = join(SRC, 'skills', 'uroboros', 'SKILL.md');

// This inventory defines the source payload whose readability the verifier checks.
const PAYLOAD = [
  'package.json', 'README.md', 'LICENSE', 'PORTING.md', 'diag.mjs', 'bin', 'src',
  'fixtures', 'test', 'docs', 'cursor-plugin', 'commands', 'skills',
];

const args = process.argv.slice(2);
let dryRun = false;
for (const arg of args) {
  if (arg === '--dry-run') dryRun = true;
  else {
    console.error(`FAIL: unknown argument: ${arg}`);
    process.exit(1);
  }
}

const skillsDirectory = join(homedir(), '.claude', 'skills');
const currentPersonalDest = join(skillsDirectory, 'uroboros');
// Keep the superseded name constructible for upgrade detection without retaining it as
// this package's identifier in source metadata or documentation.
const previousSkillName = ['c', 'cube', 'loop'].join('-');
const previousDest = join(skillsDirectory, previousSkillName);

const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(`FAIL: Node >=24 required, found ${process.versions.node}`);
  process.exit(1);
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function isPayloadFile(item, child) {
  // Run-journal tests and real executions create timestamped notes here. They are
  // runtime output, not package input, and may disappear while a concurrent test
  // process is validating the payload. Keep only the checked-in directory guide.
  if (item === 'docs' && child.startsWith('runs/')) return child === 'runs/README.md';
  return true;
}

function removalCommand(path) {
  if (process.platform === 'win32') {
    return `Remove-Item -LiteralPath '${path.replaceAll("'", "''")}' -Recurse -Force`;
  }
  return `rm -rf -- '${path.replaceAll("'", "'\\''")}'`;
}

function warnAboutSkillDirectory(path, explanation, detail) {
  if (!existsSync(path)) return;
  console.warn(`WARNING: ${explanation}: ${path}`);
  console.warn(detail);
  console.warn('After checking the path, remove it manually with exactly:');
  console.warn(`  ${removalCommand(path)}`);
}

function readJson(path, label) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('top level must be an object');
    }
    return value;
  } catch (error) {
    throw new Error(`${label} is malformed at ${path}: ${error.message}`);
  }
}

function frontmatter(path) {
  const document = readFileSync(path, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
  if (!match) throw new Error(`missing or malformed YAML front matter: ${path}`);
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error(`malformed front matter line in ${path}: ${line}`);
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}

function commandDescription(command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^  ${escaped}\\s{2,}(.+)$`, 'm').exec(CLI_USAGE);
  if (!match) throw new Error(`CLI_USAGE has no Commands entry for ${command}`);
  return match[1].trim();
}

function validatePlugin() {
  for (const [path, label] of [
    [PLUGIN_MANIFEST, 'plugin manifest'],
    [MARKETPLACE_MANIFEST, 'marketplace manifest'],
    [join(SRC, 'package.json'), 'package manifest'],
  ]) {
    if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  }

  const plugin = readJson(PLUGIN_MANIFEST, 'plugin manifest');
  const marketplace = readJson(MARKETPLACE_MANIFEST, 'marketplace manifest');
  const pkg = readJson(join(SRC, 'package.json'), 'package manifest');

  if (plugin.name !== 'uroboros') throw new Error('plugin.json name must be uroboros');
  if (plugin.name !== pkg.name) throw new Error('plugin.json and package.json names disagree');
  if (plugin.version !== pkg.version) throw new Error('plugin.json and package.json versions disagree');
  if (!/^\d+\.\d+\.\d+$/.test(plugin.version ?? '')) {
    throw new Error('plugin.json version must be semantic MAJOR.MINOR.PATCH');
  }
  if (typeof plugin.description !== 'string' || !plugin.description.trim()) {
    throw new Error('plugin.json description must be non-empty');
  }
  for (const field of ['dependencies', 'devDependencies']) {
    if (pkg[field] && Object.keys(pkg[field]).length > 0) {
      throw new Error(`package.json ${field} must stay empty`);
    }
  }

  if (typeof marketplace.name !== 'string' || !marketplace.name.trim()) {
    throw new Error('marketplace.json name must be non-empty');
  }
  if (!marketplace.owner || typeof marketplace.owner.name !== 'string' || !marketplace.owner.name.trim()) {
    throw new Error('marketplace.json owner.name must be non-empty');
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) {
    throw new Error('marketplace.json must contain exactly one plugin entry');
  }
  const entry = marketplace.plugins[0];
  if (entry.name !== plugin.name || entry.source !== './') {
    throw new Error('marketplace plugin must be named uroboros with source "./"');
  }

  for (const component of ['commands', 'skills']) {
    const rootComponent = join(SRC, component);
    if (!existsSync(rootComponent) || !statSync(rootComponent).isDirectory()) {
      throw new Error(`${component}/ must exist at the plugin root`);
    }
    if (existsSync(join(META_DIRECTORY, component))) {
      throw new Error(`${component}/ must not be nested inside .claude-plugin/`);
    }
  }
  if (existsSync(join(SRC, 'SKILL.md'))) {
    throw new Error('the plugin skill must be moved to skills/uroboros/SKILL.md');
  }
  if (!existsSync(PLUGIN_SKILL)) throw new Error(`plugin skill is missing: ${PLUGIN_SKILL}`);
  if (frontmatter(PLUGIN_SKILL).name !== plugin.name) {
    throw new Error('the plugin skill name must match plugin.json');
  }

  const commandDirectory = join(SRC, 'commands');
  const entries = readdirSync(commandDirectory, { withFileTypes: true });
  const actualCommands = entries
    .filter((entryValue) => entryValue.isFile() && entryValue.name.endsWith('.md'))
    .map((entryValue) => entryValue.name.slice(0, -3))
    .sort();
  const unexpectedEntries = entries
    .filter((entryValue) => !entryValue.isFile() || !entryValue.name.endsWith('.md'))
    .map((entryValue) => entryValue.name);
  if (unexpectedEntries.length > 0) {
    throw new Error(`commands/ contains unsupported entries: ${unexpectedEntries.join(', ')}`);
  }
  const missing = CLI_COMMANDS.filter((command) => !actualCommands.includes(command));
  const extra = actualCommands.filter((command) => !CLI_COMMANDS.includes(command));
  if (missing.length || extra.length) {
    throw new Error(`command files disagree with CLI_COMMANDS (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
  for (const command of CLI_COMMANDS) {
    const fields = frontmatter(join(commandDirectory, `${command}.md`));
    if (fields.description !== commandDescription(command)) {
      throw new Error(`${command}.md description must match its CLI_USAGE Commands line`);
    }
    if (fields['disable-model-invocation'] !== 'true') {
      throw new Error(`${command}.md must set disable-model-invocation: true`);
    }
  }

  return { plugin, marketplace };
}

function payloadFiles() {
  const files = [];
  for (const item of PAYLOAD) {
    const source = join(SRC, item);
    if (!existsSync(source)) throw new Error(`payload item missing from source: ${item}`);
    if (statSync(source).isDirectory()) {
      for (const child of walk(source)) {
        if (isPayloadFile(item, child)) {
          files.push(join(source, child));
        }
      }
    } else {
      files.push(source);
    }
  }
  return files;
}

function runSelfTest(cwd) {
  const result = spawnSync(process.execPath, ['--test'], { cwd, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  const pass = /^# pass (\d+)/m.exec(output)?.[1] ?? /pass (\d+)/.exec(output)?.[1] ?? '?';
  const fail = /^# fail (\d+)/m.exec(output)?.[1] ?? /fail (\d+)/.exec(output)?.[1] ?? '?';
  if (result.status !== 0) {
    throw new Error(`self-test failed from ${cwd} (pass=${pass} fail=${fail})`);
  }
  console.log(`self-test: PASS (${pass} tests)`);
}

function reportCliAvailability() {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  for (const bin of ['git', 'codex', 'agent', 'gh']) {
    const result = spawnSync(probe, [bin], { encoding: 'utf8' });
    const missing = bin === 'gh'
      ? 'NOT FOUND (needed only for explicit publish)'
      : 'NOT FOUND (needed at run time)';
    console.log(`${bin}: ${result.status === 0 ? 'found (presence only)' : missing}`);
  }
}

function printPluginInstructions(marketplaceName) {
  const escapedSource = SRC.replaceAll('"', '\\"');
  console.log('\nRun these exact commands inside Claude Code:');
  console.log(`  /plugin marketplace add "${escapedSource}"`);
  console.log(`  /plugin install uroboros@${marketplaceName}`);
}

let manifests;
let payload;
try {
  manifests = validatePlugin();
  payload = payloadFiles();
  for (const source of payload) sha(source);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
}

console.log('MODE=plugin-verifier');
console.log(`source: ${SRC}`);
console.log(`plugin validation: PASS (${CLI_COMMANDS.length} commands, 1 skill)`);

warnAboutSkillDirectory(
  currentPersonalDest,
  'personal skill install detected',
  'That directory duplicates the uroboros skill provided by this plugin.',
);
warnAboutSkillDirectory(
  previousDest,
  'previous skill install detected',
  'That directory is now superseded by uroboros and would leave the host with two equivalent skills.',
);

console.log(`payload: ${payload.length} source files readable by SHA-256`);
if (!dryRun) {
  try {
    runSelfTest(SRC);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
  reportCliAvailability();
} else {
  console.log('--dry-run: no files were written and the self-test was not run.');
}

printPluginInstructions(manifests.marketplace.name);
console.log(`PLUGIN_STATUS=PREPARED mode=plugin${dryRun ? ' dry-run=true' : ''}`);
