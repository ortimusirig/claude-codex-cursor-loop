---
name: run-claude-codex-cursor-loop
description: Use when you want a lightweight Claude/Codex/Cursor loop — plan → Codex writes in git isolation → free exit-code gate → on-demand Cursor verify → run report — on any Windows folder, git repo or not.
---

# run-claude-codex-cursor-loop (v2, thin)

The controller (this Claude session) authors a plan, then invokes:

    node bin/loop.js run --task <plan-file-or-prose> --target <folder> --gate <gate.json> [--gate-retries M] [--executor-model MODEL] [--executor-effort EFFORT] [--verifier-model MODEL]

For several plans against the same target and gate, invoke the separate batch engine (one
repeated `--task` per unit):

    node bin/loop.js batch --task <plan-1> --task <plan-2> --target <folder> --gate <gate.json> [--concurrency N] [--token-budget TOKENS] [--unit-kind candidate|node|merge] [--unit-id ID ...] [--perspective NAME ...] [--depends-on CHILD=PARENT ...]

For divergent alternatives, give every task a distinct `--perspective`. Candidate batches
share one base and cannot declare dependencies. Their aggregate is evidence for a planner:
it includes failed approaches but deliberately computes no winner, ranking, or score.

- **Gate config** (`gate.json`): a JSON array of `{ "bin": "...", "args": ["..."] }`; pass/fail is by exit code only.
- Codex writes only inside a git-isolated copy; the real tree is never touched.
- Cursor runs two read-only (`--mode plan`) verification turns, for correctness and for
  intent/assertion auditing, and only when there is a non-empty diff.
- Output: `ccc-runfacts.json` + `ccc-report.md` in the isolated dir, plus a branch + diff to review.
- The command refuses to report success over a red gate. Review the report, then iterate or accept.
- **Outcomes:** `review-ready`, `no-op`, `gate-failed`, `verifier-failed` when either Cursor pass exits non-zero without producing a result or assistant event, `timed-out` when a terminal stage exceeds its deadline, or merge-only `conflicting-intent` when human direction is required. Batch adds `campaign-failed` and `budget-exhausted` rollups.
- **Exit codes:** `0` on review-ready or no-op, `1` on gate-failed, `2` on preflight/arg failure, `3` on an unexpected fatal error or unrecognised outcome, `4` on verifier-failed, `5` on timed-out, `6` on campaign-failed, `7` on budget-exhausted, and `8` on conflicting-intent.
- **Tree dependencies:** give every task a `--unit-id`, then declare each edge as `--depends-on CHILD=PARENT`. A dependent waits without holding a concurrency slot and starts from the successful predecessor's result branch. `no-op` releases dependents; gate, timeout, verifier, and internal failures skip them transitively. Repeating a child with several parents creates a full merge unit: deterministic parent order, its own worktree and `TASK.md`, a derived test-count floor, an interaction-test requirement, conflict-resolution facts/report ledger, gate, diff, and both read-only verifier passes.
- When verification runs, the correctness text stays in `verifierFindings`; the intent pass is kept separately in `intentVerifierFindings` and its own report section. The overall verdict is `NO_BLOCKERS` only when both passes are clean.
- The Cursor verifier binary is `agent` (the Cursor Agent CLI).

## Writing the task

Before invoking the loop, check the plan:

- **Does any instruction quietly narrow the product?** A hint can read as a restriction and silently remove behaviour that should remain.
- **Can the test setup erase the signal?** If a fixture makes correct and incorrect implementations produce the same result, the assertion proves nothing. Pair every "X must be absent" assertion with a positive control proving the check could have seen X.
- **Does any test depend on where it runs?** The gate runs in an isolated copy at a scratch path. Tests derived from `process.cwd()` or the checkout location can pass there and fail at home. Use absolute, construction-safe paths.
- **Are the invariants explicit?** State what must remain true after the change, not only the steps. The intent verifier reads `TASK.md`, so written invariants become checkable.
- **Is out of scope explicit?** Say what must not change so the diff stays reviewable.

## Supervising a run

On a roughly 30-minute cadence, the controller reads `loop status <run-directory>`:

- Events arriving and files changing: slow. Leave it.
- No events, still inside the stage timeout, gap under the stall threshold: probably thinking. Leave it.
- No events and gap over the threshold: stalled. Report it.
- Events arriving but the same files are rewritten with no gate progress: circling. Escalate; only judgment catches this case.

The cadence is controller behaviour. Nothing in this package schedules it, and the package
never contacts a human.

For a human-readable live view, `loop dashboard <run-directory>` serves one run, while
`loop dashboard --scratch-root <directory>` lays campaign runs out side by side. The
dashboard is an optional localhost-only, read-only observer; a run never depends on it.

## Iterating

Each `loop run` invocation performs **one pass** (Codex writes → gate → optional Cursor verify → report). Iteration is **controller-driven**: review the report, author a correction plan, and invoke `loop run` again for the next pass.
