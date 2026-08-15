# Observability completeness audit

Date: 2026-08-15. Baseline audited: v3 campaign code at `cd6d883`.

The classifications below describe the stream before this audit. “Already emitted” means
both activity and result were present and campaign execution supplied the required
`campaignId`, `round`, `unitId`, and `unitKind` (campaign-wide actors use null unit fields).

| Actor or decision | Pre-audit classification | Gap closed / evidence |
|---|---|---|
| Campaign start and final rollup | already emitted | `campaign/start` and `campaign/finish` remain campaign-scoped. |
| Round boundary | already emitted | `round/start` and `round/finish` remain campaign-scoped; the API now accepts the real round number instead of forcing 1. |
| Shared campaign base | not emitted at all | Campaign-scoped `isolate/start` and `isolate/finish` record source, reuse, repository, and ready/failed decision. |
| Per-unit isolation and selected base/branch | already emitted | `isolate/start`/`finish` already carried base ref, resolved commit, branch, source, and unit identity through the unit reporter. |
| Recording a predecessor result commit | not emitted at all | Unit-attributed `isolate/start`/`finish` with `scope=campaign-result` record commit or failure. |
| Executor launch, completion, file changes, and completed items | already emitted | Existing executor events include attempt; campaign wrapping supplies exact unit identity. |
| Executor retry after gate failure or stall | already emitted | Existing `executor/retry` states attempt, source, and reason. |
| Every ordinary gate command | already emitted | Existing `gate/gate_command` records command, exit code, timeout, and attempt without output tails. |
| Merge baseline test-count gate | not emitted at all | It now uses the merge unit's reporter with `scope=merge-baseline`, including attempt 0 and exact merge identity. |
| Diff production and empty/produced decision | already emitted | Existing `diff/start`/`finish` records the decision and diff artifact. |
| Correctness verifier pass | already emitted | Existing `verify/start`/`finish` records pass, exit, verdict/source, consistency, usage, and unit identity. |
| Intent verifier pass | already emitted | Same contract as correctness with `pass=intent`. |
| Combined verifier verdict | already emitted | Existing `verify/verdict` records the fail-safe merge result. |
| Merge unit as a scheduled full run | already emitted | `unit/start`/`finish` already distinguished it with `unitKind=merge`. |
| Merge context, Git merge, conflict ledger, and resolution decision | not emitted at all | Campaign `merge/start`/`finish` exposes context/test-floor choice; unit events expose each advance, conflict, ledger reasoning, resolution, or failure. |
| Stall watchdog | already emitted | `*/stalled` includes gap and last event. The watchdog's event is re-enveloped by the unit reporter, so campaign identity is preserved. |
| Run-facts/report generation | already emitted | Existing `report/start`/`finish` names both artifacts. |
| Offline journal generation | not emitted at all | Optional `journal/start`/`finish` reporting was added; campaign facts or an explicit identity attribute the journal to its unit. A broken sink remains disposable. |
| Unit pending/in-flight/completed lifecycle | already emitted | `unit/start`/`finish` remain exact-unit records. |
| DAG waiting and release | already emitted | `unit/waiting` and `unit/released` name their predecessor(s) and selected base. |
| Failed-predecessor skip and budget non-dispatch | already emitted | `unit/skipped` and `unit/not_dispatched` retain blocking reason and exact identity. |
| Candidate generation and assigned perspective | not emitted at all | `planner/candidate_generated` records task, perspective, and whether it was explicitly declared. `--perspective` supplies one per CLI task; absence is visible as `not-declared`, never silently inferred. |
| Reviews received by the planner | not emitted at all | One `planner/review_received` per dispatched unit retains both findings/verdict sources plus `expected`, `complete`, and `missing`, so an absent review is data rather than silence. |
| Synthesis choice and reasoning | not emitted at all | `planner/synthesis` follows all review records and precedes round end. A supplied synthesis callback sees declaration-ordered reviews; the default explicitly decides to return attributed reviews. Both paths require a non-empty decision and reasoning. |

## Enforced contracts

`EVENT_STAGES`, `EVENT_TYPES`, and the explicit valid `EVENT_PAIRS` remain frozen. The full
exercise compares emitted pairs for set equality with `EVENT_PAIRS`. It exercises healthy
run stages, a retry, candidate planning, release, skip, budget non-dispatch, merge context,
and real journal generation. The only seven allowlisted pairs are watchdog stalls that
require deliberately hanging a stage; each has a written reason and the test asserts the
allowlist's exact size. A temporary `future-stage/start` declaration is then added and is
proved to fail as missing.

The aggregate stream has its own frozen `CAMPAIGN_EVENT_PAIRS`. Successful, failed-DAG,
budget, and merge campaigns together must equal that set exactly, including every unit
transition and both round boundaries. This prevents detailed unit events from accidentally
being redirected to the shared writer.

Attribution is tested with two concurrently in-flight units of different kinds. Every
unit-scoped campaign event and every event in each unit sink must map to the right unit, and
planner review events for both units are positive controls. Event construction also rejects
half-identities such as a non-null `unitId` with null `unitKind`.

## Consumer evidence and dashboard decision

- The campaign writer is read and parsed after every real append while the campaign is still
  running. Appending an incomplete final JSON record leaves every completed NDJSON record
  readable.
- `loop status <campaign-directory>` detects `campaign-events.jsonl`, reports rounds,
  synthesis, and every unit separately, tolerates a partial final record, and is byte-for-byte
  read-only.
- The checked-in Logdy handlers are executed in the test suite against an event produced by
  `createEvent`. Campaign, round, unit, kind, perspective, decision, reasoning, and scope all
  render their actual enriched values.

**Finding: a flat Logdy view is no longer adequate as the primary view for a concurrent
campaign. A purpose-built campaign state view is warranted.** Filtering the enriched columns
makes individual records inspectable, but reconstructing current state for several units,
two reviews per unit, merge preparation, and the planner synthesis still requires mentally
joining interleaved rows. The existing side-by-side run dashboard helps with unit detail but
does not present the campaign planner's state. Building that state view remains out of scope
for this change.
