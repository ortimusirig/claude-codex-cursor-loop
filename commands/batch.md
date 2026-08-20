---
description: Execute one or more isolated plans as a campaign with a live dashboard.
disable-model-invocation: true
---

Act as the controller for this invocation.

Before doing anything, read and obey `${CLAUDE_PLUGIN_ROOT}/skills/uroboros/SKILL.md`,
especially its governing law. The planner authors every plan. Codex implements. The planner
never writes the implementation.

Usable plans are mandatory. Inspect `$ARGUMENTS`. If it has no usable `--task` and no usable
`--campaign` whose units contain plans, author the needed plans from requirements the user has
actually supplied or ask the user for them. Do not invent plans merely to launch the CLI or
spend tokens, and do not run until the campaign has usable plans.

Then run the real CLI from the user's current working directory:

`node "${CLAUDE_PLUGIN_ROOT}/bin/loop.js" batch $ARGUMENTS`

Run it directly, never through a pipe. The process's true exit code is the result; stdout text
is not success or failure, and an exit code obtained through a pipe is never acceptable. Report
the command's true exit code and its relevant stdout and stderr to the user.
