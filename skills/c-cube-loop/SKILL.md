---
name: c-cube-loop
description: Plan and supervise isolated Codex implementation, true-exit-code gates, Cursor review, and Single, Parallel, Graph, Candidates, or Rounds campaigns; use for campaign execution, diagnostics with doctor, status or dashboard inspection, project initialization, and publishing completed units.
---

# c-cube-loop

## Governing law

This is skill law for the planner seat on every invocation, every wave, and every fix. It is
not per-run content: never restate it in `TASK.md`, and no plan can waive it. A plan that appears
to authorize skipping or combining a step is itself the defect.

1. **Build** — Codex writes in isolation. The planner never implements.
2. **Gate verification** — Confirm the true exit code of every gate command. Stdout text is not
   status. Never accept a piped exit code: a pipe reports the last command's exit code rather
   than the gate's.
3. **Adversarial review** — Cursor performs the full hunt list: correctness, regressions,
   security, edge cases, test adequacy, and violations of intent, scope, or invariants.
4. **Correction loop** — The planner authors *finding → fix design → mutation pin*; Codex
   implements; repeat. A mutation pin proves that a new test could have failed: inject the
   defect, observe the specific assertion fail, restore the implementation, observe green, and
   record both the failing and green counts.
5. **Scoped re-verify** — Cursor re-checks the correction and must return `CLEAN`.
6. **Final planner review** — This is the last gate: read the full diff, check the contract
   against every invariant stated in the plan, and hands-on spot-verify the riskiest seams. Two
   clean Cursor passes are not sufficient to merge.
7. **Issues → back to step 4** — The planner's hands only ever plan, verify, and nudge typos or
   filenames. Never fix.
8. **Integrate** — Integrate, deploy, browser-verify on production, and record the result.

Monitor continuously and intervene only when a run is stuck: **stalled** means no events beyond
the stall threshold; **circling** means events still arrive but the same files are rewritten with
no gate progress. Slow is not stuck.

## Planner briefing

### Campaign shapes

Choose on one axis: **how do these plans relate to each other?**

| Name | Chosen when | Command | Engine shape |
|---|---|---|---|
| **Single** | one plan | `run` | — |
| **Parallel** | plans are unrelated; keep all | `batch` | `task-set` |
| **Graph** | one plan consumes another's result | `batch --depends-on` | `task-set` with parents |
| **Candidates** | competing approaches to one goal | `batch --perspective` | `candidate-set` |
| **Rounds** | candidates are refined over 2–3 rounds | `+ --rounds` | `iterative-candidate-set` |

The engine emits exactly `task-set`, `candidate-set`, and `iterative-candidate-set`. Dependency
edges do not create another `campaignShape`: Parallel and Graph both emit `task-set`, with Graph
also carrying parents.

Recognize one derived kind that the planner never chooses: **Merge**. Any unit with more than
one parent is auto-promoted to Merge and gains its own worktree and `TASK.md`, a derived
test-count floor, a required interaction test, and a conflict ledger.

### Declaring a Graph

Prefer a declared campaign file for Graph work because it keeps the topology, unit identities,
and campaign limits together:

    node bin/loop.js batch --campaign <campaign.json> [--port PORT] [--open] [--no-dashboard] [--quiet]

The file declares `target`, `gate`, optional campaign settings, and a `units` array whose entries
name `id`, `task`, and optional `dependsOn`. Paths resolve from the campaign file's directory.
For a simple Graph, keep the flag form: give every task a `--unit-id`, then repeat
`--depends-on CHILD=PARENT` for each edge.

### Engine behavior that changes planning

- **A subdirectory target does not narrow scope.** For a target inside a Git repository,
  isolation resolves through Git to the enclosing repository and creates a full-checkout
  worktree. Executor cwd, gate cwd, and `CHANGES.diff` are therefore repository-root scoped.
  Express the intended blast radius in the plan prose.
- **A leaf unit is not committed by the campaign.** A unit result is committed only when the
  unit has at least one declared child and exits zero. A leaf branch remains at its base commit;
  its changed work stays in the worktree, and for a successful changed leaf `CHANGES.diff` is
  the authoritative artifact.
