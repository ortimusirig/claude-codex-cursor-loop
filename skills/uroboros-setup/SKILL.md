---
name: uroboros-setup
description: 'Bootstrap uroboros installation and setup from zero; use when prerequisites are missing or unproven, or when a uroboros command fails with node: command not found, command not found, executable not found, or a comparable missing-binary error.'
---

# Bootstrap uroboros

Assume nothing is installed. Use only the direct probes below until every prerequisite is green.

## Preserve true exit codes

- Run every probe alone and capture its real process exit code.
- Never report PASS from stdout alone.
- Never pipe a probe through `grep`, `findstr`, `tee`, or another command. A pipeline reports a
  trailing command's status.
- Never append `echo` or another command before capturing the probe's status; it masks the status
  being tested.

## Respect the marketplace boundary

`/plugin marketplace add` clones the repository and may require git before any uroboros artifact
exists. Nothing shipped by uroboros can repair that ordering. If marketplace installation stops on
missing git, install git outside uroboros, retry the marketplace command, then install
`uroboros@uroboros`.

## Get consent for installs

Before every install, select the command for the operator's platform, show that exact command, and
ask permission to run it. Run it only after an explicit yes. Never install silently, substitute a
different command, or combine multiple installs under one approval. Reopen the terminal after an
install and rerun its direct probe.

### Install commands

| Prerequisite | Windows PowerShell | macOS | Linux |
|---|---|---|---|
| Node | `winget install --id OpenJS.NodeJS.LTS -e --source winget` | `brew install node` | `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh \| bash`, then `. "$HOME/.nvm/nvm.sh"`, then `nvm install 24` |
| git | `winget install --id Git.Git -e --source winget` | `brew install git` | Debian/Ubuntu: `sudo apt-get install git`; Fedora: `sudo dnf install git` |
| Codex CLI | `npm.cmd install -g @openai/codex` | `npm install -g @openai/codex` | `npm install -g @openai/codex` |
| Cursor CLI | `irm 'https://cursor.com/install?win32=true' \| iex` | `curl https://cursor.com/install -fsS \| bash` | `curl https://cursor.com/install -fsS \| bash` |

The Cursor binary required by uroboros is `agent`, not `cursor-agent`. On Windows it may be a
PowerShell shim that Git Bash or another POSIX shell cannot resolve. If a POSIX-shell probe says it
is missing, repeat the probe in PowerShell before concluding that the CLI is not installed.

## Bootstrap prerequisites in order

1. Run `node --version`. Require exit 0 and parse the leading major version as 24 or newer. If the
   binary is absent or older, request consent for the platform's Node command, then re-check.
2. Run `git --version`. Require exit 0. If absent, request consent for the platform's git command,
   then re-check.
3. Run `codex --version`. Require exit 0. If absent, request consent for the platform's Codex CLI
   command, then re-check.
4. Run `codex login status`. Require exit 0. If it fails, stop and tell the operator to run
   `codex login` in a real terminal and complete its browser flow. This sign-in belongs to the
   operator and Claude cannot perform it. Wait for the operator, then rerun `codex login status`;
   never assume success.
5. Run `agent --version`. Require exit 0, applying the Windows shell caveat above. If absent,
   request consent for the platform's Cursor CLI command, reopen the terminal, then re-check.
6. Run `agent status`. Require exit 0. If it fails, stop and tell the operator to run `agent login`
   in a real terminal and complete its browser flow. This sign-in belongs to the operator and
   Claude cannot perform it. Wait for the operator, then rerun `agent status`; never assume success.
7. Choose a short, writable, local scratch root outside AppData and OneDrive: `C:\uro\w` on Windows
   or `$HOME/uro-w` on macOS/Linux. Ask before creating or configuring it. Run the matching check as
   one unpiped command; each rejects an unsafe path, proves writability, removes its probe, and
   returns a real exit code:

   - Windows PowerShell: `powershell -NoProfile -Command '$p=''C:\uro\w''; if ($p -match ''(?i)(AppData|OneDrive)'') { exit 1 }; try { $null=New-Item -ItemType Directory -Force -Path $p -ErrorAction Stop; $f=Join-Path $p (''.uro-write-test-''+[guid]::NewGuid()); [IO.File]::WriteAllText($f,''ok''); Remove-Item -LiteralPath $f -Force -ErrorAction Stop; exit 0 } catch { exit 1 }'`
   - macOS/Linux: `sh -c 'p="$HOME/uro-w"; case "$p" in *AppData*|*appdata*|*OneDrive*|*onedrive*) exit 1;; esac; mkdir -p "$p" || exit; f="$p/.uro-write-test-$$"; : > "$f" || exit; rm -f "$f"'`

   Set `URO_SCRATCH_ROOT` to that path in the operator's persistent environment, start a fresh
   terminal, and repeat the matching check. If it fails, choose another short local path or repair
   its permissions; never mark the root green from path text alone.

## Hand off

When all seven prerequisites are green, restart the Claude Code session. Slash commands do not
appear in a session that began before the plugin was installed. In the fresh session, run
`/uroboros:setup` for the demo pass.
