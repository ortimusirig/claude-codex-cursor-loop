# uroboros

[![tests](https://github.com/ortimusirig/uroboros/actions/workflows/tests.yml/badge.svg)](https://github.com/ortimusirig/uroboros/actions/workflows/tests.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen) ![runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)

Codex writes in a git-isolated copy, command exit codes gate the change, and Cursor reviews it read-only.

### If you are an AI agent setting this up for someone

Follow [`skills/uroboros-setup/SKILL.md`](skills/uroboros-setup/SKILL.md), the single source of
truth for the bootstrap procedure. If this README is all you have, fetch the skill directly:
<https://raw.githubusercontent.com/ortimusirig/uroboros/main/skills/uroboros-setup/SKILL.md>.

Expected order:

1. Verify Node 24 or newer, git, the Codex CLI, and the Cursor CLI.
2. With the operator's consent, install anything missing.
3. Have the operator complete the two browser sign-ins.
4. Install the plugin.
5. Restart the Claude Code session so its slash commands register.
6. Run the demo pass.

## Install

Run these two commands inside Claude Code (not a terminal):

```text
/plugin marketplace add ortimusirig/uroboros
/plugin install uroboros@uroboros
```

No clone or local installer is needed to use the plugin.

## First run

Plugin slash commands do not register in a Claude Code session that was already running when
the plugin was installed. After `/plugin install`, restart the Claude Code session, then run:

```text
/uroboros:setup
```

`setup` is the guided path. It checks everything the loop needs and, once the prerequisites are
green, scaffolds a throwaway demo project and executes one real pass against it. You finish
having watched an isolated worktree, a green gate, a verifier verdict and a real diff, rather
than having ticked off a checklist. The demo is written under the scratch root, never into a
project of yours.

Re-running `setup` is safe: it re-checks and skips whatever is already green.

**Two things nothing can do for you: signing in to Codex, and signing in to Cursor.** Both are
interactive browser flows owned by those CLIs. In a terminal with a TTY, `setup` waits while the
operator completes them and then re-checks. Inside Claude Code there is no TTY, so `setup`
reports its `NEEDS:` summary and exits non-zero; complete the sign-ins in a terminal, then run
`/uroboros:setup` again.

If you would rather look before anything touches your machine, `/uroboros:doctor` runs the
same checks, changes nothing, and spends no agent tokens. Add `--fix` to have it offer the
same consented installs, or `--deep` to spend a few tokens proving the signed-in Codex CLI
can actually write and the signed-in Cursor CLI can actually read.

## What you need

**Node 24+, git, the Codex CLI, and the Cursor Agent CLI, with Codex and Cursor each signed
in under its own account.** `setup` and `doctor` check all of these and name what is missing,
so you should not need this section — it is here for doing it yourself, or for when something
went wrong.

One detail that catches people out: the Cursor binary is `agent`, not `cursor-agent`. Follow the
[bootstrap skill](skills/uroboros-setup/SKILL.md) for installation and remediation details.

**Everything else is optional.** GitHub publishing, Logdy, and the offline Obsidian journal
are separate add-ons. A machine with none of them has a fully working loop.

`init` creates two starter inputs without overwriting existing files. `plan.md` tells Codex
what result to produce and what must not change. `gate.json` is a JSON list of commands whose
exit codes decide whether the result passes. Replace the generated prompts and placeholder
gate with the real task and project checks before relying on the result.

## How the loop works

One `loop run` is one pass:

```
plan.md ──► Codex writes (isolated copy) ──► gate (exit codes) ──► Cursor verifies (read-only) ──► report
```

Your target folder is never modified. Work lands on a branch in an isolated copy, and you
review a diff.

## Why this shape

Three separate failure modes get three separate seats:

- **Codex writes but cannot mark its own homework.** It never decides whether it succeeded.
- **The gate is the only thing that can pass a change.** It runs your commands and reads
  exit codes. An agent cannot argue with a non-zero exit.
- **Cursor reviews read-only** (`--mode plan`), and only when there is a non-empty diff.
  Write flags are asserted absent, not merely omitted.

The loop refuses to report success over a red gate. If the verifier fails to launch, that is
reported as `verifier-failed` — never silently downgraded to a review verdict.

**No credentials are stored or passed by this package.** Each CLI authenticates itself on
your machine with your own subscription, and cost follows those subscriptions. Nothing is
billed through this skill.

Windows is the primary, fully-exercised target. macOS and Linux should work — pure Node,
POSIX `which`, plain `spawn` — but treat the first Unix run as verification.

After plugin installation, these are the nine namespaced slash commands:

```text
/uroboros:run
/uroboros:batch
/uroboros:status
/uroboros:dashboard
/uroboros:publish
/uroboros:doctor
/uroboros:setup
/uroboros:init
/uroboros:help
```

Each is a prompt to the Claude Code controller, not a shell alias. It asks the controller to run
the corresponding real CLI command with the supplied arguments and report the child process's
true exit code. The controller must not infer success from stdout or read an exit status through
a pipe. The `run` and `batch` prompts explicitly load the governing skill law and require a
usable plan before spending tokens.

## Usage

```sh
node bin/loop.js run --task plan.md --target . --gate gate.json
```

For the full command surface, every flag, campaign shapes, outcomes, and configuration, see
[docs/usage.md](docs/usage.md). For GitHub publishing and the confidentiality guard, see
[docs/publishing.md](docs/publishing.md).

## Smoke test

A `plan.md` saying *"create hello.txt containing HELLO WORLD"*, this `gate.json`:

```json
[{ "bin": "node", "args": ["-e", "process.exit(require('fs').existsSync('hello.txt')?0:1)"] }]
```

and any throwaway folder as `--target`. Expect `outcome: review-ready`, `gateStatus: passed`,
and a verdict.


## Known gotchas

- **Cursor needs `--trust`** to clear its workspace-trust gate. Without it, it exits 1 with
  empty output and every review silently falls back to `ISSUES`. Already on the launch line.
- **Never pass `--ignore-user-config` to Codex.** It discards the project trust registry and
  Codex silently goes read-only — it appears to work and writes nothing.
- **`where codex` may list an extensionless npm shim first.** Handled: the resolver prefers a
  PATHEXT-executable variant.

## Contributor/development setup

This checkout path is only for people who intend to work on the project. If you only intend to
use uroboros, follow the marketplace install above instead of cloning the repository.

```sh
git clone https://github.com/ortimusirig/uroboros.git uroboros
cd uroboros
node install.mjs
node bin/loop.js doctor
node bin/loop.js init ../uroboros-demo
node bin/loop.js run --task ../uroboros-demo/plan.md --target ../uroboros-demo --gate ../uroboros-demo/gate.json
```

`node install.mjs` is a verifier, not a plugin installer. It validates the manifests, command and
skill layout, and payload; runs the full self-test from the checkout; reports CLI availability;
prints the two local-checkout `/plugin` commands; and finishes with `PLUGIN_STATUS=PREPARED`. It
never writes Claude Code's marketplace, plugin, or settings state. `--dry-run` performs validation
without running the self-test. CI runs that dry-run validation on every push and pull request.

If `~/.claude/skills/uroboros` or the superseded personal-skill directory exists, the verifier
warns about the duplicate, names the path, and prints the exact platform removal command. It never
removes either directory.

```
node --test
```

The test suite has zero runtime dependencies and no build step. `fixtures/` holds real captured
`codex` and `cursor-agent` NDJSON streams so the parsers are tested against actual vendor
output rather than invented shapes.

See [PORTING.md](PORTING.md) for moving this to another machine.

## License

MIT — see [LICENSE](LICENSE).
