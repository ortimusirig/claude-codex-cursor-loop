export const CLI_COMMANDS = Object.freeze([
  'run', 'batch', 'status', 'dashboard', 'publish', 'doctor', 'init', 'help',
]);

export const CLI_USAGE = `Usage:
  node bin/loop.js run --task <plan-file-or-prose> --target <directory> --gate <gate.json> [--gate-retries <0-3>] [--executor-model <model>] [--executor-effort <effort>] [--verifier-model <model>] [--port <0-65535>] [--open] [--no-dashboard] [--quiet]
  node bin/loop.js batch --task <plan> [--task <plan> ...] --target <directory> --gate <gate.json> [--gate-retries <0-3>] [--executor-model <model>] [--executor-effort <effort>] [--verifier-model <model>] [--concurrency <1-16>] [--token-budget <tokens>] [--rounds <1-3>] [--round <number> ...] [--unit-kind <candidate|node|merge> ...] [--unit-id <id> ...] [--perspective <name> ...] [--depends-on <child=parent> ...] [--campaign <file>] [--port <0-65535>] [--open] [--no-dashboard] [--quiet]
  node bin/loop.js status <run-or-campaign-directory>
  node bin/loop.js dashboard [<run-directory> | --run <run-directory> | --scratch-root <directory>] [--port <0-65535>]
  node bin/loop.js publish <completed-run-directory>
  node bin/loop.js doctor [--deep] [--scratch-root <directory>] [--repository <directory>]
  node bin/loop.js init <directory>
  node bin/loop.js help

Commands:
  run        Execute one isolated Codex/gate/Cursor pass with a live read-only dashboard.
  batch      Execute one or more isolated plans as a campaign with a live dashboard.
  status     Read human-readable status for a run or campaign.
  dashboard  Serve the optional read-only local dashboard.
  publish    Optionally publish a completed run through GitHub.
  doctor     Check prerequisites; --deep spends agent tokens on write/read probes.
  init       Create a starter plan.md and runnable gate.json without overwriting.
  help       Print this usage. --help and -h are aliases.`;
