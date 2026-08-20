# Usage

```
node bin/loop.js run --task <plan-file-or-prose> --target <folder> --gate <gate.json> [--gate-retries M] [--executor-model MODEL] [--executor-effort EFFORT] [--verifier-model MODEL] [--port PORT] [--open] [--no-dashboard] [--quiet]
node bin/loop.js batch --task <plan-1> --task <plan-2> --target <folder> --gate <gate.json> [--gate-retries M] [--executor-model MODEL] [--executor-effort EFFORT] [--verifier-model MODEL] [--concurrency N] [--token-budget TOKENS] [--rounds N] [--round N ...] [--unit-kind KIND] [--unit-id ID ...] [--perspective NAME ...] [--depends-on CHILD=PARENT ...] [--port PORT] [--open] [--no-dashboard] [--quiet]
node bin/loop.js batch --campaign <campaign.json> [--port PORT] [--open] [--no-dashboard] [--quiet]
node bin/loop.js status <run-or-campaign-directory>
node bin/loop.js dashboard [<run-directory>] [--scratch-root <directory>] [--port <port>]
node bin/loop.js publish <completed-run-directory>
node bin/loop.js doctor [--deep] [--scratch-root <directory>] [--repository <directory>]
node bin/loop.js doctor --fix [--scratch-root <directory>] [--repository <directory>]
node bin/loop.js setup [--scratch-root <directory>]
node bin/loop.js init <directory>
node bin/loop.js help
```

`--help` and `-h` remain aliases for `help`.

`init` never overwrites `plan.md` or `gate.json`. It detects a `package.json` test script;
otherwise it emits a valid, runnable placeholder gate with an explicit comment telling you to
replace it. `doctor` runs Node, Git, PATH, local Codex/Cursor sign-in, scratch-safety, and
scratch-writability checks by default without spending agent tokens. The Codex write and Cursor
read probes spend real agent tokens, so they are marked `SKIP` until `--deep` is supplied.
Every probe uses and cleans its own disposable scratch directory; neither the target nor a run
directory is modified.

