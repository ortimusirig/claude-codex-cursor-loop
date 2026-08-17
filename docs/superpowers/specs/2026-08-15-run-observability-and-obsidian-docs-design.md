# Run observability and Obsidian documentation — design

**Date:** 2026-08-15
**Status:** approved, not yet implemented
**Applies to:** `c-cube-loop` v2

## Problem

Two complaints, one root cause.

**No visibility during a run.** A `loop run` is silent for many minutes while Codex works at
xhigh effort. The controller cannot distinguish "working" from "hung", and has nothing to
watch. The only signal is the process eventually exiting.

**No durable record after a run.** Everything a run learns — verdicts, token cost, which
files changed, why the executor did what it did — lands in `ccc-runfacts.json` inside a
throwaway scratch directory under `C:/ccc/w/`. A campaign of five runs exists only as
terminal scrollback and JSON nobody will open again.

These are the same information at two time horizons: the live view of a run's event stream,
and the retrospective view of that same stream. Designed as one source with several readers,
the terminal view, the browser view and the vault note cannot disagree. Designed separately,
they drift.

## Constraint that shapes every decision

This package has **zero runtime dependencies**, and `install.mjs` SHA-256-verifies every
file. That property is load-bearing: it is what makes the hash check meaningful for a tool
that spawns coding agents and documents `CCC_CODEX_SANDBOX=danger-full-access` as an escape
hatch. Any option requiring npm packages or a mandatory service breaks it.

This rules out embedding an observability platform. It does **not** rule out *emitting* a
stream that such a platform could later consume.

## Approaches considered

**Full LLM observability platform** — Langfuse (MIT core), Arize Phoenix (Elastic License
2.0, not OSI open source), Laminar (Apache-2.0, OpenTelemetry-native). Rejected for now on
two grounds. Structurally, they instrument LLM calls an application makes through an SDK;
this loop makes none — it shells out to `codex` and `agent` and parses their NDJSON, so
there are no spans to capture without first synthesising them. Practically, each adds a
service (Langfuse wants Docker Compose and ClickHouse) to a tool whose selling point is
having none.

**Bespoke dashboard** — Node's built-in `http` plus server-sent events plus one static page.
Zero npm dependencies since `http` ships with Node, and it could show exactly the right
shape: current stage, files landing live, token burn, both verdicts as they arrive. Rejected
as a *first* step because it is a permanent surface to own before we know what is worth
watching.

**Adopt Logdy** — Apache-2.0, single Go binary, embedded web UI, reads JSONL from a file or
stdin, custom parsers turn fields into sortable columns, and no data leaves the host.
Chosen. The dependency direction is what makes it fit: the loop emits a stream and knows
nothing about Logdy; Logdy consumes it and knows nothing about the loop. Neither can break
the other and `dependencies: {}` stays literally true, because Logdy is a binary the
operator optionally runs rather than a package the skill installs.

**Decision:** emit the stream now and adopt Logdy for the live view; build the bespoke page
later only if Logdy proves insufficient in real use. The event stream is the durable part;
the viewer is swappable.

## Architecture

One event source, three consumers.

```
loop run
   |-- emit() --> events.jsonl --> logdy            (live browser)
   |          \-> stderr line  --> terminal          (live tail)
   |
   \-- writeReport --> ccc-runfacts.json
                              |
                              v
                    notes generator (offline)
                              |
                              v
                     docs/runs/<runId>.md --> Obsidian Bases (campaign table)
                              | wikilinks
                              v
                      docs/code/*.md <-- code-explainer-sg
```

### Component 1 — `src/events.js`, the emitter

A reporter callback threaded into `run()` and the stage modules, defaulting to a **no-op** so
that with nothing listening the behaviour and overhead are exactly as today. Stage modules
must not call `process.stderr.write` directly; the real sinks are wired in `bin/loop.js`.

`bin/loop.js` attaches two sinks:

1. append NDJSON to `<isoDir>/events.jsonl`
2. write a one-line human summary to **stderr**

Event shape:

```
{ ts, runId, stage, type, ...stageFields }
```

- `stage` in `isolate | executor | gate | diff | verify | report`
- `type` in `start | finish | file_change | gate_command | retry | verdict`
- stage fields as appropriate: `file`, `bin`, `args`, `code`, `verdict`, `source`, `tokens`

