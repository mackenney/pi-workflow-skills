---
description: Execute a wave of independent atomic steps via execute-wave.js (isolated worktrees)
argument-hint: "<plan-dir> <step-file>..."
---
`<skills>` is `$PI_WORKFLOW_SKILLS_DIR` when set (check with `printenv PI_WORKFLOW_SKILLS_DIR`), else `/home/ignacio/pr/pi-workflow-skills`. Load the `executor` and `step-contract` skills. Confirm the checkout is clean and the steps share no files. Run `<skills>/workflows/execute-wave.js` via `subagent({ workflow: "<that path>", args, async: true })` with args `planDir` = absolute `$1`, `stepFiles` = absolute paths of `${@:2}`, `baseCommit` = `git rev-parse HEAD`.

On return, follow the executor skill's Wave Integration section (merge PASS lanes, re-gate the integrated tree, apply ledgers), then re-run FAIL lanes through `/execute-step`.
