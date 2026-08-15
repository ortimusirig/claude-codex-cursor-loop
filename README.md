# run-claude-codex-cursor-loop

A three-seat agent loop for [Claude Code](https://claude.ai/code): **Claude plans, Codex
writes, Cursor reviews** — with the write step confined to a git-isolated copy and a gate
that decides pass/fail by exit code, not by an LLM's opinion.

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

## Requirements

| Requirement | Why | Check |
|---|---|---|
| **Node ≥ 24** | runtime | `node --version` |
| **git** | isolation (worktree / init) | `git --version` |
| **Codex CLI** | executor seat | `codex --version` |
| **Cursor Agent CLI** | verifier seat | `agent --version` |
| **Claude Code** | controller seat | — |

The Cursor binary is **`agent`**, not `cursor-agent`.

**No credentials are stored or passed by this package.** Each CLI authenticates itself on
your machine with your own subscription, and cost follows those subscriptions. Nothing is
billed through this skill.

Windows is the primary, fully-exercised target. macOS and Linux should work — pure Node,
POSIX `which`, plain `spawn` — but treat the first Unix run as verification.

## Install

```
node install.mjs
```

Copies the payload to `~/.claude/skills/run-claude-codex-cursor-loop`, verifies **every file
by SHA-256**, runs the test suite **from the installed location**, and reports whether `git`,
`codex`, and `agent` are on PATH. Non-zero exit means it did not install cleanly.

Options: `--dry-run` (preview, writes nothing), `--name <x>` (install under a different name
to run side-by-side with an existing copy).

## Usage

```
node bin/loop.js run --task <plan-file-or-prose> --target <folder> --gate <gate.json> [--gate-retries M] [--executor-model MODEL] [--executor-effort EFFORT] [--verifier-model MODEL] [--quiet]
node bin/loop.js batch --task <plan-1> --task <plan-2> --target <folder> --gate <gate.json> [--concurrency N] [--token-budget TOKENS] [--unit-kind KIND] [--unit-id ID ...] [--depends-on CHILD=PARENT ...] [--quiet]
node bin/loop.js status <run-directory>
node bin/loop.js dashboard [<run-directory>] [--scratch-root <directory>] [--port <port>]
```

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
| `--unit-kind` | `candidate` | `candidate`, `node`, or `merge`; give once for every task or once per `--task` |
| `--unit-id` | generated | stable unit ID; when used, give once per `--task` |
| `--depends-on` | none | `CHILD=PARENT`; repeat for edges and repeat the same child for fan-in |

The budget counts input plus output tokens. Cached input and reasoning output are already
subsets of those values and are not counted twice. Dispatch stops after completed run facts
push the campaign over budget; units already in flight are allowed to finish.

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

Each run writes `ccc-runfacts.json`, `ccc-report.md`, and append-only `events.jsonl` into the
isolated directory, plus a branch and a diff to review. Stdout remains exactly one JSON
run-facts document; live event summaries use stderr.

`batch` likewise writes exactly one JSON document to stdout: a `units` array containing each
unit's identity, dispatch status, and run facts, plus a `rollup` with counts, aggregate usage,
budget state, and outcome. Its single-writer `campaign-events.jsonl` lives at the
`campaignEventsPath` reported in that document, outside every unit worktree. The campaign
stream contains campaign and round boundaries plus unit lifecycle records, including explicit
`waiting`, `released`, and `skipped` records for dependency edges; detailed stage
events remain in each unit's own stream. Campaign/round records carry null unit identity
because they describe no individual unit; unit lifecycle and per-unit records carry the exact
`campaignId`, round, `unitId`, and `unitKind`.

A batch exits 0 only when every dispatched unit has a successful existing run outcome and the
budget was not exceeded. Any failed unit takes precedence as `campaign-failed` (exit 6);
otherwise a budget overage is `budget-exhausted` (exit 7). Failure of one unit never cancels
its peers.

`status` is a separate, human-readable view of a run in progress. Pass either the isolated
`w` directory or its parent run directory. It reads `events.jsonl`, tolerates a final line
that is still being appended, and never writes to the run or signals its processes.

`dashboard` serves the same event data as a live, side-by-side browser view. Pass a run
directory for one card, `--scratch-root <directory>` for every run under a campaign root, or
neither to use `CCC_SCRATCH_ROOT` and its platform default. It listens only on
`127.0.0.1`, prints its URL on stdout, and uses fixed port `7331` unless `--port` is set. If
that port is occupied it exits with an error; it never silently chooses another. The page,
CSS, JavaScript, HTTP server, and server-sent event stream use only Node built-ins and make
no external requests.

The dashboard is a separate, strictly read-only observer. It tolerates a missing future run
and an event record caught mid-append, and detects new runs and appended records while open.
It never writes an artifact or signals a process, and `loop run` neither imports nor starts
it.

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

For a custom `CCC_SCRATCH_ROOT`, substitute that root before `/<runId>/w/events.jsonl`.
`--full-read` loads events already written and `follow` keeps reading appended lines. The
checked-in config exposes the event envelope and common stage fields as sortable table columns.

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

## Development

```
node --test
```

The test suite has zero runtime dependencies and no build step. `fixtures/` holds real captured
`codex` and `cursor-agent` NDJSON streams so the parsers are tested against actual vendor
output rather than invented shapes.

See [PORTING.md](PORTING.md) for moving this to another machine.

## License

MIT — see [LICENSE](LICENSE).
