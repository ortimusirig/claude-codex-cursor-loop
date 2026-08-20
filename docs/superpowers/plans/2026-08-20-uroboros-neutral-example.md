# Replace the Blocklist Example With a Fictional Company

> **Execution:** This plan is the `--task` input to `node bin/loop.js run`. Codex implements
> it in an isolated worktree; the gate is `node --test`; Cursor reviews.

**Goal:** Replace the worked example in the blocklist documentation with an unambiguously
fictional company. The current example uses a real energy company as the stand-in for "a
confidential client identifier you would blocklist," in a public MIT-licensed repository.
Publishing that implies an association the blocklist exists to prevent.

**Architecture:** A documentation-only substitution across four files. The substantive
guidance — literal substring matching, the over-match hazard, the five-character minimum — is
correct and must survive unchanged. Only the example company changes.

**Tech Stack:** Node 24, ESM, zero runtime dependencies, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-20-uroboros-rename-and-readme-restructure-design.md`

## Global Constraints

- Node `>=24`. ESM only. `package.json` `dependencies` must stay `{}`.
- The suite passes **427 tests, 0 failures**, true exit code 0. The count may rise but must
  not fall.
- **No shipped file may contain the superseded project name.** `test/rename.test.js` builds
  it at runtime as `['c', 'cube', 'loop'].join('-')` and scans for it.
- No file under `src/` or `bin/` may change. This is a documentation substitution.
- Do not weaken or shorten any of the substantive blocklist guidance.

---

### Task 1: Substitute the example company

Use **Contoso** as the fictional company and **CON** as its short form. Contoso is the
industry-standard fictional company name, and `CON` genuinely over-matches in real source
code — `config`, `console`, `control`, `concat` — so it demonstrates the substring hazard at
least as well as the current example, with no real-world association.

**Files (10 occurrences total):**
- Modify: `docs/publishing.md` (3)
- Modify: `docs/superpowers/plans/2026-08-20-uroboros-readme-correction-1.md` (4)
- Modify: `docs/superpowers/plans/2026-08-20-uroboros-readme-restructure.md` (3)
- Modify: `docs/superpowers/specs/2026-08-20-uroboros-rename-and-readme-restructure-design.md` (2)

- [ ] **Step 1: Enumerate every occurrence before editing**

```bash
legacy_pattern="$(printf '%s%s|%s%s|\\b%s%s\\b' 'occi' 'dental' 'de' 'lek' 'O' 'XY')"
grep -rn -i -E "$legacy_pattern" --include=*.md .
```

Record the full list. Ten matches across four files are expected. Treat any additional hit,
in any file type, as also in scope.

- [ ] **Step 2: Apply the substitution**

The regex-warning sentence becomes:

```
A regex entry such as CON|Contoso is searched as one literal string. It matches nothing,
and doctor still reports the blocklist as present.
```

The over-match sentence becomes:

```
Short terms can over-match: CON matches "config", "console", and "control", so almost any
repository blocks every publish. The failure is safe -- it refuses rather than leaks -- but a
control that blocks constantly invites being switched off. Prefer Contoso over the short form,
and terms of five characters or more.
```

Apply the same substitution in the three planning and spec documents, preserving each
document's surrounding wording and formatting. Where a document quotes the sentence as a
requirement, the quoted sentence must match the text actually shipped in
`docs/publishing.md`.

- [ ] **Step 3: Verify the over-match claim is true**

The documentation asserts that `CON` matches `config`, `console`, and `control` under the
guard's own matching rule. Confirm rather than assume:

```bash
node -e "const t='con'; for (const w of ['config','console','control','concat']) console.log(w, w.toLocaleLowerCase('en-US').includes(t));"
```

Expected: `true` for all four. If any is false, correct the documentation to name only words
that genuinely match — an illustration that does not hold is worse than none.

- [ ] **Step 4: Confirm no client identifier survives**

```bash
legacy_pattern="$(printf '%s%s|%s%s|\\b%s%s\\b' 'occi' 'dental' 'de' 'lek' 'O' 'XY')"
grep -rn -i -E "$legacy_pattern" .
```

Expected: no matches, true exit code 1. Check the exit code directly, not through a pipe.
Untracked harness artifacts such as `TASK.md` and the run report are excluded from this
requirement, because this plan itself quotes the names being removed and those files are not
part of the repository.

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS, at least 427 tests, 0 failures, true exit code 0.

- [ ] **Step 6: Commit**

```bash
git add docs
git commit -m "use a fictional company in the blocklist documentation example"
```

---

## Invariants

- `node --test` exits 0 with at least 427 tests and 0 failures.
- No file under `src/` or `bin/` is modified.
- Every substantive blocklist claim survives: literal case-insensitive substring rather than
  regex, `#` comments, one term per line, the over-match hazard, the five-character minimum,
  and the fact that the contextual review reads prose only.
- The four-layer guard table in `docs/publishing.md` is unchanged.
- No shipped file contains the superseded project name.
- `package.json` `dependencies` stays `{}`.

## Out of scope

- Any change to publish-guard, gate, verifier, or campaign logic.
- README structure and the pinned Install and contributor blocks.
- The internal sentinels and the pull-request comment marker.
