import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
const setupSkillRelativePath = 'skills/uroboros-setup/SKILL.md';
const setupSkillPath = fileURLToPath(new URL(`../${setupSkillRelativePath}`, import.meta.url));

test('README gives AI agents a bootstrap entry point backed by the shipped skill', () => {
  const readme = readFileSync(readmePath, 'utf8');

  assert.match(readme, /^### If you are an AI agent setting this up for someone$/m,
    'README must contain the agent setup entry point');
  assert.ok(readme.includes(setupSkillRelativePath),
    `agent setup entry point must reference ${setupSkillRelativePath}`);
  assert.ok(existsSync(setupSkillPath),
    `agent setup entry point references a missing procedure: ${setupSkillRelativePath}`);
});

test('README raw setup URL identifies the canonical repository, branch, and skill path', () => {
  const readme = readFileSync(readmePath, 'utf8');
  const rawUrl = readme.match(
    /https:\/\/raw[.]githubusercontent[.]com\/([^/\s>]+)\/([^/\s>]+)\/([^/\s>]+)\/([^\s>]+)/,
  );

  assert.ok(rawUrl, 'README must contain a fetchable raw GitHub URL for the setup skill');
  assert.deepEqual({
    owner: rawUrl[1],
    repository: rawUrl[2],
    branch: rawUrl[3],
    path: rawUrl[4],
  }, {
    owner: 'ortimusirig',
    repository: 'uroboros',
    branch: 'main',
    path: setupSkillRelativePath,
  }, 'raw setup URL must use the current repository, default branch, and on-disk skill path');
});

test('README leaves platform-specific Cursor install commands in the setup skill only', () => {
  const readme = readFileSync(readmePath, 'utf8');
  const setupSkill = readFileSync(setupSkillPath, 'utf8').replaceAll('\\|', '|');
  const pinnedInstallCommands = [
    "irm 'https://cursor.com/install?win32=true' | iex",
    'curl https://cursor.com/install -fsS | bash',
  ];

  for (const command of pinnedInstallCommands) {
    assert.ok(setupSkill.includes(command),
      `positive control: setup skill must retain the pinned platform install command: ${command}`);
    assert.equal(readme.includes(command), false,
      `README must not duplicate the setup skill's pinned platform install command: ${command}`);
  }
});

test('README requires a session restart between plugin installation and first setup', () => {
  const readme = readFileSync(readmePath, 'utf8');
  const pluginInstallIndex = readme.indexOf('/plugin install uroboros@uroboros');
  const firstSetupIndex = readme.indexOf('/uroboros:setup', pluginInstallIndex);

  assert.ok(pluginInstallIndex >= 0, 'positive control: README must contain the plugin install command');
  assert.ok(firstSetupIndex > pluginInstallIndex,
    'positive control: README must place its first setup command after plugin installation');
  assert.match(readme.slice(pluginInstallIndex, firstSetupIndex),
    /restart the Claude Code session/i,
    'README must require restarting the session after plugin installation and before setup');
});
