# Executor execution record

The executor stream already carries what each command was, what it returned, what errors
said, and what the agent wrote. `src/executor.js` receives all of it and forwards only an
item-type label. This design records the discarded content so a planner can corroborate a
mutation pin instead of trusting the executor's account of it.

## Why

The mutation pin is the strongest evidence this loop produces. It claims: inject the
defect, observe the specific assertion fail, restore, observe green, record both counts.
That claim currently arrives only as executor prose in `lastMessage`, and nothing in the
run's artifacts corroborates it.

A tool whose governing rule is that no agent marks its own homework has its most important
proof step arriving as unverified self-report. The corroborating data exists — it is
captured and discarded one line before it would be written down.

The same gap makes failures unreadable. Executor `error` items carry a `message`; the
recorded event keeps only `itemType: "error"`. Runs throughout this project's own history
show five errors at startup that no one can read, and which have been repeatedly described
as "transient" on the strength of a count alone.

## What the stream already provides

Captured Codex streams in `fixtures/` confirm the shape:

- `command_execution` — `command`, `aggregated_output`, `exit_code`, `status`
- `agent_message` — `text`
- `error` — `message`
- `file_change` — `changes`, `status`

`src/executor.js` already reports `file_change` with its path. Every other item type falls
through to a single event carrying `itemType` and `attempt` and nothing else.

## Scope

In scope: recording the discarded fields on executor events, and decoding them where they
are displayed.

Out of scope: the verifier and gate stages, which already record what they run; any change
to `EVENT_PAIRS`; any change to what `publish` sends; shipping events anywhere off-machine.

## What gets recorded

On `command_execution` items: the command line, its exit code, and its output.

On `error` items: the error message.

On `agent_message` items: the message text.

`file_change` already records its path and is unchanged. Together with timestamps, file and
command events form one ordered record — a mutation pin becomes checkable as the sequence
*file X changed → test exits non-zero → file X changed → test exits zero*, rather than as a
claim in prose.

`createEvent` validates stage and type against a frozen pair list but leaves `fields`
free-form, so no schema allowlist changes.

## Storage

Output is stored inline on the event, with a size threshold deciding its form.

Measurements from this project's own runs: a full gate output is about 30 KB raw, 9.3 KB
brotli, and 12.4 KB once base64-encoded for JSON — a real saving of 59%. A three-byte
output compresses to twelve bytes. Compression helps large outputs and actively harms small
ones, and most commands print very little.

**Below the threshold** (about 2 KB), output is stored as plain text. `events.jsonl` stays
readable and greppable for the common case, and small outputs stay smaller than their
compressed form would be.

**At or above the threshold**, output is brotli-compressed and base64-encoded, with an
explicit encoding marker field on the event so a reader never has to guess which form it is
looking at. Compression uses `node:zlib`, a Node built-in, so the package's zero-runtime-
dependency invariant is unaffected.

**A ceiling** — about 256 KB after compression — bounds a runaway command. Nothing observed
in this project's history approaches it; it exists so one pathological command cannot write
an unbounded amount. Truncation is marked explicitly on the event rather than silently
applied.

Agent message text follows the same threshold and ceiling rules.

## Decoding

A single exported helper returns an event's output as text, transparently decoding the
compressed form and reporting truncation. Every consumer uses it rather than testing the
encoding marker itself, so the encoding is decided in one place.

`events.jsonl` is read by `artifacts`, `dashboard-view`, `event-stream`, `run-journal`, and
`status`. Of these, only the dashboard displays output and needs the helper; the others read
paths and identities and are unaffected. The dashboard must render decoded text, never raw
base64.

## Locality

Recorded output stays on the machine. Two paths were checked rather than assumed:

- `publish` reads `ccc-runfacts.json`, `TASK.md`, and its own note. It never opens
  `events.jsonl`, and `HARNESS_ARTIFACTS` — which lists `events.jsonl` — is used as a git
  pathspec exclusion in the publisher, the merge path, and the run path.
- The Obsidian run journal parses events only to collect touched file paths. It writes
  verdicts and filenames, never event payloads.

Recording output therefore adds no new path off the machine. This is a property of the
current code, so tests must pin it rather than leave it to be re-derived later.

## Testing

- A small output is stored as plain text and is findable by a plain-text search of
  `events.jsonl`, proving greppability survives for the common case.
- A large output round-trips through compression and the decode helper byte-identically.
- The threshold is exercised on both sides, with the two paths producing observably
  different stored forms — a fixture where both look the same would not be testing this.
- A command exceeding the ceiling is truncated and marked as truncated.
- A failing command records its non-zero exit code, and an error item records its message.
- The sequence needed to corroborate a mutation pin — file change, non-zero exit, file
  change, zero exit — is reconstructible in order from the recorded events.
- The dashboard renders decoded output, never base64.
- Locality is pinned: a test asserts `publish` sends no event content, and one asserts the
  journal emits none.
- No test depends on `process.cwd()`, the checkout location, or the run time.

## Consequences

`events.jsonl` grows. Measured against this project's own history — 88 commands in the
busiest run, 20–43 KB files today — the realistic result is a few hundred KB per run, below
the 128 KB `CHANGES.diff` cap already accepted and negligible against available disk. There
is no automatic cleanup of run directories, so growth accumulates across runs; that is
existing behavior, not introduced here.

Large outputs stop being greppable, since they are stored encoded. This is the deliberate
cost of the chosen storage form: small outputs, which are the majority, stay readable.

The dashboard gains a decode step on a display path. A malformed or truncated encoded value
must degrade to a clear message rather than an exception, since a rendering failure would
take out the whole Detail view.
