# Using this skill on another system

The package itself is trivially portable: ~123 KB, 28 files, **zero runtime dependencies**
(only Node builtins), no compilation, no `npm install`, no PowerShell or bash. Everything
below is about the *environment* it drives, not the package.

## 1. Prerequisites on the new machine

| Requirement | Why | How to check | How to install |
|---|---|---|---|
| **Node ≥ 24** | the skill's runtime | `node --version` | nodejs.org (LTS ≥24) |
| **git** | isolation (worktree / init) | `git --version` | git-scm.com |
| **Codex CLI** | the executor seat | `codex --version` | `npm i -g @openai/codex`, then sign in |
| **Cursor Agent CLI** | the verifier seat | `agent --version` | install Cursor, then `agent login` |
| **Claude Code** | the controller seat | — | claude.ai/code |

**The binary is `agent`, not `cursor-agent`** (on Windows it lands at
`%LOCALAPPDATA%\cursor-agent\agent.cmd`).

### Authentication is per-machine and per-vendor
The skill stores **no credentials** and passes none. Each CLI authenticates itself with its
own subscription on that machine:
- **Codex** — sign in with your ChatGPT/OpenAI account (`codex` prompts on first run).
- **Cursor** — `agent login` (browser flow; run it in a real terminal, not inside an agent).
- **Claude Code** — its own sign-in.

Cost follows those subscriptions. Nothing is billed through the skill.

## 2. Transfer the package

Copy the whole `run-claude-codex-cursor-loop-v2` folder to the new machine by any means —
USB, OneDrive, `scp`, a git remote, or the zip bundle (`ccc-loop-portable.zip`).

## 3. Install

From inside the copied folder:

```
node install.mjs
```

It copies the payload to `~/.claude/skills/run-claude-codex-cursor-loop`, verifies **every
file by SHA-256**, runs the self-test **from the installed location**, and reports whether
`git` / `codex` / `agent` are present. A non-zero exit means it did not install cleanly.

Options: `--dry-run` (preview only), `--name <x>` (install under a different skill name,
e.g. to run side-by-side with an existing install).

## 4. Platform notes

- **Windows** is the primary, fully-exercised target. `.cmd` shims (`codex.cmd`,
  `agent.cmd`) are handled via `cmd.exe` with verbatim quoting — spaces in paths are safe.
- **macOS / Linux** should work (pure Node, POSIX `which`, plain `spawn`), but the loop has
  only been run end-to-end on Windows. Treat the first run on a Unix box as verification.
- **Scratch root** defaults to `C:/ccc/w` on Windows and `~/.ccc/w` elsewhere. Override with
  the `CCC_SCRATCH_ROOT` environment variable.
- The scratch root must **not** sit under `AppData` or `OneDrive` — the installer's own
  guard rejects those (AppData is MSIX-redirected under a packaged host; OneDrive syncs and
  lengthens paths). This is enforced, not advisory.

## 5. Verify it works on the new machine

```
node "<skills>/run-claude-codex-cursor-loop/bin/loop.js" run --task plan.md --target <folder> --gate gate.json
```

A minimal smoke test — a `plan.md` saying "create hello.txt containing HELLO WORLD", a
`gate.json` of `[{"bin":"node","args":["-e","process.exit(require('fs').existsSync('hello.txt')?0:1)"]}]`,
and any throwaway folder as `--target`. Expect `outcome: review-ready`, `gateStatus: passed`,
and a `verdict`. Your target folder is never modified — the work lands in the isolated copy.

## 6. Known first-run gotchas

- **`where codex` may list an extensionless npm shim first** — handled (the resolver prefers
  a PATHEXT-executable variant).
- **Cursor needs `--trust`** to clear its workspace-trust gate, or it exits 1 with empty
  output and every review silently falls back to `ISSUES`. Already on the launch line.
- **Codex must trust the isolated directory to write.** Verified working with
  `-s workspace-write` and the user config intact. Never pass `--ignore-user-config` — it
  discards the project trust registry and Codex silently goes read-only.
