# Stall supervision — design

**Date:** 2026-08-15
**Status:** approved, not yet implemented
**Applies to:** `run-claude-codex-cursor-loop` v2
**Depends on:** the event stream from
`2026-08-15-run-observability-and-obsidian-docs-design.md`

## Problem

A run can be alive and useless. The per-stage timeouts added earlier bound a stage's *total
duration* — 30 minutes for the executor by default — but say nothing about whether anything
is happening inside that window. An executor that emits nothing for 25 minutes is still
inside budget and looks healthy to every existing check.

Observed durations across the first four campaign runs were 17, 9, 26 and 13 minutes
end-to-end, including gate and both verifier passes. So a stage that goes quiet for a large
fraction of its budget is anomalous, and the current design cannot see it.

Separately, no component asks whether a run is doing the *right* thing. Silence is
detectable mechanically; going in circles is not.

## The tension this design has to hold

The immediately preceding change **removed** `--max-iterations` because self-looping
autonomy belongs to the controller, not the tool. A supervisor that kills and restarts
stages puts autonomy back inside the tool. That is acceptable only if it stays bounded,
observable, and off by default for anything destructive — otherwise the tool quietly becomes
the thing that was just deliberately removed.

## Hard constraint on "nudging"

`codex exec` receives the plan on stdin and stdin is closed immediately. **Guidance cannot
be injected into a running Codex process.** Any nudge is therefore necessarily:

    detect stall -> kill the stage's process tree -> re-run with an augmented plan

which is the machinery already built for gate-failure feedback, pointed at a different
trigger. There is no in-flight steering, and the design must not pretend otherwise.

## Split by capability

| Capability | Signal | Mechanism | Who |
|---|---|---|---|
| Liveness | no event for N minutes | gap watchdog | in-skill, deterministic |
| Progress | busy but going in circles | judgment over the stream | controller |

Mechanical detection stays deterministic and testable. Judgment stays in the controller
seat, where the three-seat design already puts it. Neither half pretends to do the other's
job.

## Component A — in-skill stall watchdog

New module. Consumes the same reporter/event stream the observability design introduces;
this is a hard ordering dependency, because without events there is nothing to measure a gap
against.

- Tracks time since the last event **per stage**.
- On a gap exceeding the threshold, emits a `stalled` event carrying the stage, the gap
  duration, and the last event seen.
- Threshold default: **10 minutes**, environment-overridable in the existing `CCC_` style.
  Chosen against observed behaviour — whole runs complete in 9-26 minutes, so ten minutes of
  total silence within one stage is clearly anomalous while leaving ample room for a long
  reasoning pause.

**Policy, default `report`:**

- `report` — record the stall in the run facts and the report, emit the event, and otherwise
  let the existing stage timeout do its job. Nothing is killed.
- `restart` — kill the stage's process tree (reusing the existing Windows `taskkill /T` path
  with its `CreateToolhelp32Snapshot` fallback) and re-run with the plan augmented by a stall
  notice, reusing the gate-failure feedback pattern. **Opt-in only.**

Restarts are bounded by their own counter, accounted and reported separately from gate
retries so the two cannot be confused.

A run that ends stalled must not be reported as success. Either map it onto the existing
non-zero-exit outcome for timeouts, or add a distinct outcome with its own non-zero code in
the exit map. Relying on the unrecognised-outcome fallback is not acceptable as the
mechanism.

## Component B — controller-side principal review

Not autonomy inside the tool: an instrument plus a documented protocol.

**Instrument.** A read-only `status` command that takes a run directory and prints a compact
digest of the event stream — current stage, time since last event, files changed so far,
gate commands run and their codes, tokens burned, and any stall events. One command instead
of reading NDJSON by eye. It must be strictly read-only and must never touch a running
process.

**Protocol.** A section in SKILL.md describing what a supervising controller checks on a
roughly 30-minute cadence, and — more usefully — how to tell *slow* from *stuck*:

- Events still arriving, files still changing: slow. Leave it.
- No events, inside the stage timeout, gap under threshold: probably thinking. Leave it.
- No events and the gap exceeds the threshold: stalled. Report to the human.
- Events arriving but the same files rewritten repeatedly with no gate progress: circling.
  This is the case only judgment catches, and the one worth escalating.

The 30-minute cadence is a controller behaviour, not a feature of the package. Nothing in
the skill schedules it.

## Do not compromise

- The target folder is never modified.
- Gate pass/fail remains exit-code only. A stall must never influence a gate verdict.
- The verifier stays read-only; forbidden flags stay asserted absent.
- stdout of the CLI remains exactly one JSON document.
- Zero runtime dependencies.
- With no reporter attached, there is no watchdog and no behavioural change whatsoever.
- Killing is opt-in. The default policy observes and records; it does not act.

## Testing

- A stage that emits events steadily is never marked stalled, even past the threshold in
  aggregate — the gap resets on every event. Assert this with a fixture that would fail if
  the implementation measured total elapsed time instead of the gap.
- A stage silent past the threshold is marked stalled.
- Under `report`, nothing is killed and the run reaches its normal outcome.
- Under `restart`, the stage is killed and re-run, the augmented plan contains the stall
  notice, and the restart counter is bounded.
- Restart accounting is distinct from gate-retry accounting.
- A run ending stalled exits non-zero.
- `status` never mutates anything and works against a partial, still-being-written stream.

Tests must not derive paths from `process.cwd()` or the checkout location.

## Out of scope

In-flight steering of a running Codex process (impossible, see above), any scheduler inside
the package, automatic escalation to a human by any channel, and any change to the
three-seat model beyond the observing watchdog described here.
