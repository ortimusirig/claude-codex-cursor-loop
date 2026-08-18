# c-cube-loop

[![tests](https://github.com/ortimusirig/c-cube-loop/actions/workflows/tests.yml/badge.svg)](https://github.com/ortimusirig/c-cube-loop/actions/workflows/tests.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen) ![runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)

Codex writes in a git-isolated copy, command exit codes gate the change, and Cursor reviews it read-only.

## Install

Run these two commands inside Claude Code (not a terminal):

```text
/plugin marketplace add ortimusirig/c-cube-loop
/plugin install c-cube-loop@c-cube-loop
```

No clone or local installer is needed to use the plugin.

## What you need

**Node 24+, git, the Codex CLI, and the Cursor Agent CLI are required. Codex and Cursor
must each be signed in with its own account.** The Cursor binary is `agent`, not
`cursor-agent`.

Install the Cursor Agent CLI on Windows from PowerShell:

```powershell
irm 'https://cursor.com/install?win32=true' | iex
```

On macOS, Linux, or WSL:

```sh
curl https://cursor.com/install -fsS | bash
```

Reopen the terminal after installing, confirm the binary is `agent`, and run `agent login`.

No installer can perform those sign-ins: they are interactive browser flows owned by each
CLI. Plain `doctor` reports which required programs are missing, gives the exact fix for each,
and verifies both sign-ins with free local status commands; it spends no agent tokens.
`doctor --deep` spends a small number of agent tokens to verify that the signed-in Codex CLI
can write and the signed-in Cursor CLI can read.

**Everything else is optional.** GitHub publishing, Logdy, and the offline Obsidian journal
are separate add-ons. A machine with none of them has a fully working loop.

`init` creates two starter inputs without overwriting existing files. `plan.md` tells Codex
what result to produce and what must not change. `gate.json` is a JSON list of commands whose
exit codes decide whether the result passes. Replace the generated prompts and placeholder
gate with the real task and project checks before relying on the result.

## How the loop works

One `loop run` is one pass:

```
plan.md ──► Codex writes (isolated copy) ──► gate (exit codes) ──► Cursor verifies (read-only) ──► report
```

Your target folder is never modified. Work lands on a branch in an isolated copy, and you
review a diff.

## Why this shape

Three separate failure modes get three separate seats:

- **Codex writes but cannot mark its own homework.** It never decides whether it succeeded.
- **The gate is the only thing that can pass a change.** It runs your commands and reads
  exit codes. An agent cannot argue with a non-zero exit.
- **Cursor reviews read-only** (`--mode plan`), and only when there is a non-empty diff.
  Write flags are asserted absent, not merely omitted.

The loop refuses to report success over a red gate. If the verifier fails to launch, that is
reported as `verifier-failed` — never silently downgraded to a review verdict.

**No credentials are stored or passed by this package.** Each CLI authenticates itself on
your machine with your own subscription, and cost follows those subscriptions. Nothing is
billed through this skill.

Windows is the primary, fully-exercised target. macOS and Linux should work — pure Node,
POSIX `which`, plain `spawn` — but treat the first Unix run as verification.

After plugin installation, these are the eight namespaced slash commands:

```text
/c-cube-loop:run
/c-cube-loop:batch
/c-cube-loop:status
/c-cube-loop:dashboard
/c-cube-loop:publish
/c-cube-loop:doctor
/c-cube-loop:init
/c-cube-loop:help
```

Each is a prompt to the Claude Code controller, not a shell alias. It asks the controller to run
the corresponding real CLI command with the supplied arguments and report the child process's
true exit code. The controller must not infer success from stdout or read an exit status through
a pipe. The `run` and `batch` prompts explicitly load the governing skill law and require a
usable plan before spending tokens.

## Usage

```
node bin/loop.js run --task <plan-file-or-prose> --target <folder> --gate <gate.json> [--gate-retries M] [--executor-model MODEL] [--executor-effort EFFORT] [--verifier-model MODEL] [--port PORT] [--open] [--no-dashboard] [--quiet]
node bin/loop.js batch --task <plan-1> --task <plan-2> --target <folder> --gate <gate.json> [--gate-retries M] [--executor-model MODEL] [--executor-effort EFFORT] [--verifier-model MODEL] [--concurrency N] [--token-budget TOKENS] [--rounds N] [--round N ...] [--unit-kind KIND] [--unit-id ID ...] [--perspective NAME ...] [--depends-on CHILD=PARENT ...] [--port PORT] [--open] [--no-dashboard] [--quiet]
node bin/loop.js batch --campaign <campaign.json> [--port PORT] [--open] [--no-dashboard] [--quiet]
node bin/loop.js status <run-or-campaign-directory>
node bin/loop.js dashboard [<run-directory>] [--scratch-root <directory>] [--port <port>]
node bin/loop.js publish <completed-run-directory>
node bin/loop.js doctor [--deep] [--scratch-root <directory>] [--repository <directory>]
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

The [committed campaign design spec](docs/superpowers/specs/2026-08-15-v3-orchestrated-campaigns-design.md) uses historical labels: Mode A maps to Candidates/Rounds, and Mode B maps to Graph.

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
`ccc-merge-resolutions.json`, then reaches both run facts and the report. Genuine intent conflicts stop
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

### Outcomes and exit codes

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

### Optional GitHub publishing

Install the GitHub CLI, authenticate it once with `gh auth login`, and configure a
`github.com` remote in the run's repository. Then publish a completed run explicitly:

```sh
node bin/loop.js publish /path/to/completed/run/w
```

The command pushes the reviewed branch, creates or updates one pull request, posts each
verifier pass as its own attributable comment, prints the PR URL, and records it in
`ccc-github.json`. The pull-request body includes the executor rationale, outcome, gate
status, both verdicts and their sources, and token usage. Authentication remains entirely
`gh`'s responsibility. Publishing is never called or checked by `run` or `batch`, and a
failed publish leaves the completed run directory unchanged.

Each run writes `ccc-runfacts.json`, `ccc-report.md`, and append-only `events.jsonl` into the
isolated directory, plus a branch and a diff to review. Stdout remains exactly one JSON
run-facts document; live event summaries use stderr.

`batch` likewise writes exactly one JSON document to stdout: a `units` array containing each
unit's identity, dispatch status, and run facts, plus a `rollup` with counts, aggregate usage,
budget state, and outcome. A Candidates campaign also adds an `alternatives` view. It states explicitly that
no selection has been made and keeps each perspective beside its outcome and failure reason,
both verdicts and their sources, evidence-consistency status, diff path, branch, test-count
delta, and token cost. It computes no winner, ranking, or score. Its single-writer
`campaign-events.jsonl` lives at the
`campaignEventsPath` reported in that document, outside every unit worktree. The campaign
stream contains campaign and round boundaries plus unit lifecycle records, including explicit
`waiting`, `released`, and `skipped` records. `campaign/start` carries the complete resolved
topologyâ€”every unit, parent list, and edge, after merge promotionâ€”so consumers never need to
infer structure from whichever runtime transitions happened to occur. Later iterative rounds
record their newly resolved topology on `round/start`; detailed stage events remain in each
unit's own stream. Campaign/round records carry null unit identity
because they describe no individual unit; unit lifecycle and per-unit records carry the exact
`campaignId`, round, `unitId`, and `unitKind`.

An iterative aggregate additionally groups `units`, rollups, and alternatives in a `rounds`
array, adds the round number to every candidate, and records `stopReason`. Its top-level
`units` and `alternatives.candidates` retain the complete cross-round evidence set. A
single-round aggregate keeps the original shape exactly and has no iterative-only fields.

The campaign stream also records the shared-base decision, merge-context preparation, and the
planner data path. Each candidate gets `planner/candidate_generated` with its perspective,
each dispatched unit gets one attributed `planner/review_received` containing both review
seats (or an explicit missing list), and `planner/synthesis` records caller-supplied reasoning
before the round ends. The programmatic `runCampaign` API can accept a `plannerSynthesis`
object or callback; without one it explicitly returns the attributed review set instead of
inventing a comparison or selection.

An independent or DAG batch exits 0 only when every dispatched unit has a successful existing
run outcome and the budget was not exceeded. In Candidates, a failed candidate remains evidence and
does not make the candidate set non-zero while another usable alternative completed; if every
candidate fails, the rollup is `campaign-failed` (exit 6). A budget overage remains
`budget-exhausted` (exit 7). Failure of one unit never cancels its peers.

`status` is a separate, human-readable view of a run or campaign in progress. Pass either the
isolated `w` directory, its parent run directory, or a campaign directory containing
`campaign-events.jsonl`. It tolerates a final line that is still being appended, distinguishes
every campaign unit, and never writes to the run or signals its processes.

`dashboard` serves five in-page views over live event data and completed run facts. Triage is
the default: it groups passes into collapsed, newest-first sessions using an explicitly
heuristic two-hour start-time gap. The threshold can be changed in the page without persisting
an assignment, and the needs-attention filter is on by default. Live shows each in-flight
unit's current stage and last-event age, with predecessor waiting labelled separately from a
watchdog stall. Detail renders one selected pass, including both labelled verifier texts,
sources, evidence-consistency status, executor rationale, seat tokens, a copyable
`code "<worktree>"` command, and a byte-capped line-coloured `CHANGES.diff`. A source of `none`
is called out as an unknown fail-safe default rather than a reviewer finding. Pass a run
directory for one pass. Logs fetches the ordered raw stream on demand, with its problems-only
filter and expandable executor groups. Graph fetches one campaign on demand and draws its
declared dependency topology as deterministic layered SVG, distinguishing waiting, running,
finished, skipped, and unreached units. Fan-in and auto-promoted merge units are explicit, and
correctness, intent, and merged verdicts retain separate labels. Pass a run directory for one pass,
`--scratch-root <directory>` for every run under a campaign root, or neither to use
`CCC_SCRATCH_ROOT` and its platform default. It listens only on
`127.0.0.1`, prints its URL on stdout, and uses fixed port `7331` unless `--port` is set. If
that port is occupied it exits with an error; it never silently chooses another. The page,
CSS, JavaScript, HTTP server, and server-sent event stream use only Node built-ins and make
no external requests.

`run` and `batch` normally start (or reuse) a detached scratch-root dashboard before executor
work and announce its URL on stderr. Pass `--open` to also open the default browser. Pass
`--no-dashboard`, or set `CCC_NO_DASHBOARD=1` for CI, to skip probing, startup, and the
announcement; `--quiet` hides the announcement but still starts the dashboard. `--port` uses
the same fixed-port semantics as the explicit command.

The dashboard is a separate, strictly read-only observer. Session assignments exist only in
the browser. It tolerates a missing future run and an event record caught mid-append, and
detects new runs and appended records while open. It never writes an artifact or signals a
process. The run process imports only the small launcher and starts the server as a detached
child; it never imports the dashboard server or view code.

When verification runs, Cursor gets separate correctness and intent/assertion-audit turns.
The correctness review stays in `verifierFindings`; the intent review is retained separately
in `intentVerifierFindings`. Both are printed in `ccc-report.md`, and the overall verdict is
clean only when both passes return `NO_BLOCKERS`.
Both turns select the shipped `/ccc-verify` skill through `--plugin-dir`; each one-line prompt
still states its files, audit, and verdict contract if skill loading fails.

### Iterating

One `loop run` invocation performs one pass. Iteration is controller-driven: read the report,
author a correction plan, and invoke `loop run` again for the next pass.

### Optional flat event view with Logdy

[Logdy](https://logdy.dev/) is an optional, local operator tool: a single Apache-2.0 Go
binary with an embedded web UI. The loop does not install, launch, import, or require it.

After the `isolate/finish` stderr line shows the isolated directory, run this from the
package directory (replace `<runId>` with the active run ID):

```powershell
logdy follow "C:/ccc/w/<runId>/w/events.jsonl" --full-read --config "docs/optional-tools/logdy-run-events.json" --no-analytics --no-updates
```

For the aggregate planner/lifecycle stream, follow
`C:/ccc/w/<campaignId>/campaign-events.jsonl` with the same options.

For a custom `CCC_SCRATCH_ROOT`, substitute that root before `/<runId>/w/events.jsonl`.
`--full-read` loads events already written and `follow` keeps reading appended lines. The
checked-in config exposes the event envelope, campaign identity, perspective, decision,
reasoning, and scope as sortable table columns. It remains useful for filtering and drill-down;
the observability audit concludes that an interleaved flat table is not an adequate primary
current-state view for many concurrent units.

Do **not** use `loop run ... | logdy`: stdout is the machine-readable run-facts contract,
not the event stream. Logdy must follow the isolated `events.jsonl` file.

### Offline Obsidian run journal

Run-note generation is a separate offline command. It is never called by `loop run`, reads
only completed scratch artifacts, and writes only under this package's `docs/runs/` folder.

Generate one note by passing either the isolated `w` directory, its parent run directory,
or the facts file itself:

```powershell
node bin/generate-run-journal.js "C:/ccc/w/<runId>/w"
node bin/generate-run-journal.js "C:/ccc/w/<runId>/w/ccc-runfacts.json"
```

Regenerate every run discoverable below a scratch root:

```powershell
node bin/generate-run-journal.js --all "C:/ccc/w"
```

The output is deterministic for the same `ccc-runfacts.json` and optional `events.jsonl`.
See [`docs/runs/README.md`](docs/runs/README.md) for the stable frontmatter schema and an
embedded Obsidian Bases campaign table.

## Smoke test

A `plan.md` saying *"create hello.txt containing HELLO WORLD"*, this `gate.json`:

```json
[{ "bin": "node", "args": ["-e", "process.exit(require('fs').existsSync('hello.txt')?0:1)"] }]
```

and any throwaway folder as `--target`. Expect `outcome: review-ready`, `gateStatus: passed`,
and a verdict.

## Configuration

- **Scratch root** defaults to `C:/ccc/w` on Windows and `~/.ccc/w` elsewhere. Override with
  `CCC_SCRATCH_ROOT`.
- The scratch root must **not** sit under `AppData` or `OneDrive`. This is enforced, not
  advisory — AppData is MSIX-redirected under a packaged host, and OneDrive syncs mid-write
  and lengthens paths past Windows limits.
- Model defaults are pinned at their launch boundaries in `src/executor.js` and
  `src/verifier.js`; reports import those same defaults rather than duplicating them.
- **Executor timeout:** 30 minutes by default; override the millisecond value with
  `CCC_EXECUTOR_TIMEOUT_MS`.
- **Verifier timeout:** 10 minutes per Cursor pass by default; override with
  `CCC_VERIFIER_TIMEOUT_MS`.
- **Gate timeout:** 60 minutes per command by default (chosen to accommodate slow test
  suites); override with `CCC_GATE_TIMEOUT_MS`.
  All three timeout overrides are positive integer millisecond values.
- **Stall gap:** 10 minutes since the last event for that stage; override the positive
  millisecond value with `CCC_STALL_THRESHOLD_MS`. Every event resets the gap.
- **Stall policy:** `CCC_STALL_POLICY=report` by default. It records and reports a stall but
  kills nothing. Opt in with `CCC_STALL_POLICY=restart` to stop a stalled executor process
  tree and relaunch it with a stall notice appended to the original plan.
- **Stall restart bound:** one restart by default; set `CCC_STALL_RESTARTS` to `0`-`3`.
  Stall restarts and gate retries have separate limits and counters in the run facts.
- **Terminal heartbeat:** pass `--quiet` to suppress event summaries on stderr without
  disabling the isolated `events.jsonl` stream.

## Known gotchas

- **Cursor needs `--trust`** to clear its workspace-trust gate. Without it, it exits 1 with
  empty output and every review silently falls back to `ISSUES`. Already on the launch line.
- **Never pass `--ignore-user-config` to Codex.** It discards the project trust registry and
  Codex silently goes read-only — it appears to work and writes nothing.
- **`where codex` may list an extensionless npm shim first.** Handled: the resolver prefers a
  PATHEXT-executable variant.

## Contributor/development setup

This checkout path is only for people who intend to work on the project. If you only intend to
use c-cube-loop, follow the marketplace install above instead of cloning the repository.

```sh
git clone https://github.com/ortimusirig/c-cube-loop.git c-cube-loop
cd c-cube-loop
node install.mjs
node bin/loop.js doctor
node bin/loop.js init ../ccc-loop-demo
node bin/loop.js run --task ../ccc-loop-demo/plan.md --target ../ccc-loop-demo --gate ../ccc-loop-demo/gate.json
```

`node install.mjs` is a verifier, not a plugin installer. It validates the manifests, command and
skill layout, and payload; runs the full self-test from the checkout; reports CLI availability;
prints the two local-checkout `/plugin` commands; and finishes with `PLUGIN_STATUS=PREPARED`. It
never writes Claude Code's marketplace, plugin, or settings state. `--dry-run` performs validation
without running the self-test. CI runs that dry-run validation on every push and pull request.

If `~/.claude/skills/c-cube-loop` or the superseded personal-skill directory exists, the verifier
warns about the duplicate, names the path, and prints the exact platform removal command. It never
removes either directory.

```
node --test
```

The test suite has zero runtime dependencies and no build step. `fixtures/` holds real captured
`codex` and `cursor-agent` NDJSON streams so the parsers are tested against actual vendor
output rather than invented shapes.

See [PORTING.md](PORTING.md) for moving this to another machine.

## License

MIT — see [LICENSE](LICENSE).
