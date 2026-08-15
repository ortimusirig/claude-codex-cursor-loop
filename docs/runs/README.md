# CCC run journal

Each generated `docs/runs/<runId>.md` note is a durable view of one completed isolated run.
The generator is offline: it reads `ccc-runfacts.json` plus the sibling `events.jsonl` when
present, and it never runs as part of `loop run`.

Generate one note or rebuild every discoverable run below a scratch root from the repository
root:

```powershell
node bin/generate-run-journal.js "C:/ccc/w/<runId>/w"
node bin/generate-run-journal.js --all "C:/ccc/w"
```

Generation is re-runnable. Identical input artifacts produce byte-identical Markdown, with
no generation timestamp. The note date comes from an explicit `date` in the facts when one
exists, otherwise from the date-prefixed `runId` written by the loop.

## Frontmatter schema

These property names are stable because Obsidian Bases treats them as campaign-table columns.

| Property | Type | Meaning |
| --- | --- | --- |
| `runId` | text | Unique run identifier and generated note name. |
| `date` | date | Calendar date carried by the run facts. |
| `outcome` | text | Overall loop outcome, such as `review-ready` or `gate-failed`. |
| `gateStatus` | text | Final gate state. |
| `verdict` | text or null | Verdict merged across the correctness and intent passes. |
| `intentVerdict` | text or null | Intent/assertion-audit pass verdict. |
| `verdictSource` | text or null | Correctness-verdict provenance retained in the facts. |
| `tokensTotal` | number | Total input plus output tokens from `tokens.total`, without double-counting cached or reasoning subsets. |
| `branch` | text or null | Isolated branch created for the run. |
| `filesChanged` | list of links | Deduplicated `[[wikilinks]]` from facts and executor file-change events. |

Free-text executor reasoning, correctness findings, intent findings, verifier plan artifacts,
and gate output remain in the note body. They are deliberately excluded from frontmatter so
colons, quotes, and multiline diagnostics cannot change the schema.

## Campaign table

With the repository open as an Obsidian vault and the Bases core plugin enabled, the block
below renders the campaign table in this note. It can also be copied verbatim into another
note, or its contents can be saved as a `.base` file.

```base
filters:
  and:
    - file.inFolder("docs/runs")
    - file.ext == "md"
    - runId != null
properties:
  runId:
    displayName: Run
  date:
    displayName: Date
  outcome:
    displayName: Outcome
  gateStatus:
    displayName: Gate
  verdict:
    displayName: Verdict
  intentVerdict:
    displayName: Intent verdict
  verdictSource:
    displayName: Verdict source
  tokensTotal:
    displayName: Tokens
  branch:
    displayName: Branch
  filesChanged:
    displayName: Files changed
views:
  - type: table
    name: Campaign runs
    order:
      - runId
      - date
      - outcome
      - gateStatus
      - verdict
      - intentVerdict
      - verdictSource
      - tokensTotal
      - branch
      - filesChanged
    sort:
      - property: date
        direction: DESC
```
