# Uroboros — User-Visible Display Strings

> **Execution:** This plan is the `--task` input to `node bin/loop.js run`. Codex implements
> it in an isolated worktree; the gate is `node --test`; Cursor reviews.

**Goal:** Bring the two remaining user-visible display strings in line with the project name.
Everything else renamed; these two still print the superseded prefix on every invocation.

**Architecture:** Two string literals and their assertions. No logic changes.

**Tech Stack:** Node 24, ESM, zero runtime dependencies, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-20-uroboros-rename-and-readme-restructure-design.md`

## Global Constraints

- Node `>=24`. ESM only. `package.json` `dependencies` must stay `{}`.
- The suite passes **427 tests, 0 failures**, true exit code 0. The count may rise but must
  not fall.
- **No shipped file may contain the superseded project name.** `test/rename.test.js` builds
  it at runtime as `['c', 'cube', 'loop'].join('-')` and scans for it.
- Change only the two literals named below and whatever assertions or golden files cover
  them. No control flow, no event schema fields, no timestamps.

---

### Task 1: The doctor banner

`src/doctor.js:40` opens its report with the literal `'ccc doctor'`, so every `doctor` run
prints a name the project no longer uses. `test/golden/doctor-all-fail.txt` contains the
rendered report and pins this line, so the golden file must change in the same commit.

**Files:**
- Modify: `src/doctor.js:40`
- Modify: `test/golden/doctor-all-fail.txt`

- [ ] **Step 1: Find every assertion covering the banner**

```bash
grep -rn "ccc doctor" src/ test/
```

Record the full list before editing. There is at least the source line and the golden file;
treat any additional hit as also in scope.

- [ ] **Step 2: Change the literal**

```js
const lines = ['uroboros doctor', '', 'Required checks:'];
```

- [ ] **Step 3: Run to observe the golden mismatch**

Run: `node --test test/doctor-checks.test.js`
Expected: FAIL — the rendered report no longer matches the golden file. This failure is the
proof that the golden file genuinely pins the banner; record the failing count.

- [ ] **Step 4: Update the golden file**

Change only the first line of `test/golden/doctor-all-fail.txt` to `uroboros doctor`. Leave
every other line byte-for-byte identical — the remaining lines pin check names, remediation
text, and ordering, none of which change here.

- [ ] **Step 5: Run to verify**

Run: `node --test test/doctor-checks.test.js`
Expected: PASS. Record the green count. Steps 3 and 5 together are the mutation pin.

- [ ] **Step 6: Commit**

```bash
git add src/doctor.js test/golden/doctor-all-fail.txt
git commit -m "print the project name in the doctor banner"
```

---

### Task 2: The event log prefix

`src/events.js:394` builds every human-readable log line with the prefix `[ccc]`. This is the
prefix on every line the CLI streams during a run.

**Files:**
- Modify: `src/events.js:394`
- Modify: `test/events.test.js` (whichever assertions cover the prefix)

- [ ] **Step 1: Find every assertion covering the prefix**

```bash
grep -rn "\[ccc\]" src/ test/ fixtures/
```

Record the full list. Any test asserting a formatted line will contain the prefix.

- [ ] **Step 2: Write or retarget the assertion first**

If a test already pins the prefix, change its expectation to `[uroboros]`. If none does, add
one, so the prefix is guarded rather than free to drift again:

```js
test('a formatted event line carries the project prefix', () => {
  const line = formatEventLine({ ts: '2026-08-20T00:00:00.000Z', stage: 'gate', type: 'start' });
  assert.match(line, /^\[uroboros\] /);
  assert.doesNotMatch(line, /^\[ccc\]/);
});
```

Use the real exported formatter name from `src/events.js` rather than inventing one.

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/events.test.js`
Expected: FAIL — the line still begins `[ccc]`. Record the failing count.

- [ ] **Step 4: Change the literal**

```js
const prefix = `[uroboros] ${oneLine(event?.ts)} ${oneLine(event?.stage)}/${oneLine(event?.type)}`;
```

Change nothing else in that template — the timestamp, stage, and type interpolations and
their `oneLine` calls stay exactly as they are.

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/events.test.js`
Expected: PASS. Record the green count.

- [ ] **Step 6: Confirm no display prefix survives**

```bash
grep -rn "\[ccc\]" src/ bin/ test/ fixtures/
```

Expected: no matches, true exit code 1. Check the exit code directly, not through a pipe.

- [ ] **Step 7: Commit**

```bash
git add src/events.js test/events.test.js
git commit -m "print the project name in the event log prefix"
```

---

## Invariants

- `node --test` exits 0 with at least 427 tests and 0 failures.
- No event schema field, stage name, or type name changes. Only the human-readable prefix.
- `events.jsonl` records stay structurally identical; the prefix belongs to the formatted
  console line, not the NDJSON payload.
- No shipped file contains the superseded project name.
- `package.json` `dependencies` stays `{}`.

## Out of scope

- Internal sentinels that never reach a user: `uro-test-count-floor` and any remaining
  `ccc-base`, `ccc-setup`, `ccc-doctor-*`, `ccc-publish-prose-` temp and branch names.
- `github-publisher.js` pull-request comment marker, deliberately preserved as an idempotency
  key for comments on already-open pull requests.
- Any change to publish-guard, gate, verifier, or campaign logic.
