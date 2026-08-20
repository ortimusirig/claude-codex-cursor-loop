# README Restructure and Publish-Guard Documentation (Unit 2)

> **Execution:** This plan is the `--task` input to `node bin/loop.js run`. Codex implements
> it in an isolated worktree; the gate is `node --test`; Cursor reviews.

**Goal:** Cut `README.md` from 518 lines to a landing page of roughly 170, move the reference
material into two files under `docs/`, and correct the publish-guard documentation, which
still describes a three-tool model that the shipped guard outgrew.

**Architecture:** The drift guard is written first so it specifies the target structure, then
the restructure satisfies it. Reference content splits into `docs/usage.md` for the
operational surface and `docs/publishing.md` for publishing and the confidentiality guard —
separate because the guard is the page a user reaches when a publish is refused, and burying
it mid-reference works against the one moment it is needed.

**Tech Stack:** Node 24, ESM, zero runtime dependencies, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-20-uroboros-rename-and-readme-restructure-design.md`

## Global Constraints

- Node `>=24`. ESM only. `package.json` `dependencies` must stay `{}`.
- The suite passes **424 tests, 0 failures**, true exit code 0. The count may rise but must
  not fall.
- **No shipped file may contain the superseded project name.** `test/rename.test.js` builds
  it at runtime as `['c', 'cube', 'loop'].join('-')` and scans for it. Refer to it
  indirectly if prose must mention it.
- `test/rename.test.js` already pins README structure and those pins must keep passing:
  `## Install` is the first `## ` section; the first fenced block is exactly ` ```text ` with
  the two marketplace lines; `## Contributor/development setup` follows it and retains its
  six-line `sh` block.
- No behavior changes. This unit touches documentation and tests only. No file under `src/`
  or `bin/` changes.

---

### Task 1: Extend the drift guard to cover the split

Moving reference content into `docs/` creates a drift vector the current assertions do not
cover: a README link that rots, or a documented command that stops matching the parser.

**Files:**
- Modify: `test/rename.test.js` (add three tests; leave existing ones untouched)

**Interfaces:**
- Consumes: `CLI_COMMANDS` from `src/cli-help.js` and `parseArgs` from `src/args.js`, both
  already imported by this file.

- [ ] **Step 1: Write the failing tests**

```js
test('the reference documentation files exist and are substantial', () => {
  for (const relative of ['docs/usage.md', 'docs/publishing.md']) {
    const path = fileURLToPath(new URL(`../${relative}`, import.meta.url));
    assert.ok(existsSync(path), `${relative} must exist`);
    assert.ok(readFileSync(path, 'utf8').trim().length > 500,
      `${relative} must hold real reference content, not a stub`);
  }
});

test('every relative link in README resolves to a file that exists', () => {
  const readme = readFileSync(readmePath, 'utf8');
  const targets = [...readme.matchAll(/]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((href) => !/^(https?:|#|mailto:)/.test(href))
    .map((href) => href.split('#')[0])
    .filter((href) => href !== '');
  assert.ok(targets.length > 0,
    'positive control: README must link to at least one local file');
  for (const target of targets) {
    const path = fileURLToPath(new URL(`../${target}`, import.meta.url));
    assert.ok(existsSync(path), `README links to a missing file: ${target}`);
  }
});

test('commands documented in docs/usage.md are accepted by the real parser', () => {
  const usagePath = fileURLToPath(new URL('../docs/usage.md', import.meta.url));
  const usage = readFileSync(usagePath, 'utf8');
  const documented = [...usage.matchAll(/^\s*node bin\/loop\.js ([a-z]+)/gm)]
    .map((match) => match[1]);
  assert.ok(documented.length > 0,
    'positive control: docs/usage.md must document at least one command invocation');
  for (const command of new Set(documented)) {
    assert.ok(CLI_COMMANDS.includes(command),
      `${command} is documented but absent from the real command list`);
    assert.equal(parseArgs([command]).command, command,
      `${command} is documented but not accepted by the parser`);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/rename.test.js`
Expected: FAIL — `docs/usage.md` and `docs/publishing.md` do not exist yet.

- [ ] **Step 3: Do not implement yet**

These three tests stay red until Task 2 creates the files. Do not stub the files to make
them pass; that is what Task 2 delivers.

---

### Task 2: Split the reference content out of README

**Files:**
- Create: `docs/usage.md`
- Create: `docs/publishing.md`
- Modify: `README.md` (518 lines down to roughly 170)

**Interfaces:**
- Consumes: the three assertions from Task 1.

- [ ] **Step 1: Create `docs/usage.md`**

Move these README sections verbatim, adjusting only headings and internal cross-references:

- `## Usage` body (currently lines 131-254) — the full command surface and every flag
- `### Outcomes and exit codes` (lines 255-272)
- `### Iterating` (lines 383-387)
- `### Optional flat event view with Logdy` (lines 388-412)
- `### Offline Obsidian run journal` (lines 413-435)
- `## Configuration` (lines 447-472)

