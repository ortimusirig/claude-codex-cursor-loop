# Uroboros Rename — Correction Round 1

> **Execution:** This plan is the `--task` input to `node bin/loop.js run`. Codex implements
> it in an isolated worktree; the gate is `node --test`; Cursor reviews.

**Goal:** Close three findings from the planner review of the rename. All three are plan
defects, not implementation defects — the previous plan under-specified them, and the
executor followed it faithfully.

**Architecture:** Three independent corrections. The Cursor verifier skill gets its identity
renamed to match its already-renamed directory. Run-journal discovery gains the same legacy
filename fallback that `resolveArtifact` already gives publishing. One internal status
literal is brought in line with the new name.

**Tech Stack:** Node 24, ESM, zero runtime dependencies, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-20-uroboros-rename-and-readme-restructure-design.md`

## Global Constraints

- Node `>=24`. ESM only. `package.json` `dependencies` must stay `{}`.
- The suite passes **422 tests, 0 failures**, true exit code 0. The count may rise but must
  not fall.
- **No `.md`, `.js`, `.mjs`, `.json`, `.jsonl`, `.ps1`, or `.cmd` file under the shipped
  roots may contain the superseded project name.** `test/rename.test.js` scans for it and
  builds it at runtime as `['c', 'cube', 'loop'].join('-')`. Any new prose must refer to it
  indirectly, exactly as this sentence does.
- No behavior changes beyond the three corrections below.
- Do not touch `README.md` structure. The restructure is Unit 2.

---

### Task 1: Rename the Cursor verifier skill identity

The directory is already `cursor-plugin/skills/uro-verify/`, but the skill inside it is still
*named* `ccc-verify` — in its frontmatter, in the plugin manifest, and in the two prompts
that invoke it. It works, because a slash command resolves by name rather than by directory,
but it leaves a directory and its contents disagreeing about what the skill is called.

**Files:**
- Modify: `cursor-plugin/skills/uro-verify/SKILL.md` (frontmatter `name`, `# ` heading, description)
- Modify: `cursor-plugin/.cursor-plugin/plugin.json` (`name`)
- Modify: `src/verifier.js:24-25` (both prompts)
- Modify: `test/packaging.test.js:90-98`
- Modify: `test/verifier.test.js:117`
- Modify: `README.md:380` (the one inline mention; no structural edits)

**Interfaces:**
- Produces: the skill is named `uro-verify` and is invoked as `/uro-verify`.

- [ ] **Step 1: Update the assertions first**

In `test/verifier.test.js:117`:

```js
assert.match(prompt, /^\/uro-verify\b/, 'the prompt must explicitly select the shipped skill');
```

In `test/packaging.test.js`, change the three identity assertions:

```js
assert.equal(manifest.name, 'uro-verify');
assert.match(skill, /^---\r?\nname: uro-verify\r?\n[\s\S]*?\r?\n---\r?\n/,
  'the skill must have valid uro-verify YAML frontmatter');
```

and the two `existsSync` / message strings that name the skill.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/verifier.test.js test/packaging.test.js`
Expected: FAIL — the prompt still begins `/ccc-verify` and the manifest name still reads
`ccc-verify`.

- [ ] **Step 3: Rename the identity**

`cursor-plugin/skills/uro-verify/SKILL.md` frontmatter and heading:

```
---
name: uro-verify
description: Audit CHANGES.diff for correctness or against TASK.md, including assertion quality, and return the strict uroboros verifier verdict. Use for the correctness and intent verifier passes in uroboros.
disable-model-invocation: true
---

# uro-verify
```

`cursor-plugin/.cursor-plugin/plugin.json`:

```json
{
  "name": "uro-verify"
}
```

Preserve every other key in that manifest exactly as it is.

`src/verifier.js:24-25` — change only the leading token of each prompt, leaving the rest of
both strings byte-for-byte identical:

```js
export const DEFAULT_PROMPT = '/uro-verify Read CHANGES.diff and judge the change for correctness and blocking bugs; make the final line exactly NO_BLOCKERS or exactly ISSUES.';
export const INTENT_PROMPT = '/uro-verify Read TASK.md and CHANGES.diff and judge whether the diff fully implements every TASK.md requirement and whether new or changed assertions detect broken behavior; make the final line exactly NO_BLOCKERS or exactly ISSUES.';
```

`assertUsablePrompt` forbids double quotes and newlines; both strings must still satisfy it.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/verifier.test.js test/packaging.test.js`
Expected: PASS.

- [ ] **Step 5: Mutation pin**

Temporarily set `DEFAULT_PROMPT` back to begin `/ccc-verify`. Run
`node --test test/verifier.test.js`. Record the failing count and confirm the failure is the
`^\/uro-verify\b` assertion specifically, not an unrelated one. Restore the correct value,
rerun, and record the green count. Both counts go in the final message.

- [ ] **Step 6: Commit**

```bash
git add cursor-plugin src/verifier.js test/verifier.test.js test/packaging.test.js README.md
git commit -m "rename the cursor verifier skill identity to uro-verify"
```

---

### Task 2: Run-journal legacy filename fallback

`src/run-journal.js:14` sets `RUN_FACTS_FILENAME = 'uro-runfacts.json'` and discovery looks
for only that name, so a run directory produced before the rename makes
`generate-run-journal` throw. Publishing already handles this through `resolveArtifact`;
journal discovery does not.

