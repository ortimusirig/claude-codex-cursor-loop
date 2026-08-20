# Uroboros Rename and README Restructure — Design

**Date:** 2026-08-20
**Status:** awaiting review
**Change:** adopt `uroboros` as the repository and plugin name

## Goal

Rename the project to **uroboros**, and reduce `README.md` from 518 lines to a landing page
by moving reference material into `docs/`. Document the publish confidentiality guard, whose
implementation shipped on 2026-08-19 but whose user-facing documentation still describes a
superseded three-tool model.

## Units

Two units, run sequentially with a full planner review between them. They are deliberately
not a Graph campaign: a Graph releases the child as soon as the parent exits zero, which
would remove the planner review that the governing law makes the last gate before integrate.

- **Unit 1 — rename.** Mechanical, test-guarded, touches published surfaces.
- **Unit 2 — README restructure and guard documentation.** Editorial, repo-internal.
  Absorbs the publish-guard documentation fix, which would otherwise be a third unit
  writing content into a structure Unit 2 immediately replaces.

Unit 1 runs first. Running Unit 2 first would mean authoring roughly 180 lines of new README
plus two new documentation files entirely under the name being abandoned, then renaming them.

## Unit 1 — rename

### Tier 1: repository identifiers (18 files, 76 occurrences)

Use `uroboros` in:

    .claude-plugin/marketplace.json      .claude-plugin/plugin.json
    package.json                          install.mjs
    README.md                             PORTING.md
    commands/batch.md                     commands/run.md
    test/planner-docs.test.js             test/plugin-packaging.test.js
    test/rename.test.js
    docs/superpowers/plans/2026-08-19-executor-execution-record.md
    docs/superpowers/plans/2026-08-19-publish-confidentiality-guard.md
    docs/superpowers/specs/2026-08-15-run-observability-and-obsidian-docs-design.md
    docs/superpowers/specs/2026-08-15-stall-supervision-design.md
    docs/superpowers/specs/2026-08-15-v3-orchestrated-campaigns-design.md

Two directory renames:

    governing skill directory           ->  skills/uroboros/
    cursor-plugin/skills/ccc-verify/    ->  cursor-plugin/skills/uro-verify/

The slash-command namespace becomes `/uroboros:run`, `/uroboros:batch`, and so on for all
nine commands in `commands/`.

### Tier 2: runtime identifiers

All environment variables change prefix from `CCC_` to `URO_`, keeping the remainder of each
name unchanged: `CCC_PUBLISH_BLOCKLIST` becomes `URO_PUBLISH_BLOCKLIST`, `CCC_SCRATCH_ROOT`
becomes `URO_SCRATCH_ROOT`, and so on for all 23. The 23 then split by whether a user ever
sets them, which decides only whether the old name survives as an alias.

**User-facing (9) — rename, and accept the old `CCC_` name as a deprecated alias** that
emits a one-line warning naming the replacement:

    CCC_SCRATCH_ROOT           CCC_PUBLISH_BLOCKLIST      CCC_NO_DASHBOARD
    CCC_EXECUTOR_TIMEOUT_MS    CCC_GATE_TIMEOUT_MS        CCC_VERIFIER_TIMEOUT_MS
    CCC_STALL_POLICY           CCC_STALL_RESTARTS         CCC_STALL_THRESHOLD_MS

**Internal and test-only (14) — rename outright, no alias.** These appear in no
documentation and are set only by the suite and its fixtures:

    CCC_CODEX_SANDBOX      CCC_DASHBOARD_MARKER   CCC_DOCTOR_READ_
    CCC_DOCTOR_WRITE_OK    CCC_GH_BIN             CCC_OBSERVED_TEST_COUNT
    CCC_TEST_SCRATCH_ROOT  CCC_FAKE_AGENT_SIGNED_IN
    CCC_FAKE_CODEX_SIGNED_IN                      CCC_FAKE_DOCTOR_INVOCATIONS
    CCC_FAKE_GH_AUTH       CCC_FAKE_GH_FAIL       CCC_FAKE_GH_STATE
    CCC_FAKE_GITHUB_REMOTE