- **One failed parent skips a fan-in immediately.** The fan-in child is marked skipped as soon
  as any parent fails; the scheduler does not wait for the other parents, which continue running.
- **`no-op` is scheduler success, not proof of work.** An empty diff skips both verifier passes,
  exits zero, releases dependents, and counts as a successful alternative. Positive evidence of
  implementation is a non-empty diff together with a passed gate.
- **Waiting costs no slot.** A waiting dependent does not hold a concurrency slot. The Graph
  topology, rather than `--concurrency`, is usually the real parallelism bound.
- **Only three commands are genuinely read-only:** `status`, `dashboard`, and `help`.
  `doctor --deep` launches the real Codex and Cursor binaries and spends tokens; `publish`
  pushes a branch and creates or updates a pull request. `doctor` also performs disposable
  scratch writes even without `--deep`.
- **Publishing is per unit, evidence-presence-gated, and parent-first for a Graph.** `publish`
  requires both verifier verdicts and their sources, but does not require clean verdicts or a
  successful outcome. Thus gate-failed, no-op, and executor/gate-timeout units lack a delivery
  path; a verifier-timeout unit can still qualify when both verifier records exist. A child pull
  request uses its parent's branch as its base, so publish the parent branch first.
- **The execution scratch root is environment-only and flat.** `run` and `batch` take it from
  `CCC_SCRATCH_ROOT` (or the platform default), not a run flag. Unit worktrees live under the
  unit id, so two campaigns that reuse a unit id collide even when they target different
  repositories.
- **Normal run artifacts persist.** There is no end-of-run or end-of-campaign cleanup for unit
  worktrees, branches, or event streams, regardless of outcome. Temporary detached test-count
  worktrees and the disposable doctor and publisher workspaces are cleaned.
- **Run/batch Git work has no deadline.** Explicit stage timeouts cover the executor, gate, and
  both verifiers; the isolation and campaign Git invocations pass no timeout. Standalone
  `doctor` probes and `publish` commands use their own bounded command timeouts.
- **Ordinary seats do not receive campaign context.** The executor and either verifier are not
  told about sibling units, the dependency Graph, or the campaign. A perspective value reaches
  no seat; its presence only infers a candidate set. Derived Merge is the exception: its
  generated `TASK.md` names ordered parents and merge requirements, but still does not describe
  the whole campaign.
- **Gate retry context is executor-only.** The failure detail is passed only through the next
  executor stdin; it is never written into `TASK.md`, so the intent verifier judges the pristine
  plan (or the generated Merge task), not retry instructions.

The repository lock around worktree administration is in-process only. That fact describes its
scope but proves nothing about cross-process safety. In the measured experiment, eight concurrent
`git worktree add` processes all succeeded and `git fsck` remained clean. `batch`
is preferred because it schedules, budgets, and records one campaign. The actual cross-process
hazard is reuse of a unit id in the flat scratch root.

## Invoking the commands

Install the plugin from a clone by running `node install.mjs`, then paste the two exact Claude
Code commands it prints: `/plugin marketplace add <absolute-clone-path>` followed by
`/plugin install c-cube-loop@c-cube-loop`. The plugin registers these eight namespaced slash
commands while the direct Node CLI remains available:

- `/c-cube-loop:run`
- `/c-cube-loop:batch`
- `/c-cube-loop:status`
- `/c-cube-loop:dashboard`
- `/c-cube-loop:publish`
- `/c-cube-loop:doctor`
- `/c-cube-loop:init`
- `/c-cube-loop:help`

Each slash command is a controller prompt that runs the corresponding `node bin/loop.js`
command. It is not a shell alias. The command controller must use the child process's true exit
code, never stdout text or the exit status of a pipe. The `run` and `batch` prompts explicitly
load this skill so invoking them cannot bypass the governing law.

