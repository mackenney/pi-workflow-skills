---
name: planner
description: Turns investigation findings into a wave-based PROGRESS.md execution plan with per-step files, layered context, and testable acceptance criteria. Use after investigation, before execution. Invoke as 'planner' for normal multi-angle mode or 'quick plan'/'simple plan' for a single-pass plan.
---

# Planner Skill

You are playing the **Planner** role. Your job is to produce an execution-ready plan: a PROGRESS.md master file and per-step files that an Executor can dispatch without ambiguity.

## Subagent Mechanism

Do not improvise `subagent(...)` calls for planning. Run `workflows/plan-factcheck-fix.js` via `subagent({ workflow: "<absolute script path>", args, async: true })`: it dispatches `wf-planner` (deep tier) per angle, then `wf-synthesizer` (frontier tier, plan mode) to unify them under a typed `validate-plan.sh` gate, then `wf-fact-checker` on the result, with a bounded fix loop. `args.mode: "simple"` (or omitting `args.angles`) skips the multi-angle dispatch and runs a single `wf-synthesizer` pass. It returns the stage envelope (`skills/coordinator/SKILL.md`); you read its `summary`/`actionables`, record `decision` actionables under "Pending decisions (human)" with `scripts/ledger-apply.sh` (`{"planDir", "ledgers": [{"step": "plan", "tick": false, "pending_decisions": [...]}]}`), and report to the user — the workflow file owns dispatch, gating and retries; this skill owns the templates, sizing rules and human-facing protocol.

See `step-contract` for the gate taxonomy, coverage matrix, and PROGRESS.md ledger row grammar every step file and sidecar must follow.

## Trigger Phrases

Activate this skill when the user says:
- "plan this", "planner", "write step files", "create a PROGRESS.md"
- "quick plan", "simple plan" — activates Simple Mode (see Modes below)

## When to Plan vs. Implement Directly

