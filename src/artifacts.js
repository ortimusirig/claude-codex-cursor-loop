import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Files written by the harness inside an isolated worktree. Keep this list central:
// every Git staging/diff operation must exclude the same paths. Both prefixes are listed
// so a run directory created before the rename is still excluded.
export const HARNESS_ARTIFACTS = Object.freeze([
  'TASK.md',
  'CHANGES.diff',
  'uro-report.md',
  'uro-runfacts.json',
  'uro-github.json',
  'uro-merge-resolutions.json',
  'ccc-report.md',
  'ccc-runfacts.json',
  'ccc-github.json',
  'ccc-merge-resolutions.json',
  'events.jsonl',
  'campaign-events.jsonl',
]);

// Read either prefix; write only the current one.
export function resolveArtifact(directory, basename) {
  const current = join(directory, basename);
  if (existsSync(current)) return current;
  const legacy = join(directory, basename.replace(/^uro-/, 'ccc-'));
  if (legacy !== current && existsSync(legacy)) return legacy;
  return current;
}
