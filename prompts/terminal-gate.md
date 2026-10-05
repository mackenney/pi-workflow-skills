---
description: Run the fail-closed terminal gate on a plan (ledger rows + optional CI)
argument-hint: "<plan-dir> [pr]"
---
`<skills>` is `$PI_WORKFLOW_SKILLS_DIR` when set (check with `printenv PI_WORKFLOW_SKILLS_DIR`), else `/home/ignacio/pr/pi-workflow-skills`. Run `<skills>/workflows/terminal-gate.js` via `subagent({ workflow: "<that path>", args, async: true })` with args `planDir` = absolute `$1`, and `pr: $2` only if given (`${2:-}`). Report the JSON verbatim. If `ok` is false, execute any listed `openSteps` (they are unfinished work, not human decisions); for each open ledger row, ask the human to discharge or waive it — do not write waivers yourself and do not describe the plan as complete.