Promote the `###` headings to `##` so the new file reads as a document rather than a
fragment. Keep every `node bin/loop.js <command>` invocation exactly as written — Task 1
asserts each one parses.

- [ ] **Step 2: Create `docs/publishing.md`**

Move `### Optional GitHub publishing` (lines 273-382) and promote its heading. Correct the
guard description as specified in Task 3; for this step, move the content as-is so the
restructure and the correction stay reviewable apart.

- [ ] **Step 3: Slim README to the landing page**

Keep exactly these sections, in this order:

    badges and one-line description
    ## Install
    ## First run
    ## What you need
    ## How the loop works
    ## Why this shape
    ## Usage
    ## Smoke test
    ## Known gotchas
    ## Contributor/development setup
    ## License

`## Usage` shrinks to one minimal `run` example plus links:

```markdown
For the full command surface, every flag, campaign shapes, outcomes, and configuration, see
[docs/usage.md](docs/usage.md). For GitHub publishing and the confidentiality guard, see
[docs/publishing.md](docs/publishing.md).
```

Do not alter `## Install`, its fenced block, or the `## Contributor/development setup`
block beyond Step 4 — `test/rename.test.js` pins all three exactly.

- [ ] **Step 4: Rename the demo directory in the contributor block**

The contributor block still names a demo directory carrying the superseded prefix. Change
the last three lines of that `sh` block and the matching `assert.deepEqual` in
`test/rename.test.js` together, so the documented path and the assertion stay in lockstep:

```
node bin/loop.js init ../uroboros-demo
node bin/loop.js run --task ../uroboros-demo/plan.md --target ../uroboros-demo --gate ../uroboros-demo/gate.json
```

The `loopArgv` derivation below that assertion slices tokens positionally, so the command
names it extracts must remain `doctor`, `init`, `run`.

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS, at least 427 tests, 0 failures, true exit code 0. The three Task 1 tests now
pass.

- [ ] **Step 6: Confirm the README actually shrank**

```bash
wc -l README.md
```

Expected: roughly 170 lines, and certainly under 220. If it is still over 220, reference
content remains that belongs in `docs/`.

---

### Task 3: Correct the publish-guard documentation

The current text names three prerequisites and says `doctor` reports "all three." The shipped
guard runs four layers, and one of them is undocumented.

**Files:**
- Modify: `docs/publishing.md`

- [ ] **Step 1: Replace the prerequisite description with the four layers**

All four run before any network call: `github-publisher.js:468` runs the guard, line 487
throws on any finding, and the first `gh` invocation is line 493.

| Layer | Mechanism | Prose | Code | Blocking |
|---|---|---|---|---|
| blocklist | your file, literal substring | yes | yes | yes |
| gitleaks | pattern scanner | yes | yes | yes |
| trufflehog | pattern scanner | yes | yes | advisory |
| contextual review | Cursor `CLEAN`/`CONFIDENTIAL` verdict | yes | no | yes |

State explicitly that the contextual review is blocking, that a failure to launch it refuses
the publish, and that Cursor is therefore a hard publish dependency.

- [ ] **Step 2: Document the blocklist file format**

The file is newline-delimited plain text. `#` begins a comment. Matching is **case-insensitive
literal substring — not regex** (`publish-guard.js:62` calls `haystack.includes(term)` with
both sides lowercased).

Include this warning explicitly, because a regex entry is the failure mode that looks like it
works:

    A regex entry such as CON|Contoso is searched as one literal string. It matches nothing,
    and doctor still reports the blocklist as present.

- [ ] **Step 3: Document the over-match hazard and the prose-only limit**

Short terms over-match: `CON` matches "config", "console", and "control", so almost any
repository blocks every publish. The failure is safe — it refuses rather than leaks — but a
control that blocks constantly invites being switched off. Recommend `Contoso` over the short
form, and terms of five characters or more.

Also state that the contextual review reads prose only, so a client identifier appearing in
the code surface is caught by the blocklist alone.

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS, 0 failures, true exit code 0.

- [ ] **Step 5: Verify the corrected claims against the source**

```bash
grep -n "includes(term" src/publish-guard.js
grep -n "const guard = adapters.guardPublish" src/github-publisher.js
```

Both must still match what the documentation asserts. If the source has moved, correct the
documentation rather than the source — this unit changes no code.

---

## Invariants

- `node --test` exits 0 with at least 424 tests and 0 failures.
- No file under `src/` or `bin/` is modified by this unit.
- `test/rename.test.js` structural pins still pass: Install is the first section, the first
  fenced block holds exactly the two marketplace commands, and the contributor block keeps
  its six lines.
- Every relative link in README resolves.
- No shipped file contains the superseded project name.
- `package.json` `dependencies` stays `{}`.

## Out of scope

- Any change to publish-guard, gate, verifier, or campaign logic. The guard implementation is
  correct; only its description is stale.
- The remaining internal `ccc-` sentinels and the `ccc-verifier-review` pull-request comment
  marker, which is deliberately preserved as an idempotency key.
- Blocklist management tooling.
- Renaming the GitHub repository or reinstalling plugins.