**Plan when any of these are true:**
- The work has genuine ordering constraints (step B cannot start until step A's output exists)
- Changes span repos, services, or persisted data shapes
- Execution will span multiple sessions or needs a durable record for a human reviewer
- Risk of regression is high (production system, complex state)
- User explicitly asks for a plan

**Dispatch directly, no plan, when:**
- The work is a set of *independent, similar units* (N PRs to rebase, N modules to harden, N lanes of the same refactor) — dispatch one strong worker per unit and skip the plan entirely
- 1-2 simple changes, well-understood
- User says "just do it" or "quick fix"
- Trivially reversible

**The planning threshold is about *ordering* complexity, not code complexity or unit count.** Ten independent PR rebases need zero plan and ten dispatches. One three-stage migration with a data backfill in the middle needs a plan even though it is three steps.

**Caution on "independent parallel units":** verify independence at the file/directory level before skipping the plan, not just at the task-description level — a stack of nominally separate units sharing a directory (e.g. a shared `specs/` tree) has cross-unit ordering complexity that per-unit gates cannot see, and needs a stack-level CI gate (`workflows/stack-ci-gate.js`) even without a full plan.

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

## Modes

### Normal Mode (default)

`workflows/plan-factcheck-fix.js` with `args.angles` set to 2-4 angle names/count dispatches `wf-planner` per angle, then `wf-synthesizer` in plan mode to unify them. Use for multi-step, multi-file, or high-risk plans. Activated by bare "plan" / "planner" invocations.

### Simple Mode

The same workflow file with `args.mode: "simple"` (or `args.angles` omitted/empty): skips multi-angle dispatch and runs a single `wf-synthesizer` pass directly from the spec/investigation. Use when the user says **"quick plan"** or **"simple plan"**.

The simple-mode synthesizer receives the same inputs as normal-mode planners (problem statement, verified facts, spec constraints) but has no angle constraint — it synthesizes a complete plan in one pass. The validation step (Step 3) still applies, and is additionally enforced mechanically by the workflow's `validate-plan.sh` typed gate before fact-check even runs.

---

## Step-by-Step Workflow (Normal Mode)

### Step 1: Angle planners (`wf-planner`, deep tier, 2-4 angles)

Each planner attacks the problem from a different angle. They work independently and write to separate plan files. `workflows/plan-factcheck-fix.js` dispatches these via `runs.all` internally when `args.angles` is set; you do not call `subagent(...)` directly for this.

**Context mode:** Default is fresh — investigation findings, the assigned angle, and the output path are passed explicitly in the task string. The workflow always launches planners fresh (no fork), which also keeps divergent angles independent and unbiased.

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

### Step 2: Synthesis (`wf-synthesizer`, frontier tier, plan mode)

After planners complete, the workflow dispatches a single `wf-synthesizer` run (plan mode) with all plan files as inputs, under the `validate-plan.sh` typed gate; failed validation triggers a fresh re-synthesis round (never `resume` — typed gates are rejected on resume) carrying the validator's `errors[]`, up to `args.maxSynthRounds`.

**Context mode:** The synthesizer is always launched fresh; everything it needs must be captured in the plan files themselves.

The synthesizer produces the final PROGRESS.md, all step files, their `*.gates.json` sidecars, and the machine-readable `plan.json` index `validate-plan.sh` checks.

### Step 3: Validate Output (mandatory)

`workflows/plan-factcheck-fix.js` already ran `scripts/validate-plan.sh` as a typed gate before returning (schema errors, missing gate classes, no runnable gate, dangling coverage rows, sidecar/plan.json/step-file drift, PROGRESS.md sections and checklist, deferred gates without open rows, First-Artifact Rule violations all fail it mechanically; coverage adequacy is the fact-checker's call) and ran `wf-fact-checker` on the result. Do not re-derive that check by hand. After the workflow returns, run these human-facing checks before reporting to the user:

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

## Executor Tier
<fast | standard | deep> — steps in this plan are sized for this tier, never above deep (see "Executor Tier and Step Sizing" above).

## Open Decisions
<Any unresolved choices requiring user input — if none, omit>

## Decisions taken
<One line per decision, with commit or step reference — appended by scripts/ledger-apply.sh from each step's typed verdict>

## Pending decisions (human)
<Unresolved after a second fresh fact-check/review round, or a worker escalation — if none, omit>

<!-- The plan is not complete while any row in the two ledger tables below reads `open` or any ## Steps item is unchecked. Status grammar: step-contract. No model writes `waived`. Leave a table empty (header + separator only) when there is nothing to record; placeholder rows block completion, and so does any non-table line inside these sections. -->
## Tech debt / deferred gates
| Gate | Class | Owed by | Reason deferred | Status |
|------|-------|---------|-----------------|--------|

## Disabled/softened checks
| Check | Where | Why | Status |
|-------|-------|-----|--------|


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

## Executor Protocol
1. Read this file to identify current wave
2. Dispatch all steps in current wave in parallel (see wave map)
3. After each step: dispatch reviewer agent (see step file for reviewer instructions)
4. Mark step complete only after reviewer passes
5. Advance to next wave only when all steps in current wave are complete
6. Blockers: stop and report to user with full context

## Subagent Contract
Dispatched via `workflows/execute-step.js` / `execute-wave.js`, not ad-hoc task strings — see the `executor` skill. Workers (`wf-structural-worker`, `wf-flash-worker`, or the builtin `worker` with per-run `skill: "step-contract"`) run every sidecar gate, commit `step-NN: <name>`, and return a typed STEP-VERDICT. Reviewers (`wf-step-reviewer`) re-run the gates independently and return a typed REVIEW-VERDICT — never prose PASS/FAIL. `execute-step.js` applies the typed verdict through `ledger-apply`; the parent never edits ledger rows.

## Steps

- [ ] [step-01-<name>](./step-01-<name>.md) — <one line description>
- [ ] [step-02-<name>](./step-02-<name>.md) — <one line description>
- [ ] [step-03-<name>](./step-03-<name>.md) — <one line description>
```

---

## Executor Tier and Step Sizing

Every plan takes the executor tier as an input, not a planner-chosen output: pass it in `args.tier` to `workflows/plan-factcheck-fix.js` (default `deep` — a trial default per RECOMMENDATIONS-v2 R1, not yet a settled choice; re-evaluate after a few structural-mode plans). Size every step to that tier using `step-contract`'s tier -> scope table (files touched, distinct concerns, net LOC, permitted architectural decisions, gate-authoring strictness). Record the tier in PROGRESS.md's "Executor Tier" section.

Regardless of tier, apply `step-contract`'s hard-splits list: a persisted-shape change never merges with a feature, a refactor never merges with a behavior change, a security/permissions boundary change is always alone, a capability-add never merges with a visibility/selection change, anything whose rollback is not a clean `git revert` is atomic by definition, and cross-repo changes split at the repo boundary. A step that violates one of these is a planning defect, not the worker's problem to silently split.

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

## Success Gates

Write a `step-NN.gates.json` sidecar next to this file per `step-contract`'s schema — every gate class gets a verdict (`N/A: <reason>` is valid; an omitted class is a planning defect), plus a coverage matrix row for every profile/selector/flag/non-default path this step touches, each naming the gate that exercises it. This is what the runtime executes (`acceptance.verify[]`); the human-readable summary below must not disagree with the sidecar.

- [ ] G-build: `<exact command>` exits 0
- [ ] G-static: `<exact command>` exits 0
- [ ] G-unit: `<exact command>` passes, and fails on the pre-change tree
- [ ] G-e2e-smoke: `<exact command>` observes the real new behavior
- [ ] G-regress: `<exact command>` (scoped suite) passes
- [ ] G-integ: `N/A` unless this is the plan's integration step

If this step touches a Dockerfile, packaging manifest, lockfile, or bundle spec: a real (non-proxy) build/e2e-smoke gate is required in this step — not deferred (First-Artifact Rule, `step-contract`).

## Reviewer Instructions

The reviewer is `wf-step-reviewer` (dispatched by `workflows/execute-step.js`), not a task string you write per step. It re-runs every gate in the sidecar, checks G-unit fails-before on a throwaway worktree, audits for undeclared proxies and scope creep (`git show --stat`), checks the coverage matrix, and reports missing ledger rows. Its typed verdict schema is `step-contract`'s REVIEW-VERDICT — do not write ad-hoc reviewer prose in the step file.

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

Models are never named in this skill or in task strings — they are bound by the `tier:` frontmatter on `wf-planner`/`wf-synthesizer` and `scripts/generate-tier-overrides.mjs`, which renders `~/.pi/agent/AGENTS.md`'s Model Tiers table into `subagents.agentOverrides`. This skill only says which *role agent* does the work.

| Role | Agent | Tier | Rationale |
|------|-------|------|-----------|
| Scouts (pre-investigation) | builtin `scout` | fast (hand-pinned, unmanaged) | Fast, cheap, code reading |
| Angle planners | `wf-planner` | deep, medium thinking | Complex reasoning, architectural tradeoffs |
| Synthesizer (unify / simple mode) | `wf-synthesizer` | frontier | Synthesis requires holding multiple conflicting plans in context; needs the strongest reasoning available for final reconciliation. Same agent, same tier for simple mode — single-pass synthesis has the same ceiling. |

**Why deep tier for planners:** Planning requires evaluating architectural tradeoffs, anticipating downstream effects, and writing acceptance criteria precise enough that a different agent can verify them. A standard-tier model tends to produce thinner plans that miss edge cases. The cost of a wrong plan is re-doing implementation work — the stronger reasoning of deep tier pays for itself. Use medium thinking, not high/xhigh — per-task cost climbs fast at higher effort without a proportional quality gain for planning-style tasks.

**Observed from sessions:** Explicitly specifying deep tier with medium thinking for planning agents consistently produces step files with tighter acceptance criteria. Both parallel planners and the unifier benefit from the higher reasoning budget. Workers execute the resulting steps without clarification.
---

## Common Failures to Avoid

**Vague acceptance criteria:** "Tests pass" is not sufficient. Specify exactly which test command and what must be in the output.

**Missing file:line context:** Step files that say "update the model" without specifying which file and which class force workers to search.

**Duplicate planner angles:** Two planners both covering "database" produce redundant plans the unifier can't synthesize cleanly. Assign angles explicitly and tell each planner what to exclude.

**Planners implementing instead of planning:** Remind planners in the task: "Your deliverable is a plan document, not code. Do not implement anything."

**Context bloat in task strings:** Don't paste the entire investigation report into every planner's task. Extract the facts relevant to their angle.
