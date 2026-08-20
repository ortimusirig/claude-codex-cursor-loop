# Uroboros Rename Implementation Plan (Unit 1)

> **Execution:** This plan is the `--task` input to `node bin/loop.js run`. Codex implements
> it in an isolated worktree; the gate is `node --test`; Cursor reviews. The planner does not
> implement any step of it.

**Goal:** Rename the project to `uroboros` across repository identifiers,
environment variables, artifact filenames, branch prefix, and scratch root, without changing
any behavior and without orphaning existing completed runs.

**Architecture:** Four independent changes. Environment variables move to a `URO_` prefix
behind one central resolver that accepts the old `CCC_` name as a deprecated alias for the
nine documented variables only. Artifact filenames move to `uro-`, with readers falling back
to `ccc-` so runs created before the rename stay publishable. Branch prefix and scratch root
change forward-only with no compatibility. Repository identifiers and two directory names
change in one mechanical sweep guarded by the existing `test/rename.test.js`.

**Tech Stack:** Node 24, ESM, zero runtime dependencies, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-20-uroboros-rename-and-readme-restructure-design.md`

## Global Constraints

- Node `>=24`. ESM only (`"type": "module"`).
- **Zero runtime dependencies.** `package.json` `dependencies` must stay `{}`.
- No behavior changes. Naming only. Gate semantics, verifier handling, campaign scheduling,
  and publish-guard logic are untouched.
- The suite currently passes **413 tests, 0 failures**, true exit code 0. The count may rise
  but must not fall.
- New name is exactly `uroboros`, lowercase. Environment prefix is exactly `URO_`. Artifact
  prefix is exactly `uro-`. Branch prefix is exactly `uro/`.
- Do not rename `bin/loop.js` or the `loop` bin alias.
- Do not modify `README.md` beyond the mechanical identifier replacement. The README
  restructure is Unit 2 and is out of scope here.

---

### Task 1: Environment variable prefix with deprecation alias

**Files:**
- Create: `src/env-compat.js`
- Create: `test/env-compat.test.js`
- Modify: `bin/loop.js:25` and every `process.env.CCC_*` read site in `src/`

**Interfaces:**
- Produces: `readEnv(env, suffix, options?) -> string | undefined` and
  `resetDeprecationWarnings() -> void`, both from `src/env-compat.js`. `suffix` is the
  variable name **without** its prefix, e.g. `'PUBLISH_BLOCKLIST'`.

- [ ] **Step 1: Write the failing test**

```js
// test/env-compat.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEnv, resetDeprecationWarnings } from '../src/env-compat.js';

test('URO_ wins when both prefixes are set', () => {
  resetDeprecationWarnings();
  const warnings = [];
  const value = readEnv(
    { URO_SCRATCH_ROOT: 'C:/uro/w', CCC_SCRATCH_ROOT: 'C:/ccc/w' },
    'SCRATCH_ROOT',
    { warn: (m) => warnings.push(m) },
  );
  assert.equal(value, 'C:/uro/w');
  assert.deepEqual(warnings, [], 'no deprecation warning when the current name is set');
});

test('an aliased variable falls back to CCC_ and warns once', () => {
  resetDeprecationWarnings();
  const warnings = [];
  const env = { CCC_PUBLISH_BLOCKLIST: 'C:/uro/blocklist.txt' };
  const warn = (m) => warnings.push(m);
  assert.equal(readEnv(env, 'PUBLISH_BLOCKLIST', { warn }), 'C:/uro/blocklist.txt');
  assert.equal(readEnv(env, 'PUBLISH_BLOCKLIST', { warn }), 'C:/uro/blocklist.txt');
  assert.equal(warnings.length, 1, 'the deprecation warning is emitted once per variable');
  assert.match(warnings[0], /CCC_PUBLISH_BLOCKLIST/);
  assert.match(warnings[0], /URO_PUBLISH_BLOCKLIST/);
});

test('a non-aliased variable does not fall back to CCC_', () => {
  // Positive control: proves the alias list is consulted rather than every name
  // falling back, which would make the previous assertion pass vacuously.
  resetDeprecationWarnings();
  const warnings = [];
  const value = readEnv(
    { CCC_TEST_SCRATCH_ROOT: 'C:/legacy' },
    'TEST_SCRATCH_ROOT',
    { warn: (m) => warnings.push(m) },
  );
  assert.equal(value, undefined, 'internal variables have no compatibility alias');
  assert.deepEqual(warnings, []);
});