| Option | Required | Default | Range |
|---|---|---|---|
| `--task` | yes | — | plan file path or inline prose |
| `--target` | yes | — | folder to work on, git repo or not |
| `--gate` | yes | — | path to gate config |
| `--gate-retries` | no | 2 | 0–3 |
| `--corrects` | no | none | records that this run's plan corrects the named prior run; display only |
| `--executor-model` | no | launch-module default | Codex model ID |
| `--executor-effort` | no | launch-module default | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` |
| `--verifier-model` | no | launch-module default | Cursor model ID |
| `--quiet` | no | false | suppress stderr event summaries; `events.jsonl` is still written |

`batch` accepts one or more repeated `--task` options. The target, gate, retry, and model
options have exactly the same meaning they do for `run`; every task gets its own isolated
worktree, gate, two read-only verifier passes, run facts, and `events.jsonl`.

| Batch option | Default | Range / meaning |
|---|---:|---|
| `--concurrency` | 2 | 1–16 simultaneously in-flight units |
| `--token-budget` | 12,500,000 | positive campaign-wide token count |
| `--rounds` | 1 | maximum candidate-refinement rounds, from 1–3 |
| `--round` | 1 | round for each `--task`; when used, give once per `--task` |
| `--unit-kind` | `candidate` | `candidate`, `node`, or `merge`; give once for every task or once per `--task` |
| `--unit-id` | generated | stable unit ID; when used, give once per `--task` |
| `--perspective` | none | declares Candidates; give one distinct label per `--task` |
| `--depends-on` | none | `CHILD=PARENT`; repeat for edges and repeat the same child for fan-in |
| `--campaign` | none | JSON declaration for a Graph or another campaign; mutually exclusive with campaign-shaping flags |

The budget counts input plus output tokens. Cached input and reasoning output are already
subsets of those values and are not counted twice. Dispatch stops after completed run facts
push the campaign over budget; units already in flight are allowed to finish.

Candidates is a homogeneous candidate batch. Declare it with one `--perspective` per task (or by
explicitly passing `unitKind: 'candidate'` through the programmatic API). Every candidate must
have a distinct, non-empty perspective, all candidates use the same base, and dependency edges
are rejected before execution. A bare batch without perspectives retains the original
independent-task behavior for compatibility.

Rounds is opt-in with `--rounds 2` or `--rounds 3`. Attribute predeclared CLI
plans with one `--round` per task; perspectives must be distinct within a round, but may recur
in a later round. The programmatic `runCampaign` API can instead accept `maxRounds` plus a
`nextRound` callback, which receives the completed round and its attributed reviews before it
returns the next caller-authored task set. Returning no next round, or returning true from
`shouldStop`, records `caller-requested`. The tool never generates candidates itself.

Every round isolates its alternatives from the same campaign base. A later round learns from
earlier findings but does not inherit an earlier candidate's branch. The token budget covers
the whole campaign: reaching it prevents another round and further dispatch, while units
already in flight finish. Iteration stops with `budget-exhausted`, `max-rounds-reached`, or
`caller-requested`; the aggregate retains every completed round either way.

The [committed campaign design spec](superpowers/specs/2026-08-15-v3-orchestrated-campaigns-design.md) uses historical labels: Mode A maps to Candidates/Rounds, and Mode B maps to Graph.

For a Graph, prefer `batch --campaign <campaign.json>` so topology and unit identities are one
declaration. The JSON object contains `target`, `gate`, optional campaign settings, and `units`;
each unit declares `id`, a task-file path in `task`, and optional `dependsOn`. Relative paths are
resolved from the campaign file's directory. For a small Graph, the equivalent flag form remains
available: give each task a `--unit-id` and repeat `--depends-on CHILD=PARENT` for every edge.

Dependencies are a declared DAG topology: roots fan out up to the concurrency limit, while a
dependent waits without occupying a slot. After a successful predecessor finishes, its staged
result is committed on that unit's result branch and the dependent isolates from that branch.
`no-op` is also successful and releases dependents; its result branch simply still names its
base commit. A `gate-failed`, `timed-out`, or `verifier-failed` predecessor does not release
broken work: its dependents are marked `skipped`, and that skip cascades transitively. Unrelated
roots continue normally. Unknown parents, self-dependencies, duplicate edges, and cycles are
rejected before any executor launches.

Giving one child several parents makes it a merge unit. Parent order is canonicalized by graph
declaration order; the merge starts from the first parent's result branch and brings every other
parent into the merge unit's own worktree. A clean merge continues through the normal executor,
gate, diff, and two verifier passes. A text conflict is handed to the executor with every
conflicting path named in `TASK.md`; each resolution and its reason must be recorded in
`uro-merge-resolutions.json`, then reaches both run facts and the report. Genuine intent conflicts stop
as `conflicting-intent` for human direction. Merge gates add a derived test-count floor of the sum
of parent counts minus their shared baseline counts, and the merge intent requires a new
interaction/seam test. Counts come from recognized test-runner summaries emitted by the gate;
when a gate emits no count, the deterministic fallback counts tracked test files in each Git tree.

The repository lock around worktree administration is in-process only; that scope proves nothing
about cross-process safety. In the measured experiment, eight concurrent `git worktree add`
processes all succeeded and `git fsck` stayed clean. Prefer `batch` because it
schedules, budgets, and records one campaign. The real cross-process hazard is reusing a unit id:
the execution scratch root is flat, so unit ids collide even across different repositories.

`gate.json` is a JSON array of commands; **pass/fail is by exit code only**:

```json
[
  { "bin": "npm", "args": ["test"] },
  { "bin": "npx", "args": ["tsc", "--noEmit"] }
]
```

An existing `--task` file is read regardless of extension. A missing path-like value
(including a separator, a leading `.`/`~`, or any whitespace-free token) is a preflight
error; multi-word inline prose is used verbatim.

## Outcomes and exit codes

| Outcome | Meaning | Exit |
|---|---|---|
| `review-ready` | gate green, diff produced, verdict recorded | 0 |
| `no-op` | executor changed nothing | 0 |
| `gate-failed` | a gate command exited non-zero | 1 |
| `verifier-failed` | either Cursor pass exited non-zero with no result or assistant event | 4 |
| `timed-out` | the final executor, gate, or verifier stage exceeded its deadline | 5 |
| `campaign-failed` | at least one dispatched batch unit failed | 6 |
| `budget-exhausted` | a batch exceeded its token budget | 7 |
| `conflicting-intent` | a merge found incompatible parent intents and needs human direction | 8 |
| — | preflight or argument failure | 2 |
| — | unexpected fatal error, or an unrecognised outcome | 3 |

An unrecognised outcome exits 3 rather than 0, so an outcome added later cannot silently
become a success.

## Iterating

One `loop run` invocation performs one pass. Iteration is controller-driven: read the report,
author a correction plan, and invoke `loop run` again for the next pass.

## Optional flat event view with Logdy

[Logdy](https://logdy.dev/) is an optional, local operator tool: a single Apache-2.0 Go
binary with an embedded web UI. The loop does not install, launch, import, or require it.

After the `isolate/finish` stderr line shows the isolated directory, run this from the
package directory (replace `<runId>` with the active run ID):

```powershell
logdy follow "C:/uro/w/<runId>/w/events.jsonl" --full-read --config "docs/optional-tools/logdy-run-events.json" --no-analytics --no-updates
```

For the aggregate planner/lifecycle stream, follow
`C:/uro/w/<campaignId>/campaign-events.jsonl` with the same options.

For a custom `URO_SCRATCH_ROOT`, substitute that root before `/<runId>/w/events.jsonl`.
`--full-read` loads events already written and `follow` keeps reading appended lines. The
checked-in config exposes the event envelope, campaign identity, perspective, decision,
reasoning, and scope as sortable table columns. It remains useful for filtering and drill-down;
the observability audit concludes that an interleaved flat table is not an adequate primary
current-state view for many concurrent units.

Do **not** use `loop run ... | logdy`: stdout is the machine-readable run-facts contract,
not the event stream. Logdy must follow the isolated `events.jsonl` file.

## Offline Obsidian run journal

Run-note generation is a separate offline command. It is never called by `loop run`, reads
only completed scratch artifacts, and writes only under this package's `docs/runs/` folder.

Generate one note by passing either the isolated `w` directory, its parent run directory,
or the facts file itself:

```powershell
node bin/generate-run-journal.js "C:/uro/w/<runId>/w"
node bin/generate-run-journal.js "C:/uro/w/<runId>/w/uro-runfacts.json"
```

Regenerate every run discoverable below a scratch root:

```powershell
node bin/generate-run-journal.js --all "C:/uro/w"
```

The output is deterministic for the same `uro-runfacts.json` and optional `events.jsonl`.
See [`docs/runs/README.md`](runs/README.md) for the stable frontmatter schema and an
embedded Obsidian Bases campaign table.

## Configuration

- **Scratch root** defaults to `C:/uro/w` on Windows and `~/.uro/w` elsewhere. Override with
  `URO_SCRATCH_ROOT`.
- The scratch root must **not** sit under `AppData` or `OneDrive`. This is enforced, not
  advisory — AppData is MSIX-redirected under a packaged host, and OneDrive syncs mid-write
  and lengthens paths past Windows limits.
- Model defaults are pinned at their launch boundaries in `src/executor.js` and
  `src/verifier.js`; reports import those same defaults rather than duplicating them.
- **Executor timeout:** 30 minutes by default; override the millisecond value with
  `URO_EXECUTOR_TIMEOUT_MS`.
- **Verifier timeout:** 10 minutes per Cursor pass by default; override with
  `URO_VERIFIER_TIMEOUT_MS`.
- **Gate timeout:** 60 minutes per command by default (chosen to accommodate slow test
  suites); override with `URO_GATE_TIMEOUT_MS`.
  All three timeout overrides are positive integer millisecond values.
- **Stall gap:** 10 minutes since the last event for that stage; override the positive
  millisecond value with `URO_STALL_THRESHOLD_MS`. Every event resets the gap.
- **Stall policy:** `URO_STALL_POLICY=report` by default. It records and reports a stall but
  kills nothing. Opt in with `URO_STALL_POLICY=restart` to stop a stalled executor process
  tree and relaunch it with a stall notice appended to the original plan.
- **Stall restart bound:** one restart by default; set `URO_STALL_RESTARTS` to `0`-`3`.
  Stall restarts and gate retries have separate limits and counters in the run facts.
- **Terminal heartbeat:** pass `--quiet` to suppress event summaries on stderr without
  disabling the isolated `events.jsonl` stream.