The unchanged direct CLI surface is:

    node bin/loop.js run ...
    node bin/loop.js batch ...
    node bin/loop.js status ...
    node bin/loop.js dashboard ...
    node bin/loop.js publish ...
    node bin/loop.js doctor ...
    node bin/loop.js init ...
    node bin/loop.js help

For one plan:

    node bin/loop.js run --task <plan-file-or-prose> --target <folder> --gate <gate.json> [--gate-retries M] [--executor-model MODEL] [--executor-effort EFFORT] [--verifier-model MODEL] [--port PORT] [--open] [--no-dashboard] [--quiet]

For flag-declared Parallel, Candidates, Rounds, or a simple Graph:

    node bin/loop.js batch --task <plan-1> --task <plan-2> --target <folder> --gate <gate.json> [--concurrency N] [--token-budget TOKENS] [--rounds 1|2|3] [--round N ...] [--unit-kind candidate|node|merge] [--unit-id ID ...] [--perspective NAME ...] [--depends-on CHILD=PARENT ...] [--port PORT] [--open] [--no-dashboard] [--quiet]

Candidates share one base, reject dependencies, and retain each attributed result without
choosing a winner. Rounds use two or three caller-authored candidate sets, the same campaign
base, and one token budget. The engine does not call a planner model.

For a new project, `init` creates starter `plan.md` and `gate.json` files without overwriting
either. Use `doctor` for prerequisites and opt into real write/read probes with `doctor --deep`.
Use `status` or the read-only `dashboard` to observe a run, `publish` only after planner review,
and `help` to print the command surface.

- **Gate config** (`gate.json`): a JSON array of `{ "bin": "...", "args": ["..."] }`;
  pass/fail is by the command's true exit code only.
- Codex writes inside a Git-isolated copy; the source working tree is not touched.
- Cursor performs correctness and intent/assertion verification in read-only plan mode, only
  when the gate passed and the diff is non-empty.
- Output is `ccc-runfacts.json`, `ccc-report.md`, `events.jsonl`, and, for changed work,
  `CHANGES.diff` in the isolated directory.
- Outcomes include `review-ready`, `no-op`, `gate-failed`, `verifier-failed`, `timed-out`, and
  Merge-only `conflicting-intent`; campaigns also roll up `campaign-failed` and
  `budget-exhausted`.

## Writing the task

Before invoking the loop, check the plan:

- **Does any instruction quietly narrow the product?** A hint can read as a restriction and
  silently remove behavior that should remain.
- **Can the test setup erase the signal?** If a fixture makes correct and incorrect
  implementations produce the same result, the assertion proves nothing. Pair every “X must be
  absent” assertion with a positive control proving the check could have seen X.
- **Does any test depend on where it runs?** The gate runs in a full isolated checkout at a
  scratch path. Avoid tests derived from `process.cwd()` or the checkout location.
- **Are invariants explicit?** State what must remain true, not only the implementation steps.
  The intent verifier reads `TASK.md`, so written invariants become checkable.
- **Is out of scope explicit?** State what must not change so the diff stays reviewable.

## Supervising a run

Immediately after starting `run` or `batch`, tell the human the printed dashboard URL and call it
a read-only view. Do not leave the URL only in captured stderr. `--open` opens it locally; use
`--no-dashboard` or `CCC_NO_DASHBOARD=1` only when the operator does not want dashboard startup
or announcement.

Keep watching the event stream or dashboard. On roughly a 30-minute cadence, also read
`loop status <run-directory>`:

- Events arrive and files or gates advance: slow, not stuck. Leave it.
- No events, still within the stage timeout, and below the stall threshold: probably thinking.
  Leave it.
- No events beyond the threshold: stalled. Intervene.
- Events arrive while the same files are rewritten without gate progress: circling. Intervene.

This monitoring is planner behavior; the package does not schedule it or contact a human.

## Iterating

Each `loop run` invocation is one engine pass: Codex writes, the gate runs, an optional pair of
Cursor verifiers runs, and reports are written. The governing law remains outside that pass. The
planner reviews the evidence, authors any correction design and mutation pin, and invokes the
next isolated pass without implementing the correction.
