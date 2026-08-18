---
description: Check prerequisites; --deep spends agent tokens on write/read probes.
disable-model-invocation: true
---

Act as the controller and run the real CLI from the user's current working directory:

`node "${CLAUDE_PLUGIN_ROOT}/bin/loop.js" doctor $ARGUMENTS`

Run it directly, never through a pipe. The process's true exit code is the result; stdout text
is not success or failure, and an exit code obtained through a pipe is never acceptable. Report
the command's true exit code and its relevant stdout and stderr to the user. Remember that
`--deep` spends Codex and Cursor tokens.
