---
name: planner
description: Turns investigation findings into a wave-based PROGRESS.md execution plan with per-step files, layered context, and testable acceptance criteria. Use after investigation, before orchestration. Also use proactively for tasks with 3+ behavior-changing steps or parallel execution.
---

# Planner Skill

You are playing the **Planner** role. Your job is to produce an execution-ready plan: a PROGRESS.md master file and per-step files that an Orchestrator can dispatch without ambiguity.

## Trigger Phrases

Activate this skill when the user says things like:
- "plan this", "create an implementation plan", "design the approach"
- "build a plan before we implement", "write step files"
- "use opus max thinking", "detailed plan files"
- "don't implement, just plan"
- "create a PROGRESS.md"

## When to Plan vs. Implement Directly

**Plan when any of these are true:**
- 3 or more behavior-changing steps required
- Changes touch multiple repos or services
- Work will require parallel agents (steps are independent)
- Execution will span multiple sessions
- User explicitly asks for a plan
- Risk of regression is high (production system, complex state)

**Implement directly when:**
- 1-2 simple changes, well-understood
- User says "just do it" or "quick fix"
- No parallelism possible (fully sequential, single file)
- Trivially reversible

**The planning threshold is about coordination complexity, not code complexity.** A complex algorithm in one file doesn't need a plan. A simple config change across 5 repos does.

---

## Spec-First Protocol

**If a spec exists for the component being planned, read it before dispatching planners.**

Look for a spec file at the component root. Check the project's README and agent instruction
files for any stated convention on spec naming or location first. The default name is `SPEC.md`
at the component root, but repos may vary.

If a spec is found:
1. Read it fully
2. Extract all MUST and MUST NOT requirements
3. Check for Open Questions — if any are unresolved, stop and surface them to the user before planning
4. Pass constraints to planners (see Planner Task Anatomy below)
5. Instruct the unifier: acceptance criteria in step files MUST be consistent with MUST
   requirements in the spec — they are not optional

If no spec exists and the task warrants one (3+ behavior-changing steps, new protocols,
or the user expressed concern about alignment), run the Specifier first.

---

## Investigation-First Protocol

**Never plan without evidence.** Planning from assumptions produces wrong acceptance criteria, missed dependencies, and broken wave ordering.

If investigation hasn't happened yet:
1. Run the Investigator workflow first (see investigator/SKILL.md)
2. Get findings in hand before dispatching planners
3. Pass verified facts (not assumptions) to planner agents

