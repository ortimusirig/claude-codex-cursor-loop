# v3 — orchestrated campaigns: divergent and convergent execution

**Date:** 2026-08-15
**Status:** approved in design, not yet implemented
**Applies to:** `run-claude-codex-cursor-loop` v3
**Depends on:** the event stream (v2, shipped), the `ccc-verify` skill (queued), the stall
watchdog (queued)

## Problem

`loop run` executes exactly one plan, one time, against one tree. Two shapes of real work
do not fit that.

**Ambiguous goals.** When several reasonable approaches exist, committing to one up front is
a guess. Today the only way to compare approaches is to run them one at a time and remember
the results by hand.

**Decomposable goals.** When a fixed plan splits into tasks with dependencies, independent
tasks could run concurrently and dependent ones could wait. Today everything is serial
because the tool has no notion of more than one unit of work.

Both need the same thing underneath: a way to execute many units, each isolated, and reason
over the results.

## Vocabulary

- **Unit** — one plan, one base ref, one worktree, one gate, two verifier passes, one set of
  run facts. Identical to today's `loop run`.
- **Campaign** — a set of units executed under one orchestrator with one budget.
- **Round** — one batch of units within a campaign. Iterative mode has several.
- **Planner / orchestrator** — the model seat (Claude Fable) that generates units, reads
  their reviews, and decides what happens next.

The loop needs **no mode flag**. A Mode A candidate and a Mode B node are the same object to
the tool: a plan, a base ref, a worktree. The modes differ only in what the planner does
with the results — choose between them, or sequence them.

## Mode A — divergent (STORM with execution)

For ambiguous goals.

1. The planner generates N candidate plans from **genuinely distinct perspectives** —
   minimal-change, refactor-first, different data structure, test-first. Not rewordings.
   This is STORM's multi-perspective step and it is where the value lives; N candidates that
   are secretly one approach is N times the cost for nothing.
2. All N execute concurrently, each isolated, all branching from the same base. No
   dependency edges, no joins.
3. Each is judged by the seat that already exists: its own exit-code gate, its own two
   verifier passes against its own `TASK.md`. **No comparator is built.** N candidates
   produce N gate results and 2N reviews automatically.
4. Everything feeds back to the planner, which decides.

**Nothing is scored, so nothing can be gamed.** Judgment is prose reasoning plus objective
gate results, synthesised by a model that weighs reasons rather than a metric an executor
could optimise toward.

**The reviewer never compares.** It judges each candidate in isolation. Comparison is the
planner's job, so the verifier seat needs no changes for Mode A.

### Two execution shapes, selected by CLI parameter

- **Single-round fan-out** — generate N, execute, review, decide. One shot.
- **Iterative** — the planner reads round 1's reviews and issues a better-informed round 2.
  This is STORM proper: the loop *is* the refinement.

Iteration is opt-in and bounded. It differs from the `--max-iterations` knob removed in v2:
that re-ran an identical plan with no new information, a pure re-roll. A round re-runs a
*different* plan informed by real reviews of really executed code. One is repetition, the
other is learning. The same discipline still applies — bounded by default, every round in
the event stream, and a hard budget it cannot exceed.

`loop run` remains one pass with one checkpoint. Rounds live at the campaign level, in a
separate command.

## Mode B — convergent (DAG fan-out)

For fixed, decomposable plans.

The planner authors the graph and therefore already holds every dependency edge. **Git is
itself a DAG**, so no graph engine is needed inside the tool. Scheduling — what runs when,
what waits — is judgment over information the planner already has, and stays controller-side.
Topology — which tree an executor sees — is mechanical, must be exact, and belongs in the
tool.

The whole skill-side requirement is that isolation accept a **base ref** and a
**caller-supplied branch name** instead of always `HEAD` under a generated name.

Constraints that follow from git, not from choice:

- A worktree has exactly one branch checked out. **One node = one branch = one worktree.**
- All nodes in a campaign must branch from one shared base. For a real git target this is
  free. For a non-repo target, today's `cpSync` + `git init` happens *per run*, so the base
  repo must instead be created once per campaign and shared.

### Mid-DAG gates

A node implementing half a feature may legitimately fail the full suite. Either decomposition
is constrained so every node is independently green, or intermediate nodes get a narrower
gate and only terminal nodes face the full one. This is a per-campaign choice the planner
declares; the tool enforces whatever it is told.

## Merging

**Merging is the normal path, not the exception.** In Mode A the planner's usual output is a
synthesis — "candidate 2's structure with candidate 3's error handling" — not a bare
selection. In Mode B any fan-in needs one.

**A merge is a full loop run.** Its own `TASK.md`, its own gate, its own two verifier passes,
its own reviewable diff. That converts "an agent guessed" into "an agent guessed and then an
exit-code gate and two independent reviewers checked the guess."

Two mitigations are mandatory, because the obvious gate is weaker than it looks:

- **A test-count floor** of `A_count + B_count − baseline`, so silently dropping a test file
  during conflict resolution fails mechanically.
- **The merge plan must require at least one new test covering the seam**, and the intent
  verifier gets a merge-specific `TASK.md`: preserve both behaviours, and prove the
  interaction is tested.