**Files:**
- Modify: `src/run-journal.js` (lines 14, 29-30, 35, 37, 235)
- Test: `test/run-journal.test.js` (extend)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `LEGACY_RUN_FACTS_FILENAME` exported from `src/run-journal.js`; discovery accepts
  either filename and prefers the current one.

- [ ] **Step 1: Write the failing tests**

```js
// append to test/run-journal.test.js
test('a run directory holding only the superseded run-facts name is still discoverable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uro-journal-legacy-'));
  try {
    writeFileSync(join(dir, 'ccc-runfacts.json'), JSON.stringify({ runId: 'r1' }));
    const found = resolveRunFactsPath(dir);
    assert.equal(found, join(dir, 'ccc-runfacts.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory holding both names prefers the current one and is not an error', () => {
  // Positive control: both files coexisting is the normal migration state, not the
  // "multiple run-facts files" ambiguity the discovery guard is meant to reject.
  const dir = mkdtempSync(join(tmpdir(), 'uro-journal-both-'));
  try {
    writeFileSync(join(dir, 'uro-runfacts.json'), JSON.stringify({ runId: 'current' }));
    writeFileSync(join(dir, 'ccc-runfacts.json'), JSON.stringify({ runId: 'legacy' }));
    assert.equal(resolveRunFactsPath(dir), join(dir, 'uro-runfacts.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

If `src/run-journal.js` exposes discovery under a different name than
`resolveRunFactsPath`, use the real exported name in these tests rather than adding an alias.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/run-journal.test.js`
Expected: FAIL — discovery reports that the directory does not contain the current
run-facts filename.

- [ ] **Step 3: Implement the fallback**

```js
export const RUN_FACTS_FILENAME = 'uro-runfacts.json';
export const LEGACY_RUN_FACTS_FILENAME = 'ccc-runfacts.json';
```

Build the candidate list so the current name is checked before the superseded one at each
location already probed (`input`, and `input/w`). Two files that differ only by prefix in
the same directory are **not** the "multiple run-facts files" condition — that guard must
continue to fire only when the same filename is found at more than one distinct location.
Update the not-found error at line 37 to name both filenames. In the recursive scan at line
235, match either filename.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/run-journal.test.js`
Expected: PASS.

- [ ] **Step 5: Mutation pin**

Temporarily remove `LEGACY_RUN_FACTS_FILENAME` from the candidate list. Run
`node --test test/run-journal.test.js`, confirm the legacy-discovery test fails specifically,
and record the failing count. Restore, rerun, record the green count.

- [ ] **Step 6: Commit**

```bash
git add src/run-journal.js test/run-journal.test.js
git commit -m "read the superseded run-facts filename when generating journals"
```

---

### Task 3: Dashboard probe status literal

`src/dashboard-launcher.js` uses the bare string `'ccc'` as an internal probe status at lines
56, 60, 148, and 198. It is set and compared inside one module, so it is inert — but it
contradicts the rename everywhere it appears.

**Files:**
- Modify: `src/dashboard-launcher.js:56,60,148,198`
- Test: `test/dashboard-launcher.test.js` (extend if no assertion covers the status value)

- [ ] **Step 1: Change all four sites together**

Replace the status value `'ccc'` with `'uroboros'` at every site that produces or compares
it. All four must change in the same edit: a probe that reports one value while the caller
compares another silently reclassifies a live dashboard as foreign, and the loop would then
refuse a port it actually owns.

- [ ] **Step 2: Run the suite**

Run: `node --test`
Expected: PASS, 0 failures, true exit code 0.

- [ ] **Step 3: Mutation pin**

Change line 56 alone to emit `'uro'` while the comparison at line 148 still expects
`'uroboros'`. Run `node --test test/dashboard-launcher.test.js` and confirm a test fails. If
none does, add an assertion that a probe against a live dashboard returns the owned status
rather than `'foreign'`, and pin that new assertion the same way. Restore and record both
counts.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard-launcher.js test/dashboard-launcher.test.js
git commit -m "bring the dashboard probe status in line with the project name"
```

---

## Invariants

- `node --test` exits 0 with at least 422 tests and 0 failures.
- No shipped file contains the superseded project name, per `test/rename.test.js`.
- `package.json` `dependencies` stays `{}`.
- The `URO_` environment alias behavior and the `uro-`/legacy artifact fallback added in the
  previous round are unchanged.
- Both verifier prompts remain single-line and free of double quotes, so
  `assertUsablePrompt` still accepts them.

## Out of scope

- The remaining internal `ccc-` sentinels: `ccc-test-count-floor`, `ccc-base`, `ccc-setup`,
  `ccc-doctor-*`, `ccc-publish-prose-`. All are inert internal names.
- `github-publisher.js:157`, the `ccc-verifier-review` pull-request comment marker. This is
  deliberately preserved: it is the idempotency key used to match comments on already-open
  pull requests, and changing it would orphan those comments and post duplicates.
- The README restructure and publish-guard documentation (Unit 2).

## Operator note

Task 1 changes the Cursor plugin's skill name. The installed plugin still provides the old
name, so it must be reinstalled before the next run — otherwise both verifier passes will
invoke a slash command that no longer exists and will return no usable verdict.
