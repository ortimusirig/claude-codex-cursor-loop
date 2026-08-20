# Optional GitHub publishing

Install the GitHub CLI, authenticate it once with `gh auth login`, and configure a
`github.com` remote in the run's repository. Then publish a completed run explicitly:

```sh
node bin/loop.js publish /path/to/completed/run/w
```

Before any network call, the confidentiality guard runs four layers:

| Layer | Mechanism | Prose | Code | Blocking |
|---|---|---:|---:|---:|
| blocklist | your file, literal substring | yes | yes | yes |
| gitleaks | pattern scanner | yes | yes | yes |
| trufflehog | pattern scanner | yes | yes | advisory |
| contextual review | Cursor `CLEAN`/`CONFIDENTIAL` verdict | yes | no | yes |

The contextual review is blocking. If Cursor cannot be launched or does not return a usable
verdict, publishing is refused, so Cursor is a hard publish dependency. `gitleaks` must also
be on `PATH`. `trufflehog` is optional: its absence is reported as a warning and its findings
are advisory. A missing or unusable blocking prerequisite refuses the publish instead of
silently skipping its check. `doctor` reports scanner and blocklist readiness under optional
features, while its standard Cursor check covers the contextual-review dependency.

Set `URO_PUBLISH_BLOCKLIST` to a readable, non-empty blocklist kept outside the repository so
its confidential identifiers cannot themselves be published. The file is newline-delimited
plain text, and `#` begins a comment. Matching is case-insensitive literal substring matching,
not regular expressions.

A regex entry such as CON|Contoso is searched as one literal string. It matches nothing,
and doctor still reports the blocklist as present.

Short terms can over-match: CON matches "config", "console", and "control", so almost any
repository blocks every publish. The failure is safe -- it refuses rather than leaks -- but a
control that blocks constantly invites being switched off. Prefer Contoso over the short form,
and terms of five characters or more. The contextual review reads
prose only, so a client identifier appearing in the code surface is caught by the blocklist
alone.

The command pushes the reviewed branch, creates or updates one pull request, posts each
verifier pass as its own attributable comment, prints the PR URL, and records it in
`uro-github.json`. The pull-request body includes the executor rationale, outcome, gate
status, both verdicts and their sources, and token usage. Authentication remains entirely
`gh`'s responsibility. Publishing is never called or checked by `run` or `batch`, and a
failed publish leaves the completed run directory unchanged.

Each run writes `uro-runfacts.json`, `uro-report.md`, and append-only `events.jsonl` into the
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
`URO_SCRATCH_ROOT` and its platform default. It listens only on
`127.0.0.1`, prints its URL on stdout, and uses fixed port `7331` unless `--port` is set. If
that port is occupied it exits with an error; it never silently chooses another. The page,
CSS, JavaScript, HTTP server, and server-sent event stream use only Node built-ins and make
no external requests.

`run` and `batch` normally start (or reuse) a detached scratch-root dashboard before executor
work and announce its URL on stderr. Pass `--open` to also open the default browser. Pass
`--no-dashboard`, or set `URO_NO_DASHBOARD=1` for CI, to skip probing, startup, and the
announcement; `--quiet` hides the announcement but still starts the dashboard. `--port` uses
the same fixed-port semantics as the explicit command.

The dashboard is a separate, strictly read-only observer. Session assignments exist only in
the browser. It tolerates a missing future run and an event record caught mid-append, and
detects new runs and appended records while open. It never writes an artifact or signals a
process. The run process imports only the small launcher and starts the server as a detached
child; it never imports the dashboard server or view code.

When verification runs, Cursor gets separate correctness and intent/assertion-audit turns.
The correctness review stays in `verifierFindings`; the intent review is retained separately
in `intentVerifierFindings`. Both are printed in `uro-report.md`, and the overall verdict is
clean only when both passes return `NO_BLOCKERS`.
Both turns select the shipped `/uro-verify` skill through `--plugin-dir`; each one-line prompt
still states its files, audit, and verdict contract if skill loading fails.
