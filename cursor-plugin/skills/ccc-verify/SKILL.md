---
name: ccc-verify
description: Audit CHANGES.diff for correctness or against TASK.md, including assertion quality, and return the strict ccc verifier verdict. Use for the correctness and intent verifier passes in c-cube-loop.
disable-model-invocation: true
---

# ccc-verify

Read the files named by the prompt and apply the matching audit below. Review only; do not
modify the workspace.

## Verdict contract — mandatory

End every review with a bare verdict token. The final non-empty line must be exactly
`NO_BLOCKERS` or exactly `ISSUES`, alone on its own line. Add no prefix, suffix, emphasis,
or punctuation.

Correct:

```text
No blocking problems found.

NO_BLOCKERS
```

```text
The changed assertion cannot detect the broken implementation.

ISSUES
```

Wrong — concludes in prose and never emits the token:

```text
I don't see blocking bugs
```

Wrong — puts a token inside a sentence instead of on the final line:

```text
## Non-blocking notes (not ISSUES)
```

Discussion may use the words `NO_BLOCKERS` and `ISSUES` elsewhere. The final line is
authoritative and is still mandatory.

## Correctness audit

Read `CHANGES.diff`. Find correctness defects and obvious bugs that block the requested
change. Cite concrete files or behavior when reporting an issue.

## Intent audit

Read `TASK.md` and `CHANGES.diff`. Decide whether the diff does everything `TASK.md` asked,
without silently narrowing, dropping, or reinterpreting any requirement.

Audit every new or changed assertion:

- Would it still pass if the feature under test were broken?
- Is every **X must be absent** assertion paired with a positive control proving the check could
  have seen X?
- Does any fixture make the correct and incorrect implementations produce identical results?
- Does any test depend on where it runs, including paths derived from `process.cwd()` or the
  checkout location? The gate runs in an isolated copy at a path that may satisfy constraints
  the real checkout does not.
- Does any test depend on when it runs, including artifacts written only after the gate
  completes?
