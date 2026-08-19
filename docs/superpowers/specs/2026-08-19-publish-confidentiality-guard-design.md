# Publish confidentiality guard

`publish` is the only command that moves content off the operator's machine. This design
adds a guard that runs before anything is sent, and refuses to publish when it finds
credentials or confidential identifiers.

## Why

`publish` sends more than the branch. `buildPullRequestContent` assembles a pull-request
body from the executor rationale, both verifier passes' findings, and both passes' report
artifacts, and derives the pull-request title from the first non-empty line of `TASK.md`.
Verifier reports quote code and file paths directly. The branch itself carries whatever the
executor wrote.

Two exposures follow. A credential committed into the target repository reaches GitHub with
the branch. A confidential identifier — a client name in a plan's `Title:` line, or quoted
inside a verifier report — reaches GitHub in the pull-request body or a review comment.

Neither is hypothetical for this project's own use: skills built earlier in this workstream
required a blocklist gate precisely because client names must not leave the machine.

Nothing currently checks either surface. `publish` validates that both verdicts and their
sources exist and stops otherwise, so the veto shape already exists; this design adds a
second condition to it.

## Scope

In scope: a guard invoked by `publish` before any network call, covering the two surfaces
`publish` exposes.

Out of scope: scanning during `run` or `batch`; any change to what `publish` sends when the
guard passes; any change to the executor, gate, or verifier seats; retroactive scanning of
runs already published.

## Placement

A new module, `src/publish-guard.js`, exporting one function that takes the run directory,
the assembled pull-request content, and injected command runners, and returns a structured
result. `publishRun` calls it after `buildPullRequestContent` and before
`prepareAndPushBranch` — that is, after the content exists to be scanned and before the
first `git push` or `gh` invocation.

The guard performs no network calls of its own and writes nothing outside a temporary file
it removes.

## Surfaces

**Code surface.** The run's worktree, as it would be pushed. This is where a hardcoded
credential actually lives, and it is the higher-severity of the two.

**Prose surface.** The exact content `publish` would post: the pull-request title, the
executor rationale, and for each verifier pass its findings and its report artifact. The
guard assembles these into a single temporary file so a file-oriented scanner can read it,
and deletes that file when finished, including on failure.

The prose surface is assembled from the same values `buildPullRequestContent` produces, not
re-derived, so the guard cannot drift from what is actually sent.

## Checks

### Gitleaks — blocking

Detects credentials by pattern across both surfaces. Chosen as the blocking scanner because
it is fast enough for an interactive path, performs no network calls, and blocks anything
key-shaped regardless of whether the credential is still live. That bias is correct for a
gate: a revoked credential committed to a repository must still stop a publish.

Invoked as an external binary. It is not an npm dependency, so the package's zero-runtime-
dependency invariant is unaffected.

### TruffleHog — advisory

Runs over both surfaces with its full detector set and reports findings without blocking.
It is not run with `--only-verified`: that flag reports only credentials confirmed live by
calling the provider's API, which both misses format-valid unverified keys and transmits
detected secrets to third parties. Unverified mode gives broader detection than the blocking
scanner without either drawback.

Advisory because its broader detection carries more false positives than a blocking path
should impose. Its findings are surfaced so the operator can act on them.

### Blocklist — blocking

A newline-delimited file of confidential identifiers — client names and similar — supplied
out of band through an environment variable, scanned case-insensitively across both
surfaces. No credential scanner can know that a particular company name matters; only the
operator can state that.

The blocklist file is deliberately not stored in the repository. Writing the list of
confidential names into the repository in order to detect confidential names would publish
the very thing it guards.

### Contextual review — blocking

One Cursor pass over the prose surface only, judging whether the content exposes personal
data, customer identity, or internal detail that patterns cannot recognise. Read-only, in
the same plan mode the verifier seats already use.

Prose only: the code surface is the change the operator intends to ship, and subjecting it
to a contextual-confidentiality opinion would duplicate the correctness and intent seats.

## Enforcement

The guard fails closed.

- Any finding from Gitleaks, the blocklist, or the contextual review aborts `publish` before
  any network call, naming each finding, its surface, and where it occurred.
- Gitleaks absent, not executable, or erroring: refuse. A check that silently skips is worse
  than no check, because it reads as safety that was never applied.
- Blocklist unreadable or its environment variable unset: refuse, matching the fail-closed
  behavior of the skill-repository gate this mechanism comes from.
- Contextual review failing to launch or producing no usable verdict: refuse. The engine
  already refuses to downgrade a verifier launch failure into a verdict; the guard follows
  that rule.
- TruffleHog absent or erroring: warn and continue. It is advisory, so its absence removes
  advice rather than protection. Its absence must be stated in the output, not silent.

No override flag. If experience shows one is needed, adding it later is a deliberate
decision; leaving one now is an unguarded hole.

A refusal leaves the run directory unchanged, exactly as a failed publish does today.

## Reporting

On refusal, the guard prints each finding with its surface, its source check, and enough
location detail to act on. Secret values are never echoed, only their location and the rule
that matched — printing a detected credential into a terminal or a log would create a new
copy of the thing being protected.

On success, it prints a one-line summary naming which checks ran, so a passing publish
states what was verified rather than being silent.

## Testing

Every external command and the Cursor invocation are injected, so no test spawns a real
binary, makes a network call, or spends tokens.

- A planted credential-shaped string in the code surface blocks, naming the surface.
- A planted credential-shaped string in the prose surface blocks, naming the surface.
- A blocklist term planted in the pull-request title blocks.
- A contextual-review finding blocks.
- A TruffleHog-only finding does **not** block, and is reported.
- A clean run publishes normally. This is the positive control: without it, every blocking
  assertion above would also pass against a guard that refuses unconditionally.
- Each fail-closed refusal has its own case: Gitleaks missing, blocklist unset, blocklist
  unreadable, contextual review unavailable.
- TruffleHog missing warns and proceeds, paired with the TruffleHog-finding case so the two
  outcomes are proven distinct.
- The temporary prose file is removed on both the passing and refusing paths.
- No test depends on `process.cwd()`, the checkout location, or the run time.

## Consequences

`publish` gains two required external binaries for its blocking path — Gitleaks and a
readable blocklist — and one optional binary. That raises the cost of publishing on a fresh
machine. It is a deliberate trade: `publish` is the only command that can expose content,
and it is invoked rarely and deliberately.

`doctor` should report the new prerequisites so their absence is discoverable before a
publish is attempted rather than at the moment of refusal. That is a follow-on change, not
part of this design.
