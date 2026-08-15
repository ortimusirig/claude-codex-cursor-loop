import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { HARNESS_ARTIFACTS } from '../src/run.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const licensePath = fileURLToPath(new URL('../LICENSE', import.meta.url));
const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
const installerPath = fileURLToPath(new URL('../install.mjs', import.meta.url));
const logdyConfigPath = fileURLToPath(new URL('../docs/optional-tools/logdy-run-events.json', import.meta.url));
const verifierPluginManifestPath = fileURLToPath(new URL('../cursor-plugin/.cursor-plugin/plugin.json', import.meta.url));
const verifierSkillPath = fileURLToPath(new URL('../cursor-plugin/skills/ccc-verify/SKILL.md', import.meta.url));

test('the repository ships a substantive MIT license', () => {
  assert.ok(existsSync(licensePath), 'LICENSE must exist at the repository root');
  const license = readFileSync(licensePath, 'utf8');
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /The above copyright notice and this permission notice/);
  assert.match(license, /Copyright \(c\) 2026 Sumitro Giri/);

  const readme = readFileSync(readmePath, 'utf8');
  const link = readme.match(/\[LICENSE\]\(([^)]+)\)/);
  assert.ok(link, 'README.md must link to LICENSE');
  assert.equal(fileURLToPath(new URL(`../${link[1]}`, import.meta.url)), licensePath);
});

test('the installer payload includes every shippable top-level entry', () => {
  // install.mjs is source-only, so the installer's own installed-copy self-test
  // verifies the materialized payload instead of reparsing an absent script.
  if (!existsSync(installerPath)) {
    assert.ok(existsSync(licensePath), 'the installed payload must contain LICENSE');
    return;
  }

  const installer = readFileSync(installerPath, 'utf8');
  const declaration = installer.match(/const PAYLOAD\s*=\s*(\[[\s\S]*?\]);/);
  assert.ok(declaration, 'install.mjs must declare a literal PAYLOAD array');
  const payload = vm.runInNewContext(declaration[1], Object.create(null));
  assert.ok(Array.isArray(payload), 'PAYLOAD must parse as an array');
  assert.ok(payload.includes('LICENSE'), 'PAYLOAD must include LICENSE');
  assert.ok(payload.includes('docs'),
    'PAYLOAD must include docs; an existing but unlisted tree is silently omitted');
  assert.ok(payload.includes('cursor-plugin'),
    'PAYLOAD must include the Cursor verifier plugin; an unlisted skill is not installed');

  // Harness artifacts are generated into a run's directory, not shipped. Derived from
  // run.js so a newly added artifact cannot be excluded from the diff but still
  // counted as shippable here.
  const repositoryOnly = new Set(['install.mjs', ...HARNESS_ARTIFACTS]);
  const shippable = readdirSync(root, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.') && !repositoryOnly.has(name));
  const omitted = shippable.filter((name) => !payload.includes(name));
  assert.deepEqual(omitted, [], `PAYLOAD omits shippable root entries: ${omitted.join(', ')}`);
});

test('the shipped ccc-verify skill carries the strict verdict and assertion-audit contracts', () => {
  assert.ok(existsSync(verifierPluginManifestPath), 'the local Cursor plugin manifest must exist');
  assert.ok(existsSync(verifierSkillPath), 'the ccc-verify SKILL.md must exist');
  const manifest = JSON.parse(readFileSync(verifierPluginManifestPath, 'utf8'));
  const skill = readFileSync(verifierSkillPath, 'utf8');

  assert.equal(manifest.name, 'ccc-verify');
  assert.match(skill, /^---\r?\nname: ccc-verify\r?\n[\s\S]*?\r?\n---\r?\n/,
    'the skill must have valid ccc-verify YAML frontmatter');
  assert.match(skill,
    /## Verdict contract — mandatory[\s\S]*final non-empty line must be exactly\s+`NO_BLOCKERS` or exactly `ISSUES`, alone on its own line/,
    'the contract must require an authoritative bare token on the final line');
  assert.match(skill,
    /Wrong — concludes in prose and never emits the token:[\s\S]*I don't see blocking bugs/,
    'the observed missing-token failure must be shown as wrong');
  assert.match(skill,
    /Wrong — puts a token inside a sentence instead of on the final line:[\s\S]*Non-blocking notes \(not ISSUES\)/,
    'the observed token-in-prose failure must be shown as wrong');
  assert.match(skill,
    /## Intent audit[\s\S]*does everything `TASK[.]md` asked[\s\S]*Would it still pass if the feature under test were broken[\s\S]*positive control proving the check could[\s\S]*correct and incorrect implementations produce identical results[\s\S]*process[.]cwd\(\)[\s\S]*artifacts written only after the gate/,
    'the skill must carry the full intent and assertion-audit checklist');
});

test('the optional Logdy layout is valid JSON with explicit event columns', () => {
  const config = JSON.parse(readFileSync(logdyConfigPath, 'utf8'));
  assert.equal(config.name, 'ccc-run-events');
  const names = config.columns.map((column) => column.name);
  for (const name of ['Time', 'Run', 'Stage', 'Type', 'File', 'Command', 'Code', 'Verdict']) {
    assert.ok(names.includes(name), `missing Logdy column: ${name}`);
  }
  assert.ok(config.columns.every((column) => typeof column.handlerTsCode === 'string'));
});
