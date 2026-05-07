# Skill Description Spec — pi-workflow-skills

## Purpose

This document defines the expected format, length, and content criteria for the
`description` frontmatter field of every skill in this repository. Apply these
rules when creating or updating any `SKILL.md` here.

## Format

Single inline string (no YAML block scalar). No line breaks.

```yaml
description: <what it does in 1-2 sentences>. <when to use it or pipeline position>.
```

## Length

- **Target:** 150–300 characters
- **Hard limit:** 1024 characters (spec max; pi warns and loads anyway)
- **Never exceed 400 characters.** If you're over, content that belongs in the
  body has leaked into the description.

## Content Criteria

### Include

- **What the skill produces** — the user-visible output or outcome, not the
  internal mechanism. "Produces a PROGRESS.md plan" is better than "Deploys
  parallel opus-max planners to attack architectural angles."
- **When to use it** — the trigger condition, pipeline position, or user intent
  that should activate this skill.
- **Pipeline position** — for skills that are part of the
  investigate→spec→plan→orchestrate pipeline, state where the skill sits and
  what it consumes/produces for the next stage.

### Exclude

- **Trigger phrase lists.** Users invoke skills by name (`skill:investigator`).
  The model routes by semantic reasoning, not keyword matching. Lists of phrases
  ("investigate, research, audit, find root cause, ...") add tokens with no
  routing benefit.
- **Runtime instructions.** Anything starting with "IMPORTANT:", "Load this
  skill before...", or "Do NOT use..." belongs in the skill body, not the
  description. The description is read before activation; instructions are only
  meaningful after.
- **Behavioral constraints.** "Requires explicit confirmation", "Do NOT use
  mid-edit" — these are body content. The description is a routing signal, not
  a contract.
- **Internal mechanism detail.** Subagent topology, model names, parallel
  strategies — only include if it meaningfully differentiates the skill from
  similar ones.

## Pipeline Skills

Skills in this repo form a pipeline. Descriptions should reflect the ordering:

| Skill | Position | Consumes | Produces |
|---|---|---|---|
| investigator | 1 — investigate | task/question | findings report |
| specifier | 2 — spec | findings | behavioral contract (SPEC.md) |
| planner | 3 — plan | findings / spec | PROGRESS.md + step files |
| orchestrator | 4 — orchestrate | PROGRESS.md | completed implementation |
| code-reviewer | standalone / post-orchestrate | changes/branch/PR | review feedback |
| fact-checker | standalone / post-review / post-orchestrate | any document with claims | CONFIRMED/REFUTED/UNVERIFIABLE verdicts with evidence |

`worker-reviewer` is **orchestrator-internal**: set `disable-model-invocation: true`
and describe it as "internal roles loaded by the orchestrator skill." It must
not appear in the user-facing skill catalog.
## Examples

**Good:**
```yaml
description: Turns investigation findings into a wave-based PROGRESS.md execution plan
  with per-step files, layered context, and testable acceptance criteria. Use after
  investigation, before orchestration.
```

**Poor — trigger list, internal mechanism, runtime instruction:**
```yaml
description: "Produces a wave-based plan. Deploys parallel opus-max planners each
  attacking a different angle. Trigger phrases: plan, create an implementation plan,
  write step files. Also use proactively when a task requires 3+ steps. Load this
  skill before planning."
```