The alias exists because `CCC_PUBLISH_BLOCKLIST` and `CCC_SCRATCH_ROOT` live in the
operator's shell profile. Renaming them with no alias silently disarms the publish guard:
`doctor` would report the blocklist missing and `publish` would refuse, with nothing
connecting either symptom back to the rename.

**Artifact filenames — write the new name, read either.** Four files are read back by
`publish` and `status`:

    ccc-runfacts.json           ->  uro-runfacts.json
    ccc-report.md               ->  uro-report.md
    ccc-github.json             ->  uro-github.json
    ccc-merge-resolutions.json  ->  uro-merge-resolutions.json

Readers must fall back to the `ccc-` name when the `uro-` name is absent. Without this,
every completed run directory on disk becomes unpublishable, because `readCompletedRun`
would not find its run facts.

**Forward-only, no compatibility needed:**

- Branch prefix `ccc/` becomes `uro/`. The roughly 45 existing `ccc/*` branches keep their
  names and remain valid; nothing resolves a branch by prefix.
- Default scratch root `C:\ccc\w` becomes `C:\uro\w`. Existing worktrees stay where they are
  and remain reachable by absolute path.

**Unchanged:** `bin/loop.js` keeps its filename and the `loop` bin alias. It is the loop;
`node bin/loop.js run` still reads correctly, and renaming it would churn every documented
command line for no gain in clarity.

### Tier 3: external steps, performed by the operator

These are outward-facing and are not part of any loop run:

1. Rename the GitHub repository to `ortimusirig/uroboros`.
2. Reinstall the plugin under the new name and remove the old cache directory.

GitHub redirects the old repository URL, but the marketplace reference should be re-pointed
to `/plugin marketplace add ortimusirig/uroboros` rather than left to rely on a redirect.

`install.mjs` already warns about a superseded install without deleting it — machinery built
for the previous rename. Re-point that warning to the immediately superseded project name.

### The self-referential test constraint

`test/rename.test.js` scans every shipped `.js`, `.mjs`, `.json`, `.jsonl`, `.md`, `.ps1`,
and `.cmd` file and asserts the superseded name appears nowhere. It avoids tripping its own
scan by assembling the old name at runtime:

    const previousName = ['claude', 'codex', 'cursor', 'loop'].join('-');

After the rename this must become `['c', 'cube', 'loop'].join('-')`, and `currentName`
becomes the literal `'uroboros'`. A naive find-and-replace produces a file that fails its
own assertion in a confusing, self-referential way.

The same file also pins README structure: `## Install` must be the first section, the first
fenced block must be exactly the two marketplace commands, and the contributor block must be
six exact lines. Both units rewrite these assertions.

## Unit 2 — README restructure and guard documentation

### Target structure

`README.md` drops from 518 lines to roughly 170 and keeps only what orients a new reader:

    badges and one-line description
    ## Install                      (marketplace commands; must remain the first section)
    ## First run
    ## What you need
    ## How the loop works           (the pipeline diagram)
    ## Why this shape               (the three-seats argument)
    ## Usage                        (one minimal run example, then links out)
    ## Smoke test
    ## Known gotchas
    ## Contributor/development setup
    ## License

Two new files absorb the reference material:

- **`docs/usage.md`** — the full command surface, every flag, campaign shapes, outcomes and
  exit codes, iterating, configuration, Logdy, and the Obsidian run journal.
- **`docs/publishing.md`** — GitHub publishing and the confidentiality guard.

`docs/publishing.md` is separate rather than a section of `docs/usage.md` because the guard
content is already 110 standalone lines, and because it is the page a user reaches when a
publish is refused. Burying the confidentiality surface mid-reference works against the one
moment it is needed.

### Guard documentation content

The current README describes three prerequisites and states that `doctor` reports "all
three." The guard actually runs four layers, all before any network call:
`github-publisher.js:468` runs the guard, line 487 throws on any finding, and the first `gh`
invocation is line 493.

