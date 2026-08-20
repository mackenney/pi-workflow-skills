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
| `executor` | Executes a `PROGRESS.md` plan by dispatching worker-reviewer pairs in parallel waves, managing the verify cycle, escalating blockers, and tracking progress via git commits. |
| `worker-reviewer` | Internal roles loaded by the executor. Defines the adversarial Worker (implements, self-validates) and Reviewer (verifies without reimplementing) pair with a max-iteration fuse. |
| `fact-checker` | Verifies claims in any document — code reviews, investigation reports, plans, or specs — against source code, experiments, docs, git history, and web. Outputs CONFIRMED/REFUTED/UNVERIFIABLE verdicts. |
| `e2e-tester` | Exercises a spec-driven implementation end-to-end against a running stack, working narrow-to-wide until the integration surface is covered. Stops and reports on blockers rather than looping. |
| `code-reviewer` | Competitive multi-agent code review. Three independent reviewers analyze changes in parallel, then a synthesis pass produces actionable feedback. |
| `coordinator` | Installs a session-wide coordination protocol — read minimally, delegate maximally, navigate by executive summaries. Pair with a chain diagram when orchestrating complex multi-skill runs. |
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

Paste this into a pi session to run the full pipeline on a new feature or refactor:

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
| `investigator -> fact-checker -> fix` | Scout agents map the codebase; fact-checker verifies the findings report; a fixer subagent corrects any REFUTED or PARTIAL claims before planning begins. |
| `specifier -> planner -> fact-checker -> fix` | Specifier writes the behavioral contract; planner produces `PROGRESS.md`; fact-checker audits the plan for inaccuracies; fixer patches anything confirmed wrong. |
| `executor` | Dispatches worker-reviewer pairs in waves per the plan, tracking progress via git commits. |
| `(code-reviewer -> fact-checker -> fix) x3` | Up to three review rounds: three parallel reviewers synthesize a diff critique; fact-checker audits the review claims against source; fixer addresses confirmed blockers. Stops early after 2 consecutive clean rounds. |
| `e2e-tester` | Exercises the implementation against a running stack, narrow-to-wide, and reports any spec gaps or integration failures. |

> The coordinator never implements. It reads executive summaries, decides next steps, and escalates blockers. All substantive work runs in subagents.
