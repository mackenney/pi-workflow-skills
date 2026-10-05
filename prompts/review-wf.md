---
description: Competitive review → fact-check → fix loop via review-factcheck-fix.js
argument-hint: "<base-ref> [max-rounds] [diversity-model]"
---
`<skills>` is `$PI_WORKFLOW_SKILLS_DIR` when set (check with `printenv PI_WORKFLOW_SKILLS_DIR`), else `/home/ignacio/pr/pi-workflow-skills`. Run `<skills>/workflows/review-factcheck-fix.js` via `subagent({ workflow: "<that path>", args, async: true })` in the current repo. Args: `target` = "changes $1..HEAD in <absolute repo path>", `repo` = absolute repo path, `baseRef` = `$1` resolved to a sha, `reviewDir` = a fresh directory under the plan dir (or `/tmp/review-<timestamp>` if there is no plan), `maxRounds` = `${2:-2}`, and `diversityModel` = `$3` only if given.

Report the returned `state`, per-round `reviewClass`/`fcClass`, and any `pendingDecisions` (add them to PROGRESS.md if a plan is active).