test('returns undefined when neither prefix is set', () => {
  resetDeprecationWarnings();
  assert.equal(readEnv({}, 'SCRATCH_ROOT', { warn: () => {} }), undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/env-compat.test.js`
Expected: FAIL — `Cannot find module '../src/env-compat.js'`.

- [ ] **Step 3: Write the implementation**

```js
// src/env-compat.js
// Variables a user sets themselves. Only these keep a deprecated CCC_ alias; every other
// CCC_ name was internal or test-only and is renamed outright.
const ALIASED = Object.freeze(new Set([
  'SCRATCH_ROOT',
  'PUBLISH_BLOCKLIST',
  'NO_DASHBOARD',
  'EXECUTOR_TIMEOUT_MS',
  'GATE_TIMEOUT_MS',
  'VERIFIER_TIMEOUT_MS',
  'STALL_POLICY',
  'STALL_RESTARTS',
  'STALL_THRESHOLD_MS',
]));

const warned = new Set();

export function resetDeprecationWarnings() {
  warned.clear();
}

export function readEnv(env, suffix, { warn = console.warn } = {}) {
  const current = env?.[`URO_${suffix}`];
  if (current !== undefined) return current;
  if (!ALIASED.has(suffix)) return undefined;

  const legacy = env?.[`CCC_${suffix}`];
  if (legacy === undefined) return undefined;

  if (!warned.has(suffix)) {
    warned.add(suffix);
    warn(`CCC_${suffix} is deprecated; rename it to URO_${suffix}`);
  }
  return legacy;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/env-compat.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Migrate every read site**

Replace each `process.env.CCC_<NAME>` (and each `env?.CCC_<NAME>` / `env.CCC_<NAME>`) with
`readEnv(env, '<NAME>')`, importing from `src/env-compat.js`. All 23 names move to `URO_`;
only membership in `ALIASED` decides whether the old name still resolves.

Known site to change first, as the pattern for the rest:

```js
// bin/loop.js:25 — before
const SCRATCH_ROOT = process.env.CCC_SCRATCH_ROOT ?? DEFAULT_SCRATCH;
// after
const SCRATCH_ROOT = readEnv(process.env, 'SCRATCH_ROOT') ?? DEFAULT_SCRATCH;
```

Find the remainder with:

```bash
git grep -n "CCC_" -- src/ bin/ test/ fixtures/
```

There are **110 occurrences across 36 files**: `src/` 31 in 10 files, `bin/` 2 in 1 file,
`test/` 64 in 20 files, `fixtures/` 13 in 5 files. The step is done when that grep returns
no matches with a true exit code of 1 — check the exit code directly, not through a pipe.

Test fixtures that *set* `CCC_FAKE_*` / `CCC_TEST_*` must set the `URO_` name instead — those
are not aliased, so a fixture left on the old name silently stops being read.

Also update the three `CCC_SCRATCH_ROOT` remediation strings in `src/doctor-checks.js`
(lines 348, 369, 378) to name `URO_SCRATCH_ROOT`, and the `CCC_PUBLISH_BLOCKLIST` strings at
lines 618-651.

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS, at least 417 tests, 0 failures, true exit code 0.

- [ ] **Step 7: Commit**

```bash
git add src/env-compat.js test/env-compat.test.js src bin test fixtures
git commit -m "rename environment prefix to URO_ with a deprecated CCC_ alias"
```

---

### Task 2: Artifact filenames with read fallback

**Files:**
- Modify: `src/artifacts.js`
- Modify: `src/report.js:321-330`, `src/run-journal.js:14`, `src/github-publisher.js:17,50`,
  `src/merge.js:12`, `src/dashboard-view.js:78`, `bin/generate-run-journal.js:12`
- Test: `test/artifact-compat.test.js` (create)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `resolveArtifact(directory, basename) -> string` from `src/artifacts.js`, which
  returns the `uro-` path when it exists and the `ccc-` path when only that exists.
  `basename` is the new name, e.g. `'uro-runfacts.json'`.

- [ ] **Step 1: Write the failing test**

```js
// test/artifact-compat.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_ARTIFACTS, resolveArtifact } from '../src/artifacts.js';

test('resolveArtifact prefers the current name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uro-artifact-'));
  try {
    writeFileSync(join(dir, 'uro-runfacts.json'), '{}');
    writeFileSync(join(dir, 'ccc-runfacts.json'), '{}');
    assert.equal(resolveArtifact(dir, 'uro-runfacts.json'), join(dir, 'uro-runfacts.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveArtifact falls back to the superseded name so old runs stay readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uro-artifact-'));
  try {
    writeFileSync(join(dir, 'ccc-runfacts.json'), '{}');
    assert.equal(resolveArtifact(dir, 'uro-runfacts.json'), join(dir, 'ccc-runfacts.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveArtifact returns the current path when neither file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uro-artifact-'));
  try {
    assert.equal(resolveArtifact(dir, 'uro-report.md'), join(dir, 'uro-report.md'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HARNESS_ARTIFACTS excludes both prefixes from staging and diffs', () => {
  // A pre-rename run directory still holds ccc- files. If they are not excluded they are
  // staged into CHANGES.diff as if they were the unit's own work.
  for (const name of [
    'uro-report.md', 'uro-runfacts.json', 'uro-github.json', 'uro-merge-resolutions.json',
    'ccc-report.md', 'ccc-runfacts.json', 'ccc-github.json', 'ccc-merge-resolutions.json',
  ]) {
    assert.ok(HARNESS_ARTIFACTS.includes(name), `${name} must be excluded`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/artifact-compat.test.js`
Expected: FAIL — `resolveArtifact` is not exported from `src/artifacts.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/artifacts.js
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Files written by the harness inside an isolated worktree. Keep this list central:
// every Git staging/diff operation must exclude the same paths. Both prefixes are listed
// so a run directory created before the rename is still excluded.
export const HARNESS_ARTIFACTS = Object.freeze([
  'TASK.md',
  'CHANGES.diff',
  'uro-report.md',
  'uro-runfacts.json',
  'uro-github.json',
  'uro-merge-resolutions.json',
  'ccc-report.md',
  'ccc-runfacts.json',
  'ccc-github.json',
  'ccc-merge-resolutions.json',
  'events.jsonl',
  'campaign-events.jsonl',
]);

// Read either prefix; write only the current one.
export function resolveArtifact(directory, basename) {
  const current = join(directory, basename);
  if (existsSync(current)) return current;
  const legacy = join(directory, basename.replace(/^uro-/, 'ccc-'));
  if (legacy !== current && existsSync(legacy)) return legacy;
  return current;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/artifact-compat.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Migrate writers and readers**

Writers emit the `uro-` name only:
- `src/report.js:321-330` — `uro-runfacts.json`, `uro-report.md`
- `src/run-journal.js:14` — `RUN_FACTS_FILENAME = 'uro-runfacts.json'`
- `src/github-publisher.js:17` — `GITHUB_NOTE_FILENAME = 'uro-github.json'`
- `src/merge.js:12` — `MERGE_LEDGER_FILENAME = 'uro-merge-resolutions.json'`

Readers go through `resolveArtifact`:
- `src/github-publisher.js:50` — `const factsPath = resolveArtifact(directory, 'uro-runfacts.json');`
- `src/dashboard-view.js:78` — `const factsPath = resolveArtifact(dirname(eventsPath), 'uro-runfacts.json');`

Also update the help text in `bin/generate-run-journal.js:12` and the temp-directory prefix
`'ccc-github-publish-'` at `src/github-publisher.js:263` to `'uro-github-publish-'`.

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS, 0 failures, true exit code 0.

- [ ] **Step 7: Commit**

```bash
git add src bin test
git commit -m "write uro- artifact names and read either prefix"
```

---

### Task 3: Branch prefix and scratch root

**Files:**
- Modify: `src/isolation.js:332`, `src/campaign.js:506,553`, `bin/loop.js:21-24`
- Test: `test/isolation.test.js` (extend existing)

**Interfaces:**
- Consumes: nothing. Forward-only; no compatibility shim.

- [ ] **Step 1: Write the failing test**

```js
// append to test/isolation.test.js
test('a generated branch uses the uro/ prefix', () => {
  const branch = defaultBranchName('2026-08-20T00-00-00-000Z-abcdef12');
  assert.equal(branch, 'uro/2026-08-20T00-00-00-000Z-abcdef12');
  assert.doesNotMatch(branch, /^ccc\//, 'the superseded prefix must not be generated');
});
```

`src/isolation.js` has no branch-name helper today — line 332 builds the name inline inside
`isolate()`:

```js
const branch = suppliedBranch ?? branchName ?? `ccc/${runId}`;
```

Extract that template into an exported `defaultBranchName(runId)` and call it from all three
sites, so the prefix has exactly one definition rather than three that can drift apart.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/isolation.test.js`
Expected: FAIL — either `defaultBranchName` is not exported, or it returns `ccc/...`.

- [ ] **Step 3: Write the implementation**

```js
// src/isolation.js
export function defaultBranchName(runId) {
  return `uro/${runId}`;
}
```

Call it at `src/isolation.js:332` and at `src/campaign.js:506` and `:553`, replacing the
three inline `` `ccc/${...}` `` templates.

Change the scratch root default in `bin/loop.js`:

```js
const DEFAULT_SCRATCH = process.platform === 'win32'
  ? 'C:/uro/w'
  : join(homedir(), '.uro', 'w');
```

Update the example path in the `src/doctor-checks.js:348` remediation string from
`C:\\ccc\\w` to `C:\\uro\\w`.

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS, 0 failures, true exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src bin test
git commit -m "move branch prefix and scratch root to uro"
```

---

### Task 4: Repository identifiers, directories, and the rename guard

**Files:**
- Modify: `test/rename.test.js` (first — it is the specification)
- Rename the governing skill directory to `skills/uroboros/`
- Rename: `cursor-plugin/skills/ccc-verify/` -> `cursor-plugin/skills/uro-verify/`
- Modify: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
  `install.mjs`, `README.md`, `PORTING.md`, `commands/batch.md`, `commands/run.md`,
  `test/planner-docs.test.js`, `test/plugin-packaging.test.js`, and the five files under
  `docs/superpowers/`

**Interfaces:**
- Consumes: nothing from Tasks 1-3.

- [ ] **Step 1: Update the guard test to specify the new name**

In `test/rename.test.js`, change the two identity constants. The superseded name must stay
assembled at runtime — writing it as a literal would make this file fail its own
stale-identifier scan:

```js
const currentName = 'uroboros';
const previousName = ['c', 'cube', 'loop'].join('-');
```

Update `skillPath` to `../skills/uroboros/SKILL.md`, and update every repository reference
to `ortimusirig/uroboros` — including the CI badge assertion, the
two marketplace install lines, and the six-line contributor block, whose first two lines
become:

```
git clone https://github.com/ortimusirig/uroboros.git uroboros
cd uroboros
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/rename.test.js`
Expected: FAIL — `package.json` still has the superseded name; the new skill path does
not exist; README still carries the superseded name.

- [ ] **Step 3: Rename the two directories**

```bash
# Move the superseded governing skill directory to skills/uroboros.
git mv cursor-plugin/skills/ccc-verify cursor-plugin/skills/uro-verify
```

- [ ] **Step 4: Replace the identifier across all remaining files**

Set `name` to `uroboros` in `package.json`, `.claude-plugin/plugin.json`, and both `name`
fields in `.claude-plugin/marketplace.json`. Set the `name:` frontmatter in
`skills/uroboros/SKILL.md` to `uroboros`.

In `install.mjs`, four sites:

```js
// line 26
const PLUGIN_SKILL = join(SRC, 'skills', 'uroboros', 'SKILL.md');
// line 45
const currentPersonalDest = join(skillsDirectory, 'uroboros');
// line 48 — re-point the superseded-install detector one generation forward
const previousSkillName = ['c', 'cube', 'loop'].join('-');
// line 282
'That directory is now superseded by uroboros and would leave the host with two equivalent skills.'
```

Also update the error string at `install.mjs:175` to name `skills/uroboros/SKILL.md`.

In `README.md`, `PORTING.md`, `commands/*.md`, and the five `docs/superpowers/` files,
replace the superseded repository identifier and command namespace with `uroboros` and
`/uroboros:`. Confine README edits to this replacement — the restructure is Unit 2.

- [ ] **Step 5: Run the guard test to verify it passes**

Run: `node --test test/rename.test.js`
Expected: PASS.

- [ ] **Step 6: Verify no shipped file retains the superseded name**

Run the stale-identifier search specified by `test/rename.test.js`.

Expected: no matches, true exit code 1. Do not pipe this into another command — a pipe
reports the last command's exit code, not the grep's.

- [ ] **Step 7: Run the full suite**

Run: `node --test`
Expected: PASS, 0 failures, true exit code 0, test count not below 413.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "rename the project to uroboros"
```

---

## Invariants

- `node --test` exits 0 with no fewer tests than the 413 passing before this plan.
- No shipped file contains the superseded repository identifier.
- A run directory containing `ccc-runfacts.json` and no `uro-runfacts.json` is still read by
  `publish` and by the dashboard.
- `package.json` `dependencies` stays `{}`.
- The publish guard stays fail-closed: a missing or unusable blocking prerequisite refuses
  the publish.
- `bin/loop.js` keeps its filename and the `loop` bin alias.

## Out of scope

- The README restructure and the `docs/usage.md` / `docs/publishing.md` split (Unit 2).
- Documenting the publish guard's four layers or the blocklist format (Unit 2).
- Any change to publish-guard, gate, verifier, or campaign logic.
- Renaming the GitHub repository, reinstalling the plugin, renaming the working directory,
  or renaming the existing `ccc/*` branches. These are operator steps outside the run.
