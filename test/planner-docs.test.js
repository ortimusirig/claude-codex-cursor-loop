import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CAMPAIGN_SHAPES } from '../src/campaign.js';
import { CLI_COMMANDS, CLI_USAGE } from '../src/cli-help.js';

const skillPath = fileURLToPath(new URL('../skills/c-cube-loop/SKILL.md', import.meta.url));
const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
const skill = readFileSync(skillPath, 'utf8');
const readme = readFileSync(readmePath, 'utf8');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactNamePattern(name) {
  return new RegExp(
    `(?<![A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`,
    'i',
  );
}

function assertExactName(document, name, owner, decoy = `prefix${name}suffix`) {
  const pattern = exactNamePattern(name);
  assert.match(name, pattern, `positive control: ${name} must match itself`);
  assert.doesNotMatch(
    decoy,
    pattern,
    `discrimination control: ${name} inside ${decoy} must not count`,
  );
  assert.match(document, pattern, `${owner} must name ${name} as a whole token`);
}

function markdownSection(document, heading) {
  const lines = document.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `## ${heading}`);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const next = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return lines.slice(start + 1, next === -1 ? lines.length : next).join('\n');
}

function hasLawStep(law, number, label) {
  return new RegExp(
    `^${number}\\. \\*\\*${escapeRegExp(label)}\\*\\*`,
    'm',
  ).test(law);
}

test('SKILL.md starts its guidance with the non-waivable eight-step planner law', () => {
  const headings = [...skill.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]);
  assert.equal(headings[0], 'Governing law');
  const law = markdownSection(skill, 'Governing law');
  const steps = [
    'Build',
    'Gate verification',
    'Adversarial review',
    'Correction loop',
    'Scoped re-verify',
    'Final planner review',
    'Issues → back to step 4',
    'Integrate',
  ];
  for (const [index, label] of steps.entries()) {
    assert.equal(hasLawStep(law, index + 1, label), true, `missing law step ${index + 1}: ${label}`);
  }
  assert.equal(
    hasLawStep(law, 9, 'Fabricated waiver'),
    false,
    'positive absence control: a fabricated ninth step must be reported absent',
  );
  assert.match(law, /planner never implements/i);
  assert.match(law, /never (?:accept|use) a piped exit code/i);
  assert.match(law, /skill law[\s\S]*never restate it in `TASK[.]md`[\s\S]*no plan can waive it/i);
  assert.match(law, /monitor continuously[\s\S]*slow is not stuck/i);
});

test('SKILL.md names every engine campaignShape and the derived Merge kind', () => {
  assert.ok(CAMPAIGN_SHAPES.length > 0, 'positive control: the engine must expose campaign shapes');
  for (const shape of CAMPAIGN_SHAPES) {
    assertExactName(skill, shape, 'SKILL.md');
  }
  assertExactName(skill, 'Merge', 'SKILL.md');
});

test('SKILL.md and CLI_USAGE agree on planner shape names and every CLI command', () => {
  const expectedShapes = ['Single', 'Parallel', 'Graph', 'Candidates', 'Rounds'];
  const skillShapeSection = markdownSection(skill, 'Planner briefing');
  const skillShapes = [...skillShapeSection.matchAll(/^\|\s*\*\*([^*]+)\*\*\s*\|/gm)]
    .map((match) => match[1]);
  const cliShapeBlock = /^Shapes \([^\n]+\):\r?\n([\s\S]*?)\r?\n\r?\nCommands:/m.exec(CLI_USAGE);
  assert.ok(cliShapeBlock, 'CLI_USAGE must contain a distinct shapes block');
  const cliShapes = [...cliShapeBlock[1].matchAll(/^\s{2}([A-Z][A-Za-z]+)\s{2,}/gm)]
    .map((match) => match[1]);
  assert.deepEqual(skillShapes, expectedShapes);
  assert.deepEqual(cliShapes, expectedShapes);
  assert.deepEqual(cliShapes, skillShapes);

  const decoys = { run: 'running', init: 'initial' };
  for (const name of expectedShapes) {
    assertExactName(skill, name, 'SKILL.md', name === 'Graph' ? 'paragraph' : undefined);
    assertExactName(CLI_USAGE, name, 'CLI_USAGE', name === 'Graph' ? 'paragraph' : undefined);
  }
  for (const command of CLI_COMMANDS) {
    assertExactName(skill, command, 'SKILL.md', decoys[command]);
    assertExactName(CLI_USAGE, command, 'CLI_USAGE', decoys[command]);
  }
});

test('the concurrency guidance states the measured scope and rejects the old corruption claim', () => {
  assert.match(skill, /repository lock[^.]*is in-process only/i);
  assert.match(skill, /`batch`\s+is preferred because it schedules, budgets, and records one campaign/i);
  assert.match(skill, /actual cross-process\s+hazard is reuse of a unit id in the flat scratch root/i);

  const oldClaim = /concurrent (?:loop )?processes (?:can|may|will) corrupt (?:the|a) repository/i;
  assert.match(
    'Concurrent loop processes can corrupt the repository.',
    oldClaim,
    'positive control: the retired claim matcher must detect the old guidance',
  );
  assert.doesNotMatch(skill, oldClaim);
  assert.doesNotMatch(readme, oldClaim);
});

test('historical mode letters survive only as one design-spec cross-reference line', () => {
  assert.doesNotMatch(skill, /\bMode [AB]\b/);
  const historicalLines = readme.split(/\r?\n/).filter((line) => /\bMode [AB]\b/.test(line));
  assert.equal(historicalLines.length, 1);
  assert.match(historicalLines[0], /committed campaign design spec/);
  assert.match(historicalLines[0], /Mode A maps to Candidates\/Rounds, and Mode B maps to Graph/);
});

test('the Graph declaration is documented in file and flag forms', () => {
  assert.match(skill, /batch --campaign <campaign[.]json>/);
  assert.match(skill, /--depends-on CHILD=PARENT/);
  assert.match(CLI_USAGE, /batch --campaign <file>/);
  assert.match(readme, /batch --campaign <campaign[.]json>/);
});
