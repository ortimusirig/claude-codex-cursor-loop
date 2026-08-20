# Moving uroboros between machines

Installation and first-run commands live in [README.md](README.md). The details below are
the machine-specific state that does not move with a copied checkout or installed skill.

## Authentication is per machine

uroboros stores and transfers no credentials. On every new machine, sign the Codex CLI in
with its own ChatGPT/OpenAI account and run `agent login` for the Cursor Agent CLI with its
own Cursor account. Both use interactive browser flows, so run them in a real terminal; an
installer or copied configuration cannot complete them. Cost follows those subscriptions.

Run `node bin/loop.js doctor` to check the local programs and get a specific fix for anything
missing. Run `node bin/loop.js doctor --deep` when you want to spend agent tokens proving
that Codex can write and Cursor can read on that machine.

## Platform notes

- **Windows** is the primary, fully exercised target. `.cmd` shims such as `codex.cmd` and
  `agent.cmd` are launched through `cmd.exe` with verbatim quoting, including paths with
  spaces.
- **macOS and Linux** use only Node built-ins, POSIX `which`, and plain process spawning, but
  have not had the same end-to-end coverage. Treat the first run on a Unix machine as a
  platform verification.
- The Cursor binary is `agent`, not `cursor-agent`. On Windows it normally lives below
  `%LOCALAPPDATA%\cursor-agent\`.

## Scratch root

Run state is machine-local. The scratch root defaults to `C:/uro/w` on Windows and
`~/.uro/w` elsewhere; set `URO_SCRATCH_ROOT` to override it on the new machine.

The scratch root must not be inside AppData or OneDrive. uroboros rejects those locations:
AppData can be redirected by packaged hosts, while OneDrive can synchronize partial writes
and create paths long enough to break tools. Choose a short, writable, local path instead.