Field names stay close to the OpenTelemetry GenAI semantic conventions. This costs nothing
now and keeps a later Langfuse or Laminar integration possible without re-instrumenting.

**Primary invariant: stdout remains exactly one JSON document.** `bin/loop.js` writes the
run facts to stdout and callers parse it; a single stray line corrupts that contract and
breaks every programmatic consumer. This is the one way the feature can do real damage.

This **supersedes backlog item #11** (progress heartbeat). The heartbeat stops being a
feature in its own right and becomes one formatter over the event stream.

### Component 2 — Logdy, adopted not built

Note the wiring subtlety: `loop run | logdy` does **not** work, because stdout is the JSON
contract. Logdy reads the file instead.

Ship a documented one-liner in the README plus a checked-in Logdy column configuration so
the JSONL fields render as proper sortable columns. Nothing in the package references or
requires Logdy; it stays an optional operator tool.

### Component 3 — the notes generator

A **separate offline script**, deliberately not part of a run. It reads
`ccc-runfacts.json` and `events.jsonl` and writes `docs/runs/<runId>.md`.

Frontmatter — this is what Obsidian Bases queries:

```
runId, date, outcome, gateStatus, verdict, intentVerdict, verdictSource,
tokensTotal, branch, filesChanged
```

Body: what changed, executor reasoning, both verifier findings, the gate-failure block when
present, and a token table. Wikilinks to `docs/code/*.md` for every file the run touched.

Being offline and re-runnable means a defective generator can never break a run, and the
whole campaign's notes can be regenerated after a template change.

### Component 4 — the code walkthrough

A plain invocation of the existing `code-explainer-sg` skill in Obsidian mode, producing one
linked note per source file under `docs/code/`. No new code. Run notes link into these, so
"what changed in run 2" and "what does `run.js` do" are one click apart, and Bases can
answer "which runs touched `run.js`" from the frontmatter.

### Documentation location

Notes are generated into `docs/` **inside the repository**, so they are versioned alongside
the code they describe and the loop never writes outside its own project. Obsidian can open
the repo folder as a vault, or the folder can be symlinked into an existing vault. Automatic
vault synchronisation is explicitly not part of this design.

**Obsidian Bases is a core plugin** (shipped in 1.9 with table and card views; 1.10 added
list and map), so the campaign table needs no third-party plugin. Dataview remains a
fallback only if computed fields or its `dataviewjs` escape hatch are ever required.

## Error handling

- **Emitter failures are swallowed.** A logging bug must never fail a run. Every emit is
  guarded; a failed event is dropped, not propagated.
- `events.jsonl` is **append-only**, so a crashed or killed run still leaves a valid partial
  stream that Logdy and the generator can both read.
- The notes generator runs offline and is never invoked by the loop, so it cannot affect an
  outcome.

## Testing

- **stdout purity** — the primary invariant. Capture both streams and assert stdout parses
  as exactly one JSON document. The same test must also assert the heartbeat *did* appear on
  stderr, so it cannot be satisfied by a run that emits nothing anywhere.
- Stage transitions are emitted in the expected order.
- Executor `file_change` events reach the reporter.
- With no reporter supplied, nothing is emitted at all.
- The silencing flag or environment variable suppresses output.
- `spawnCapture`'s returned stdout is **byte-identical** to today's if incremental
  observation is added — compare against a known fixture's full text.
- Generated frontmatter round-trips through a YAML parse.
- The generator is deterministic given identical run facts.

## Out of scope

The bespoke dashboard, OpenTelemetry export, automatic vault synchronisation, and any
long-running daemon. All deferred until Logdy proves insufficient in practice.

## Sequencing

Backlog item #11 must be removed from the run-5 plan before that run executes, otherwise
run 5 builds a standalone heartbeat this design immediately replaces.

Implementation is split into two loop runs:

- **Run 6** — the event stream, stderr sink, Logdy documentation and column config
- **Run 7** — the notes generator and the `code-explainer-sg` invocation

## References

- Logdy — https://github.com/logdyhq/logdy-core (Apache-2.0)
- Laminar — https://laminar.sh/article/top-6-agent-observability-platforms
- Langfuse self-hosting — https://effloow.com/articles/langfuse-llm-observability-self-host-guide-2026
- Obsidian Bases vs Dataview — https://obsidian.rocks/dataview-vs-datacore-vs-obsidian-bases/
