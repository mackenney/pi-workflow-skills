---
description: Plan from a spec/investigation via plan-factcheck-fix.js (multi-angle or simple)
argument-hint: "<spec-or-findings-path> <plan-dir> [angles|simple]"
---
`<skills>` is `$PI_WORKFLOW_SKILLS_DIR` when set (check with `printenv PI_WORKFLOW_SKILLS_DIR`), else `/home/ignacio/pr/pi-workflow-skills`. Load the `planner` and `step-contract` skills. Then run `<skills>/workflows/plan-factcheck-fix.js` via `subagent({ workflow: "<that path>", args, async: true })`:
- `spec`: absolute path of `$1`
- `planDir`: absolute path of `$2`
- Third argument (default 3): "${3:-3}". If it is the word simple, pass `mode: "simple"` and no angles; if it is a number N, pass `angles: N`.

When it returns, write any `pendingDecisions` into PROGRESS.md "Pending decisions (human)" and report `state`, `planPath`, `factcheckClass`.
