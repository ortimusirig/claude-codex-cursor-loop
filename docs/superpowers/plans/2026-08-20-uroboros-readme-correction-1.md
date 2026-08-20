# README Restructure — Correction Round 1

> **Execution:** This plan is the `--task` input to `node bin/loop.js run`. Codex implements
> it in an isolated worktree; the gate is `node --test`; Cursor reviews.

**Goal:** Close two findings from the review of the README restructure. The correctness
verifier found the first and was right; the second is a factual error the planner introduced
and which is now shipped in user-facing documentation.

**Architecture:** Two independent corrections, both confined to test and documentation files.

**Tech Stack:** Node 24, ESM, zero runtime dependencies, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-20-uroboros-rename-and-readme-restructure-design.md`

## Global Constraints

- Node `>=24`. ESM only. `package.json` `dependencies` must stay `{}`.
- The suite passes **427 tests, 0 failures**, true exit code 0. The count may rise but must
  not fall.
- **No shipped file may contain the superseded project name.** `test/rename.test.js` builds
  it at runtime as `['c', 'cube', 'loop'].join('-')` and scans for it.
- No file under `src/` or `bin/` may change.
- Do not alter README structure. `test/rename.test.js` pins the Install section, the first
  fenced block, and the six-line contributor block.

---

### Task 1: Restore README coverage to the planner-doc invariants

When reference content moved into `docs/`, `test/planner-docs.test.js` was **retargeted**
from `README.md` to `docs/usage.md` rather than **extended** to cover both. The file no
longer reads README at all, so two invariants that used to guard the landing page now do
not: a regression reintroducing `Mode A`/`Mode B` or the superseded corruption claim into
`README.md` or `docs/publishing.md` would stay green.

**Files:**
- Modify: `test/planner-docs.test.js` (lines 9-11 for the reads; lines 127-132 for the assertions)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the two invariants apply to the skill, `docs/usage.md`, `docs/publishing.md`,
  and `README.md`.

- [ ] **Step 1: Read all four surfaces**

Beside the existing `usagePath` and `usage` at lines 9 and 11, add reads for `README.md` and
`docs/publishing.md`, following the same `fileURLToPath(new URL(...))` pattern the file
already uses. Then define one array the assertions can iterate, so a future surface cannot be
added to the docs without being added to the guard:

```js
const userDocs = [
  ['README.md', readme],
  ['docs/usage.md', usage],
  ['docs/publishing.md', publishing],
];
```

- [ ] **Step 2: Extend both assertions to every surface**

Replace the single-surface `doesNotMatch` calls at lines 128 and 132 with loops that name the
offending file when they fail:

```js
for (const [label, text] of userDocs) {
  assert.doesNotMatch(text, oldClaim, `${label} must not repeat the superseded claim`);
}
```

and likewise for `/\bMode [AB]\b/`. Keep the existing `skill` assertions exactly as they are —
they are not being replaced, only joined. Keep the existing `historicalLines[0]` assertion at
line 136 unchanged; the design-spec cross-reference is still allowed to mention the mode
letters.

- [ ] **Step 3: Run to verify the suite is still green**

Run: `node --test test/planner-docs.test.js`
Expected: PASS. The new coverage should not fail today, because the current README and
`docs/publishing.md` are clean. That is the point: the assertions are being restored, not
used to fix an existing violation.

- [ ] **Step 4: Mutation pin — README**

Temporarily insert the line `Mode A is the old name.` into `README.md`. Run
`node --test test/planner-docs.test.js` and confirm the mode-letter assertion fails and that
its message names `README.md`. Record the failing count. Remove the line, rerun, record the
green count.

- [ ] **Step 5: Mutation pin — publishing**

Repeat with `docs/publishing.md`, inserting a line matching the superseded corruption claim
that `oldClaim` describes. Confirm the corruption assertion fails and names
`docs/publishing.md`. Record both counts.

Both pins are required. A single pin would leave the other surface unproven, which is the
exact failure being corrected here.

- [ ] **Step 6: Commit**

```bash
git add test/planner-docs.test.js
git commit -m "restore README and publishing coverage to the planner-doc invariants"
```

---

### Task 2: Correct a wrong character count in the blocklist documentation

`docs/publishing.md:31` gives an incorrect hard-coded length for the `CON|Contoso`
literal. Its actual length is 11. The substantive warning is correct and must stay; only the
number is wrong, and a hard-coded count adds nothing while being easy to get wrong.

**Files:**
- Modify: `docs/publishing.md` (the regex-warning paragraph)
- Modify: `docs/superpowers/plans/2026-08-20-uroboros-readme-restructure.md` (the same wording
  in Task 3, Step 2, so the historical plan does not preserve the error)

- [ ] **Step 1: Verify the real length**

```bash
node -e "console.log('CON|Contoso'.length)"
```

Expected: `11`.

- [ ] **Step 2: Remove the count rather than correcting it**

Rewrite the sentence so it carries no number:

```
A regex entry such as CON|Contoso is searched as one literal string. It matches nothing,
and doctor still reports the blocklist as present.
```

Make the same edit in the plan file so both read identically. Change nothing else in either
paragraph — the over-match guidance, the `Contoso` recommendation, and the five-character
minimum all stay as written.

- [ ] **Step 3: Run the full suite**

Run: `node --test`
Expected: PASS, at least 427 tests, 0 failures, true exit code 0.

- [ ] **Step 4: Confirm no count survives**

```bash
grep -rn "eleven[-]character\|fifteen[-]character\|14[-]character" docs/
```

Expected: no matches, true exit code 1. Check the exit code directly, not through a pipe.

- [ ] **Step 5: Commit**

```bash
git add docs/publishing.md docs/superpowers/plans/2026-08-20-uroboros-readme-restructure.md
git commit -m "drop the incorrect character count from the blocklist regex warning"
```

---

## Invariants

- `node --test` exits 0 with at least 427 tests and 0 failures.
- No file under `src/` or `bin/` is modified.
- `test/rename.test.js` structural pins still pass, including the three drift assertions
  added in the previous round.
- The mode-letter and corruption-claim invariants apply to the skill, `README.md`,
  `docs/usage.md`, and `docs/publishing.md`.
- No shipped file contains the superseded project name.
- `package.json` `dependencies` stays `{}`.

## Out of scope

- Any change to publish-guard, gate, verifier, or campaign logic.
- README structure, section order, and the pinned Install and contributor blocks.
- The placement of status and dashboard prose under `docs/publishing.md`. The reviewer noted
  it sits oddly there, but it arrived by a faithful move of the original section and
  relocating it is a separate editorial decision.
- The remaining internal sentinels and the pull-request comment marker.