| Layer | Mechanism | Prose | Code | Blocking |
|---|---|---|---|---|
| blocklist | user file, literal substring | yes | yes | yes |
| gitleaks | pattern scanner | yes | yes | yes |
| trufflehog | pattern scanner | yes | yes | advisory |
| contextual review | Cursor `CLEAN`/`CONFIDENTIAL` verdict | yes | no | yes |

`docs/publishing.md` must state:

1. All four layers, marking the Cursor contextual review as blocking, and noting that a
   failure to launch it refuses the publish. Cursor is therefore a hard publish dependency,
   which no current documentation says.
2. The blocklist file format: one term per line, `#` begins a comment, and matching is
   **case-insensitive literal substring — not regex**. A regex entry such as
   `CON|Contoso` is searched as one literal string, matches nothing, and still
   satisfies `doctor`.
3. That short terms over-match: `CON` matches "config", "console", and "control". Prefer
   `Contoso`. The failure is safe — it refuses rather than leaks — but a control that blocks
   constantly invites being switched off.
4. That the contextual review reads prose only, so a client identifier in the code surface
   is caught by the blocklist alone.

Point 2 is the reason this documentation matters: the project author, reading the current
README, assumed the matching was regex.

### Extending the drift guard

`rename.test.js` currently prevents documentation drift by checking README's install
commands against the real `CLI_COMMANDS` list and parser. Moving content into `docs/`
creates a drift vector those assertions do not cover. The restructure must add assertions
that:

- `docs/usage.md` and `docs/publishing.md` exist and are non-empty.
- Every relative link in `README.md` resolves to a file that exists.
- Commands documented in `docs/usage.md` appear in `CLI_COMMANDS` and are accepted by
  `parseArgs`, matching the existing README assertion.

Each new assertion needs a mutation pin: break the thing it watches, observe that specific
assertion fail, restore, observe green.

## Invariants

- The test suite passes with a true exit code of zero. 413 tests pass today; the count may
  rise but must not fall.
- No behavior changes. Both units are naming and documentation only. Nothing changes in gate
  semantics, verifier handling, campaign scheduling, or guard logic.
- A completed run created before the rename remains publishable.
- No shipped file contains the superseded name, enforced by the existing scan.
- The publish guard stays fail-closed: a missing or unusable blocking prerequisite refuses
  the publish rather than skipping the check.

## Out of scope

- Any change to publish-guard logic. Documentation only; the implementation is correct.
- Blocklist management tooling — a `blocklist` subcommand or a dashboard editor. Discussed
  and deferred.
- The dashboard stays read-only: GET on `/`, `/events`, and `/detail`.
- Renaming `bin/loop.js`.
- Renaming the working directory or the existing `ccc/*` branches.
- The queued `email-draft` and `generate-sow` skills.

## Tier 2 decision

Settled: rename all runtime identifiers, alias the nine documented environment variables,
and read both artifact filename prefixes.

A Tier 1-only cosmetic rename was rejected — it would leave `CCC_*` in the codebase
permanently, and this repository already demonstrates where that ends: the working directory
still carries `claude-codex-cursor-loop`, the name from two renames ago.

A hard cut with no compatibility was rejected on two specific breakages, not on general
caution. `CCC_PUBLISH_BLOCKLIST` and `CCC_SCRATCH_ROOT` live in the operator's shell profile,
so a hard cut silently disarms the publish guard, and the resulting symptom — `doctor`
reporting a missing blocklist — points nowhere near the rename. Separately, dropping the
`ccc-` artifact read would orphan every completed run on disk, because `readCompletedRun`
locates a run by its run-facts filename.

The compatibility surface is deliberately narrow. Only nine of the 23 environment variables
keep an alias; the other 14 are set exclusively by the suite and its fixtures. Branch prefix
and scratch root get no compatibility at all, because nothing resolves a branch by prefix and
worktrees are reached by absolute path.