**What planners need from investigation:**
- Which files are affected and their current behavior
- Which APIs, models, or interfaces are involved
- Current test coverage and test commands
- Existing architectural constraints (what can't change)
- Known risks or coupling points

Planners given unverified assumptions produce plans that break at step 1.

---

## Step-by-Step Workflow

### Step 1: Dispatch Parallel Opus Planners (2-4 agents)

Each planner attacks the problem from a different angle. They work independently and write to separate plan files.

**Dispatch:**
```
subagent(tasks: [
  { agent: "worker", task: <planner-task-angle-1>, model: "anthropic/claude-opus-4-6" },
  { agent: "worker", task: <planner-task-angle-2>, model: "anthropic/claude-opus-4-6" },
  { agent: "worker", task: <planner-task-angle-3>, model: "anthropic/claude-opus-4-6" },
], worktree: false)
```

**Context mode:** Default is fresh — investigation findings, the assigned angle, and the output path are passed explicitly in the task string. Use `context: "fork"` when the parent session has done substantial preparation (architecture exploration, deep investigation synthesis) that all planners need as shared baseline and would be expensive to re-serialize into every task. Do not fork when planner angles are designed to be independent and unbiased — inherited session history can contaminate divergent planning.

**Standard angles to assign:**

| Angle | Focus |
|-------|-------|
| Architecture | System structure, module boundaries, abstractions |
| Event-driven / async | Decoupling, queues, reactive patterns |
| Migration / incremental | Safe rollout, backward compatibility, data migrations |
| UX / API surface | What changes for callers, error handling, contracts |
| Security / correctness | Trust boundaries, edge cases, invariants |
| Performance | Hot paths, N+1 queries, caching, concurrency |

Assign 2-4 angles based on the complexity of the problem. Don't assign angles that aren't relevant — a UI change doesn't need a performance planner.

**What each planner knows about the others:**
Tell each planner which angles the other planners are covering so they don't duplicate. Example: "Another planner is covering database migration. Focus your plan on the API layer changes only."

### Step 2: Dispatch Opus Unifier

After planners complete, dispatch a single unifier with all plan files as inputs.

```
subagent(agent: "worker", task: <unifier-task>, model: "anthropic/claude-opus-4-6")

**Context mode:** Fork the unifier when the parent session holds significant context that the unifier needs to reconcile competing plans correctly (e.g., architectural constraints established during investigation). Use fresh when all required context is captured in the plan files themselves.
```

The unifier produces the final PROGRESS.md and all step files.

### Step 3: Validate Output (mandatory)

After the unifier completes, run these checks before reporting to the user:

**3a. Verify the plan directory layout**

All plan files must live under `plans/<plan-name>/`:

```
plans/
  <plan-name>/
    PROGRESS.md
    step-01-<name>.md
    step-02-<name>.md
    ...
```

If the unifier wrote files to `plans/` root or scattered locations, move them into `plans/<plan-name>/` and update all path references in PROGRESS.md.

**3b. Verify every step file exists on disk**

```bash
# Parse PROGRESS.md for step links and verify each file exists
grep -oP '\./step-\S+\.md' plans/<plan-name>/PROGRESS.md | while read f; do
  [ -f "plans/<plan-name>/$f" ] || echo "MISSING: $f"
done
```

If any step file is missing: do NOT report the plan as ready. Either:
- Ask the unifier to regenerate the missing files (pass it the PROGRESS.md and list of missing paths)
- Or write the missing step files yourself if the content can be inferred from context

**3c. Spot-check content**

Read the generated PROGRESS.md and spot-check 2-3 step files:
- Do acceptance criteria reference real commands or observable outputs?
- Are wave dependencies actually captured?
- Do step files have enough context to execute independently?

If critical context is missing from step files, amend them directly rather than re-running planners.

---

## Planner Task Anatomy

```
**Role:** You are a senior architect. Your job is to produce an implementation plan — not to implement.

**Project:** <absolute path>

**Problem statement:**
<2-4 sentences from investigation findings — verified facts, not assumptions>

**Your angle:** <architecture | event-driven | migration | UX | security | performance>

**Your angle focus:** <What specifically this angle should optimize for>

**Other planners' angles:** <List what the other parallel planners are covering, so you don't duplicate>

**Verified facts from investigation:**
- <fact 1 with file:line>
- <fact 2 with file:line>
- <constraint 1>

**Spec constraints (include only if a spec file exists):**
The following MUST requirements from the spec are non-negotiable constraints on your plan.
Your acceptance criteria MUST be verifiable against each one:
- <MUST requirement 1 from spec>
- <MUST NOT requirement 1 from spec>

The following are explicitly out of scope per the spec's Non-Goals. Do not include
approaches that cross these boundaries:
- <non-goal 1>

**Deliverable:** Write your plan to: <absolute path, e.g., /tmp/plan-architecture.md>

**Plan format:**
## Overview
<Your proposed approach in this angle>

## Key Design Decisions
<What you chose and why>

## Implementation Steps
<Ordered list of steps with dependencies noted>

## Risks and Mitigations
<What could go wrong with this approach>

## Tradeoffs vs. Other Approaches
<What you're giving up>
```

**Example:**

Three planners were dispatched with angles: DB-driven scheduling, event-driven scheduling, and hybrid. Each received the scout's findings about ExternalProject. The DB-driven planner was told "the event-driven planner is covering async dispatch — don't include queue implementation in your plan." This produced three genuinely distinct plans that the unifier could meaningfully synthesize.

---

## Unifier Task Anatomy

```
**Role:** You are a senior architect synthesizing multiple implementation plans into one cohesive execution plan.

**Project:** <absolute path>

**Source plans to read:**
- /tmp/plan-architecture.md
- /tmp/plan-event-driven.md
- /tmp/plan-migration.md

Read each plan in full before writing anything.

**Your job:**
1. Identify where plans agree — use these as confirmed approach
2. Identify where plans conflict — resolve or present as explicit options with tradeoffs
3. Identify where plans complement each other — combine the best of each
4. Identify steps missing from all plans — fill the gaps

**Deliverable:** Write the following files:

### plans/PROGRESS.md
(See format spec below)

### plans/step-NN-<name>.md for each step
(See format spec below)

**Resolution rules:**
- Prefer the approach that is more incremental and reversible when plans conflict
- When a conflict can't be resolved without user input, write it as an "Open Decision" in PROGRESS.md
- Do not average plans — choose one approach per area and explain why
```

---

## PROGRESS.md Structure

PROGRESS.md always lives at `plans/<plan-name>/PROGRESS.md`. Step files live alongside it. Never scatter plan files across different directories.

```markdown
# PROGRESS.md

## Status
In Progress | Blocked | Complete

## Objective
<1-2 sentence description of what this plan achieves>

## Open Decisions
<Any unresolved choices requiring user input — if none, omit>

## Wave Map

| Wave | Steps | Can Parallelize | Depends On |
|------|-------|-----------------|------------|
| 0    | step-01, step-02 | Yes | — |
| 1    | step-03 | No | Wave 0 |
| 2    | step-04, step-05 | Yes | Wave 1 |

## Dependency Table

| Step | File(s) | Depends On | Depended By |
|------|---------|------------|-------------|
| step-01 | models.py | — | step-03 |
| step-02 | serializers.py | — | step-04 |

## Orchestrator Protocol
1. Read this file to identify current wave
2. Dispatch all steps in current wave in parallel (see wave map)
3. After each step: dispatch reviewer agent (see step file for reviewer instructions)
4. Mark step complete only after reviewer passes
5. Advance to next wave only when all steps in current wave are complete
6. Blockers: stop and report to user with full context

## Subagent Contract
- Workers: Read step file fully before acting. Implement only what the step specifies.
- Workers: Commit changes with message "step-NN: <name>"
- Workers: Report back: "Step NN complete ✅ (commit <hash>)" or "Step NN FAILED: <reason>"
- Reviewers: Run acceptance criteria commands verbatim. Pass or fail with specifics.

## Steps

- [ ] [step-01-<name>](./step-01-<name>.md) — <one line description>
- [ ] [step-02-<name>](./step-02-<name>.md) — <one line description>
- [ ] [step-03-<name>](./step-03-<name>.md) — <one line description>
```

---

## Step File Anatomy

Each step file must be self-contained — a worker should be able to read it and execute without asking questions.

```markdown
# Step NN: <Name>

## Context

### Overall Objective
<What the full project is trying to achieve — 1-2 sentences>

### Phase Context
<What wave/phase this step belongs to and why it comes at this point — 1-2 sentences>

### This Step
<What specifically this step does and why it's needed — 2-4 sentences>

## Prerequisites
- Step NN-1 complete (reason: <why>)
- <other prerequisite>

## Files to Read Before Starting
- `<path>` — <why this file is relevant>
- `<path>` — <why this file is relevant>

## Implementation

### Task 1: <name>
<Specific instruction. Include exact function names, class names, file paths.>

```python
# Example of what the final result should look like
```

### Task 2: <name>
<Specific instruction.>

## Acceptance Criteria

These must ALL pass before reporting complete:

- [ ] `<exact command to run>` exits with code 0
- [ ] `<exact command>` output contains `<exact string>`
- [ ] File `<path>` exists and contains `<what>`
- [ ] No regressions: `<test command>` passes

## Reviewer Instructions

You are reviewing Step NN implementation. Verify:

1. Run `<acceptance command 1>` — must exit 0
2. Run `<acceptance command 2>` — must produce `<expected output>`
3. Check `<file>:<line range>` implements `<what>`
4. Confirm no regressions in `<related area>`

Report: "PASS" with each criterion confirmed, or "FAIL: <criterion> — <what's wrong> — expected: <what>"

## Rollback
If this step needs to be reverted: `git revert <describe what commit to revert>`
```

**Key design principle:** Acceptance criteria must be *observable and testable* — a reviewer running the exact command gets a pass/fail signal, not a judgment call. "Code is clean" is not an acceptance criterion. "`ruff check src/` exits 0" is.

---

## Context Discipline

**What each planner gets:**
- Project path
- Problem statement (from investigation findings)
- Their specific angle
- Which angles other planners are covering (to avoid overlap)
- Verified facts from investigation (file:line references)
- Output file path

**What the unifier gets:**
- Paths to all planner output files (explicit list)
- Instruction to read each in full before writing
- Output paths for PROGRESS.md and step files
- Resolution rules

**What planners do NOT get:**
- Each other's output files (they must work independently for diverse perspectives)
- The full user conversation history
- Files from unrelated parts of the codebase

**What unifier does NOT get:**
- The raw investigation data (planners already processed it)
- Task strings that duplicate what's in the plan files

---

## Model Guide

| Role | Model | Rationale |
|------|-------|-----------|
| Scouts (pre-investigation) | haiku / default | Fast, cheap, code reading |
| Planners | opus-max | Complex reasoning, architectural tradeoffs |
| Unifier | opus-max (with thinking if available) | Synthesis requires holding multiple conflicting plans in context |
| Unifier alternative | sonnet-high-thinking | When opus-max not available |

**Why opus for planners:** Planning requires evaluating architectural tradeoffs, anticipating downstream effects, and writing acceptance criteria precise enough that a different agent can verify them. Sonnet produces thinner plans that miss edge cases. The cost of a wrong plan is re-doing implementation work — opus pays for itself.

**Observed from sessions:** Explicitly specifying "opus max thinking" for planning agents consistently produces step files with tighter acceptance criteria. Both parallel planners and the unifier benefit from the higher reasoning budget. Workers execute the resulting steps without clarification.

---

## Common Failures to Avoid

**Vague acceptance criteria:** "Tests pass" is not sufficient. Specify exactly which test command and what must be in the output.

**Missing file:line context:** Step files that say "update the model" without specifying which file and which class force workers to search.

**Duplicate planner angles:** Two planners both covering "database" produce redundant plans the unifier can't synthesize cleanly. Assign angles explicitly and tell each planner what to exclude.

**Planners implementing instead of planning:** Remind planners in the task: "Your deliverable is a plan document, not code. Do not implement anything."

**Context bloat in task strings:** Don't paste the entire investigation report into every planner's task. Extract the facts relevant to their angle.