The reason: neither parent's tests cover the *interaction* between the parents, because
neither existed when the other was written. The union of two suites tests the union of two
features, never their intersection. A merge can be fully green and wrong precisely at the
seam.

**Escape hatch.** When two intents genuinely conflict, abort and ask rather than splice. This
is the norm Cursor's own `babysit` skill already uses for merge conflicts, and it is the
right default.

**Mode A merges are structurally harder than Mode B merges.** Mode B nodes are independent
tasks that mostly touch different files, so conflicts are incidental. Mode A candidates are
competing solutions to the same problem and deliberately touch the same files, so conflict
is the expected case.

## Campaign observability

Every actor must be visible in real time: the planner, every parallel candidate, every
sequential node, both reviewer passes per unit, and every merge task.

**This is not an add-on.** Until v3 the planner was the human-facing session, and its
reasoning was visible by reading the conversation. Moving the orchestrator inside the tool
removes observability that currently comes for free. Without this section, v3 is *less*
observable than v2.

### Event identity above the run

Today's envelope is `{ts, runId, stage, type, ...}`. It gains:

- `campaignId` — ties units together
- `round` — orders them
- `unitId` — a unit's identity (`runId` can serve)
- `unitKind` — `candidate` | `node` | `merge`, so a merge task is never mistaken for a
  candidate

`EVENT_STAGES` and `EVENT_TYPES` are frozen allowlists and `createEvent` throws on anything
unknown, so each addition is deliberate and validated. That property must be preserved.

### The planner becomes an event source

A new stage covering: round start and end, candidate generation (including the **perspective
assigned** to each candidate), reviews received, the synthesis decision, and the reasoning
for it. The planner is the actor whose activity matters most to watch and the only one with
no instrumentation today.

### Aggregation without write contention

Per-unit `events.jsonl` files stay exactly as they are — one writer each, in each unit's own
isolated directory. The batch orchestrator, a **single** writer, emits a campaign-level
stream covering round boundaries, unit lifecycle, planner activity, and merges. N concurrent
processes appending to one shared file would risk interleaved writes, particularly on
Windows.

The dashboard reads the campaign stream and drills into per-unit streams on demand.

### Open decision — does this cash the deferred dashboard?

v2 adopted Logdy (Apache-2.0, single binary, embedded web UI) and deferred a bespoke page,
with the agreed trigger being "only if Logdy proves insufficient."

Logdy renders a flat, filterable log table — excellent for one sequential run. What this
section describes is a **state** view: what each of N concurrent actors is doing *right now*.
Those are different visualisations. This is a decision to make deliberately before building,
not to assume in either direction.

## Defaults — all configurable from the CLI

| Parameter | Default | Reasoning |
|---|---|---|
| Candidates per round | 3 | Two gives no tiebreak and no third perspective; five or more is mostly cost. Three is the smallest number that can disagree. |
| Rounds | 1 (fan-out) | Iteration is opt-in, matching the watchdog's observe-by-default posture. Cap at 3. |
| Concurrency | 2 | Each unit spawns roughly three `codex.exe` processes at xhigh. |
| Token budget | hard, campaign-wide | Not per-unit. On exceeding it, stop spawning new work and report what completed. |

Measured cost per unit: input around 4M tokens of which roughly 3.9M is cached — uncached
input around 130k, output around 30k.

## Do not compromise

- The target folder is never modified.
- Gate pass/fail remains exit-code only.
- The verifier stays read-only; forbidden flags stay asserted absent.
- `loop run` keeps its contract: one pass, one checkpoint, exactly one JSON document on
  stdout. Campaign commands are separate.
- Zero runtime dependencies.
- Every harness artifact joins `HARNESS_ARTIFACTS`, or it leaks into `CHANGES.diff` and makes
  `no-op` unreachable.
- No campaign behaviour may run unbounded. Rounds, concurrency, and tokens are all capped.

## Sequencing

1. `ccc-verify` skill — **a prerequisite, not an enhancement.** Roughly 20% of verifier
   passes in the v2 campaign produced no verdict token. In single-run mode that costs one
   manual review; in Mode A the planner synthesises over N reviews and cannot tell which are
   noise.
2. Batch execution engine — bounded concurrency, per-unit facts plus aggregate, campaign
   event stream.
3. Base-ref isolation and the shared campaign base repo.
4. Mode B, tree-shaped first.
5. Merge-as-loop-run with the test-count floor and seam-test requirement.
6. Mode A single-round.
7. Mode A iterative.

## Out of scope

In-flight steering of a running Codex process — `codex exec` closes stdin immediately, so a
nudge is necessarily kill-and-re-run. Automatic escalation to a human by any channel.
Auto-merging without a gate. Any scoring function for candidate selection.

## References

- Cursor `babysit` skill — merge-conflict resolution with an abort-and-ask escape hatch
- `superpowers:dispatching-parallel-agents` — the independence/shared-state scheduling
  decision tree, controller-side
- `superpowers:using-git-worktrees` — worktree mechanics, including that
  `GIT_DIR != GIT_COMMON` is also true inside submodules
- `superpowers:finishing-a-development-branch` — integration options and worktree cleanup
- `superpowers:subagent-driven-development` — "rule on the conflict, ledger the ruling"
