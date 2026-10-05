# pi-workflow-skills

A [pi](https://github.com/badlogic/pi-coding-agent) package bundling ten agentic workflow skills that form a full development pipeline:

```
investigate → spec → plan → execute → fact-check / e2e-test → code-review
```

## Skills

| Skill | Role |
|-------|------|
| `investigator` | Deploys parallel scout agents to gather ground-truth facts before any planning. Produces a structured findings report. |
| `specifier` | Writes the behavioral contract of a component (RFC 2119 MUST/SHOULD/MAY). Permanent codebase artifact that informs planners and reviewers. |
| `planner` | Produces a wave-based `PROGRESS.md` + per-step files from investigation findings. Each step has layered context and observable acceptance criteria. |
| `executor` | Drives a `PROGRESS.md` plan through `workflows/execute-step.js` / `execute-wave.js` (ledger rows written by `scripts/ledger-apply.sh`), integrates wave branches, and reports completion only when `terminal-gate.js` passes. |
| `step-contract` | Shared vocabulary for planners, workers, reviewers and fact-checkers: gate classes, sidecar schema, STEP/REVIEW-VERDICT, PROGRESS.md ledger grammar. |
| `fact-checker` | Verifies claims in any document — code reviews, investigation reports, plans, or specs — against source code, experiments, docs, git history, and web. Outputs CONFIRMED/REFUTED/UNVERIFIABLE verdicts. |
| `e2e-tester` | Exercises a spec-driven implementation end-to-end against a running stack, working narrow-to-wide until the integration surface is covered. Stops and reports on blockers rather than looping. |
| `code-reviewer` | Competitive multi-agent code review. Three independent reviewers analyze changes in parallel, then a synthesis pass produces actionable feedback. |
| `coordinator` | The entry point: compiles a prose chain into stages backed by the workflows and agents, lists what it understood, runs it, and reads only short stage envelopes (details stay in files). |
| `handoff` | Produces a controlled compaction — a handoff artifact plus a copy-paste message — before `/copy` + `/new`, a phase/agent boundary, or a worktree/subagent spin-off. |

## Install

Not published to npm. Install via local path or git URL:

```bash
pi install /path/to/pi-workflow-skills
pi install git:github.com/your-user/pi-workflow-skills
```

## Usage

Pi loads skill descriptions at startup. The agent reads the full SKILL.md on demand when a task matches. You can also force-load any skill with `/skill:name`.

The skills are designed to chain:

1. `/skill:investigator` — gather facts about the codebase or problem
2. `/skill:specifier` — write a behavioral contract (optional, for library/component work)
3. `/skill:planner` — turn findings into a `PROGRESS.md` plan
4. `/skill:executor` — execute the plan with worker/reviewer subagents
5. `/skill:fact-checker` — verify claims in the output against ground truth (optional)
6. `/skill:e2e-tester` — exercise the implementation against a running stack (optional)
7. `/skill:code-reviewer` — review the final diff before merging

## Example — coordinator-driven pipeline

Write the chain in your own words; the coordinator maps each segment to a stage (table in `skills/coordinator/SKILL.md`), prints the compiled run, and starts. Say "report after <stage>" to pause there.

```
/skill:coordinator

Add async job queue support to the worker module.

investigator -> fact-checker -> fix
specifier -> planner -> fact-checker -> fix
executor
(code-reviewer -> fact-checker -> fix) x3 early stop 2 clean rounds
e2e-tester
```

**How the coordinator reads this:**

| Phase | What happens |
|-------|-------------|
| `investigator -> fact-checker -> fix` | investigate (parallel scouts + merge) → fact-check-doc → fix, as single-agent stages. |
| `specifier -> planner -> fact-checker -> fix` | spec (single-agent) → plan: `plan-factcheck-fix.js` (planner angles, synthesis under `validate-plan`, fact-check and fix built in). |
| `executor` | `execute-step.js` / `execute-wave.js` per wave (runtime-executed gates, typed verdicts, ledger by script), then `terminal-gate.js`. |
| `(code-reviewer -> fact-checker -> fix) x3` | `review-factcheck-fix.js` with `maxRounds: 3` (cross-examined angles, synthesis, fact-check, fix); it stops at the first clean round, and the coordinator re-runs it for "2 clean rounds". |
| `e2e-tester` | Exercises the implementation against a running stack, narrow-to-wide, and reports any spec gaps or integration failures. |

> The coordinator never implements. Each stage returns `{stage, status, summary, actionables, artifacts}`; the coordinator reads only that, writes `chain.json` + one `NN-<stage>/brief.json` per stage in the run directory (resume point after `/new`), and pauses only where you asked or when a stage needs your decision.
