---
name: wf-host-command
description: Runs one allow-listed pi-workflow-skills host script (step-loader, ci-gate, terminal-gate, ledger-apply, write-artifact, commit-check, run-gates). Extracts the JSON task from the combined system/task stdin prompt and returns JSON on stdout. No model. Callers must keep stdout compact; captured output is capped at the last 64 KiB.
runner:
  type: external-cli
  command: bash
  # exec keeps stdin; PI_WORKFLOW_SKILLS_DIR lets an isolated install (e.g. a worktree) use its own scripts
  args: ["-c", "exec \"${PI_WORKFLOW_SKILLS_DIR:-/home/ignacio/pr/pi-workflow-skills}/scripts/host-command.sh\""]
  promptDelivery: stdin
async: true
systemPromptMode: replace
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
---
