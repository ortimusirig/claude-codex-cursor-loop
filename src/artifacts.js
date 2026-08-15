// Files written by the harness inside an isolated worktree. Keep this list central:
// every Git staging/diff operation must exclude the same paths.
export const HARNESS_ARTIFACTS = Object.freeze([
  'TASK.md',
  'CHANGES.diff',
  'ccc-report.md',
  'ccc-runfacts.json',
  'ccc-github.json',
  'ccc-merge-resolutions.json',
  'events.jsonl',
  'campaign-events.jsonl',
]);
