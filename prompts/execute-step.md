---
description: Execute one plan step via execute-step.js, then apply its ledger
argument-hint: "<plan-dir> <step-file> [pr]"
---
`<skills>` is `$PI_WORKFLOW_SKILLS_DIR` when set (check with `printenv PI_WORKFLOW_SKILLS_DIR`), else `/home/ignacio/pr/pi-workflow-skills`. Load the `executor` and `step-contract` skills. Run `<skills>/workflows/execute-step.js` via `subagent({ workflow: "<that path>", args, async: true })`, args: `planDir` = absolute `$1`, `stepFile` = absolute `$2`, `baseCommit` = current `git rev-parse HEAD`, and `pr: $3` only if a PR number was given (`${3:-}`).

On return, apply the `ledger` object to PROGRESS.md yourself per the executor skill's Ledger Duty before anything else, then report per its Reporting section.
