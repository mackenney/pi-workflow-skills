# pi-workflow-skills

A [pi](https://github.com/badlogic/pi-coding-agent) package bundling six agentic workflow skills that form a full development pipeline:

```
investigate → spec → plan → orchestrate → implement/review → code-review
```

## Skills

| Skill | Role |
|-------|------|
| `investigator` | Deploys parallel scout agents to gather ground-truth facts before any planning. Produces a structured findings report. |
| `specifier` | Writes the behavioral contract of a component (RFC 2119 MUST/SHOULD/MAY). Permanent codebase artifact that informs planners and reviewers. |
| `planner` | Produces a wave-based `PROGRESS.md` + per-step files from investigation findings. Each step has layered context and observable acceptance criteria. |
| `orchestrator` | Executes a plan by dispatching workers in waves, running the worker-reviewer loop, and tracking progress. Coordinates — never implements. |
| `worker-reviewer` | Defines the adversarial Worker/Reviewer pair used inside the orchestrator loop. Worker implements; Reviewer verifies. Neither role crosses into the other. |
| `code-reviewer` | Competitive multi-agent code review. Three independent reviewers analyze changes in parallel, then a synthesis pass produces actionable feedback. |

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
4. `/skill:orchestrator` — execute the plan with worker/reviewer subagents
5. `/skill:code-reviewer` — review the final diff before merging
