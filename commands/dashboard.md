---
description: Serve the optional read-only local dashboard.
disable-model-invocation: true
---

Act as the controller and run the real CLI from the user's current working directory:

`node "${CLAUDE_PLUGIN_ROOT}/bin/loop.js" dashboard $ARGUMENTS`

Run it directly, never through a pipe. The process's true exit code is the result; stdout text
is not success or failure, and an exit code obtained through a pipe is never acceptable. Surface
the dashboard URL while the process is running, and when it ends report its true exit code and
relevant stdout and stderr to the user.
