---
name: planner
description: Turns investigation findings or a spec into a wave-based PROGRESS.md execution plan with per-step files, gate sidecars and plan.json, fact-checked before handoff. Use after investigation/spec, before execution; 'quick plan' or 'simple plan' runs a single-pass plan.
---

# Planner Skill

You are playing the **Planner** role: produce an execution-ready plan — a PROGRESS.md master file,
per-step files, their `*.gates.json` sidecars and a `plan.json` index — that the `executor` can
dispatch without ambiguity.

This skill is read by two audiences:
- **The main session** that runs `/planner`: it follows the "Main session procedure" sections and is
  the only dispatcher.
- **`wf-planner` and `wf-synthesizer`**, which preload this skill for its templates (Planner Task
  Anatomy, PROGRESS.md Structure, Step File Anatomy, sizing rules). They ignore the "Main session
  procedure" sections.

See `step-contract` for the gate taxonomy, coverage matrix, sidecar schema and PROGRESS.md ledger
row grammar every step file and sidecar must follow.

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

**Caution on "independent parallel units":** verify independence at the file/directory level before skipping the plan, not just at the task-description level — a stack of nominally separate units sharing a directory (e.g. a shared `specs/` tree) has cross-unit ordering complexity that per-unit gates cannot see, and needs a stack-level CI gate (`executor` skill, Procedure C) even without a full plan.

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
or the user expressed concern about alignment), run `/specifier` first.

---

## Investigation-First Protocol

**Never plan without evidence.** Planning from assumptions produces wrong acceptance criteria, missed dependencies, and broken wave ordering.

If investigation hasn't happened yet:
1. Run `/investigator` first
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

## Main session procedure — Modes

- **Normal mode** (default, bare "plan"/"planner"): 2–4 `wf-planner` angles, then one
  `wf-synthesizer` pass unifying them. For multi-step, multi-file or high-risk plans.
- **Simple mode** ("quick plan", "simple plan", or `angles: 0`): no angles; one `wf-synthesizer`
  pass straight from the spec/investigation. Validation, fact-check and fix still run.

## Main session procedure — plan, fact-check, fix (was `workflows/plan-factcheck-fix.js`)

pi ran this as a script with typed gates. Here you run it. Every **(gate)** is a script result you
act on mechanically; report which gates ran.

```bash
WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"
```

Shell variables do not persist between Bash calls: start every command that uses `$WFS` with this
assignment. In child prompts, `<WFS>` stands for its resolved value.

Inputs: `spec` (spec or investigation path), `planDir` (`plans/<plan-name>/`), optional `stageDir`
(default `<planDir>/runs/<YYYY-MM-DDTHHMMSS>-plan/`), `tier` (executor tier the steps are sized
for; default `deep`; `fast` has no Claude Code worker, prefer `standard` or `deep`), `mode`,
`angles` (count or list of angle names; default 3), `maxSynthRounds` (default 3), `fixScope`
(`clear` default | `trivial` | `all` | `none`), `notes`, and per-role model overrides
`plannerModel` / `synthModel` / `factcheckModel` / `fixModel` (Claude Code aliases only: `haiku`,
`sonnet`, `opus`, `fable`; passed as the `Agent` call's `model`). Missing `spec` or `planDir`, or an
unknown `fixScope` → stop with a `blocked` brief. Append "User notes for this stage: <notes>" to every
child prompt when `notes` is set.

Before step 1: Spec-First and Investigation-First checks (above). Read the spec's MUST/MUST NOT and
Open Questions yourself; unresolved Open Questions stop here and go to the user.

**1. Angles** (normal mode). Pick 2–4 angles (Standard angles table below; tell each which angles
the others cover). Dispatch one `wf-planner` per angle **in one message** (parallel), each prompt per
Planner Task Anatomy plus:
```
Spec/investigation: <spec>
Executor tier: <tier>
Angle <n> of <N> - propose an independent structural decomposition.
Write your plan-summary and step files under <planDir>/angle-<n>/ (plan-summary at <planDir>/angle-<n>/plan-summary.md).
```
Wait for a completion notification from every planner before checking files (a check before that
is not a failure). A planner whose `plan-summary.md` is missing or empty failed. All failed → `FAIL` at `angles`, go to
step 6. Some failed → continue with the rest and record an `info` actionable per failed angle.

**2. Synthesis loop (gate)** — up to `maxSynthRounds` rounds, each a **fresh** `wf-synthesizer`
dispatch (never `SendMessage`: a fix round must start from the files, not from the failed round's
reasoning). Round 0 prompt:
```
Mode: plan.
<Reconcile these angle plans into one unified structural plan: | Simple mode: single-pass structural plan from the spec directly (no angles).>
Angle <n> output: <planDir>/angle-<n>/plan-summary.md   (one line per surviving angle)
Spec/investigation: <spec>
Executor tier: <tier>
Write the unified plan (step files + *.gates.json sidecars) under <planDir>/, a single machine-readable index at <planDir>/plan.json (schema: {steps:[{id,tier,files,gates,coverage,hard_splits_declared}]}), and PROGRESS.md (step-contract ledger sections + ## Steps checklist).
Validator: bash "<WFS>/scripts/validate-plan.sh" "<planDir>/plan.json" must print {"ok":true,...}. Run it before finishing.
```
After the child returns, run `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; bash "$WFS/scripts/validate-plan.sh" "<planDir>/plan.json"` yourself.
`ok: true` → step 3. Otherwise next round, prompt:
```
Mode: plan. Fix round <r>.
Spec/investigation: <spec>
Angle <n> output: ...            (as in round 0)
Your previous plan output: <planDir>/plan.json
validate-plan.sh errors to fix: <errors JSON array, verbatim>
Rewrite <planDir>/plan.json (and the affected step files/sidecars) to resolve every listed error.
```
After `maxSynthRounds` rounds without `ok` → `FAIL` at `synth` with the last errors. A child that
ends with `NEEDS-DECISION:` → ask the user, `SendMessage` the answer (load it with ToolSearch
`select:SendMessage` first if it is deferred), and treat its next reply as the
same round.

**3. Fact-check (gate).** Dispatch `wf-fact-checker`:
```
Fact-check the plan at <planDir>/plan.json against the repo: verify every gate command exists and is runnable, and every cited fact is real. Write a JSON report to <planDir>/factcheck-0.json: {claims:[{claim, verdict: CONFIRMED|REFUTED|PARTIAL|DISPUTED|UNVERIFIABLE, evidence}]}.
```
Run `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; bash "$WFS/scripts/classify-factcheck.sh" <planDir>/factcheck-0.json`. Fail closed: `error`
set or `total` 0 → `FAIL` at `factcheck`, step 6.

**4. Fix pass (gate)** — only if `fixScope != none` and `refuted + partial > 0`. Dispatch `wf-worker`:
```
Fix the plan at <planDir>/plan.json (and affected step files/sidecars/PROGRESS.md) per the REFUTED/PARTIAL claims in the fact-check report at <planDir>/factcheck-0.json (counts: <classifier JSON>). <scope text>
Keep plan.json and every sidecar identical where they overlap. Re-run bash "<WFS>/scripts/validate-plan.sh" "<planDir>/plan.json" until it prints ok. Do not commit.
End with the FIX-REPORT: line and json block.
```
Scope text: `all` → "Fix every REFUTED/PARTIAL claim." `clear` → "Fix a REFUTED/PARTIAL claim only
if its fix is unambiguous (one obviously right correction, no design choice). Record every other one
as an Open Decision in PROGRESS.md (claim, why it needs the user) instead of fixing it."
`trivial` → "Fix only trivial REFUTED/PARTIAL claims: typos, stale paths/names/commands, doc
drift, one-line mechanical corrections. Record every other one as an Open Decision in PROGRESS.md
(claim, why it needs the user) instead of fixing it."
Then run `validate-plan.sh` yourself: not ok → `FAIL` at `plan-fix`, step 6. Then a second
fact-check exactly as step 3 ("Re-verify the plan at <planDir>/plan.json after fixes. Same report
schema.") into `<planDir>/factcheck-1.json`, classified the same way and failing closed the same way.

**5. Outcome.** `clean = refuted == 0 && partial == 0` on the last classification.
`pendingDecisions`: "<d> disputed fact-check claim(s) - see <factcheck path>" when `disputed > 0`;
when not clean and `fixScope != all`: "<n> refuted/partial claim(s) left by fixScope <scope> - see
<factcheck path> and PROGRESS.md Open Decisions". State: `PASS` if clean or `fixScope != all`, else
`FAIL`.

**6. Persist.** `<stageDir>/result.json` =
`{state, stage?, planPath, factcheckPath, factcheckClass, validation?, pendingDecisions, angles: [{angle, ok, output}]}`;
`<stageDir>/brief.json` = stage envelope (`coordinator` skill): `stage: "plan"`; status `failed` if
not PASS, else `needs-decision` if `pendingDecisions`, else `done`; summary `plan PASS: validate-plan
ok; fact-check <total> claims, <r> refuted, <p> partial, <d> disputed.` or `plan FAIL at <stage>.`;
actionables: each pending decision (`decision`), on PASS "check PROGRESS.md Open Decisions before
executing" (`info`), on FAIL the failing stage and its first errors (`fix`), each failed angle
(`info`); `artifacts.primary` = plan.json. Check it with `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; "$WFS/claude/scripts/check-block.sh" envelope <stageDir>/brief.json`.
Record disputed claims and other `decision` actionables in the ledger:
`WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; echo '{"planDir":"<planDir>","ledgers":[{"step":"plan","tick":false,"pending_decisions":[...]}]}' | "$WFS/scripts/ledger-apply.sh"`.

**7. Human-facing checks** (after a PASS, before reporting):
- 7a. Layout: every plan file under `plans/<plan-name>/`; move strays and fix PROGRESS.md links.
- 7b. Every step file linked from PROGRESS.md exists:
  ```bash
  grep -oP '\./step-\S+\.md' plans/<plan-name>/PROGRESS.md | while read f; do
    [ -f "plans/<plan-name>/$f" ] || echo "MISSING: $f"
  done
  ```
  Missing files: do not report the plan ready; re-run one synthesis round naming the missing paths.
- 7c. Spot-check PROGRESS.md and 2–3 step files: real commands in acceptance criteria, wave
  dependencies captured, enough context to execute independently. Amend thin step files directly
  (then re-run `validate-plan.sh`) rather than re-running planners.

Report: the brief's summary, Open Decisions and pending decisions verbatim, and the gates that ran
(validate-plan rounds, classifier counts per fact-check round).

## Standard angles

| Angle | Focus |
|-------|-------|
| Architecture | System structure, module boundaries, abstractions |
| Event-driven / async | Decoupling, queues, reactive patterns |
| Migration / incremental | Safe rollout, backward compatibility, data migrations |
| UX / API surface | What changes for callers, error handling, contracts |
| Security / correctness | Trust boundaries, edge cases, invariants |
| Performance | Hot paths, N+1 queries, caching, concurrency |

Assign 2-4 angles based on the complexity of the problem; skip irrelevant ones (a UI change doesn't
need a performance planner). Tell each planner which angles the others cover: "Another planner is
covering database migration. Focus your plan on the API layer changes only." Planners never see
each other's output — independence is what makes synthesis worth it. Synthesis is always a fresh
launch: everything it needs must be in the plan files.

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

**Deliverable:** Write your plan to: <absolute path, e.g., <planDir>/angle-1/plan-summary.md>

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
- <planDir>/angle-1/plan-summary.md
- <planDir>/angle-2/plan-summary.md
- <planDir>/angle-3/plan-summary.md

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
<Disputed fact-check claims, or a worker escalation — if none, omit>

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
Dispatched by the `executor` skill's procedures, not ad-hoc task strings. Workers (`wf-structural-worker` for deep steps, `wf-worker` for standard) run every sidecar gate, commit `step-NN: <name>`, and end with a STEP-VERDICT block. The executor re-runs the sidecar gates with `gates.sh`; `wf-step-reviewer` re-runs them independently and ends with a REVIEW-VERDICT block — never prose PASS/FAIL. The executor applies the verdict through `ledger-apply`; no model edits ledger rows.

## Steps

- [ ] [step-01-<name>](./step-01-<name>.md) — <one line description>
- [ ] [step-02-<name>](./step-02-<name>.md) — <one line description>
- [ ] [step-03-<name>](./step-03-<name>.md) — <one line description>
```

---

## Executor Tier and Step Sizing

Every plan takes the executor tier as an input, not a planner-chosen output: the `tier` input of the main session procedure (default `deep` — a trial default, not yet a settled choice). In Claude Code only `standard` and `deep` have worker agents. Size every step to that tier using `step-contract`'s tier -> scope table (files touched, distinct concerns, net LOC, permitted architectural decisions, gate-authoring strictness). Record the tier in PROGRESS.md's "Executor Tier" section.

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

Write a `step-NN.gates.json` sidecar next to this file per `step-contract`'s schema — every gate class gets a verdict (`N/A: <reason>` is valid; an omitted class is a planning defect), plus a coverage matrix row for every profile/selector/flag/non-default path this step touches, each naming the gate that exercises it. This is what the executor runs (`gates.sh`) and the reviewer re-runs; the human-readable summary below must not disagree with the sidecar.

- [ ] G-build: `<exact command>` exits 0
- [ ] G-static: `<exact command>` exits 0
- [ ] G-unit: `<exact command>` passes, and fails on the pre-change tree
- [ ] G-e2e-smoke: `<exact command>` observes the real new behavior
- [ ] G-regress: `<exact command>` (scoped suite) passes
- [ ] G-integ: `N/A` unless this is the plan's integration step

If this step touches a Dockerfile, packaging manifest, lockfile, or bundle spec: a real (non-proxy) build/e2e-smoke gate is required in this step — not deferred (First-Artifact Rule, `step-contract`).

## Reviewer Instructions

The reviewer is `wf-step-reviewer` (dispatched by the `executor` skill), not a task string you write per step. It re-runs every gate in the sidecar, checks G-unit fails-before on a throwaway worktree, audits for undeclared proxies and scope creep (`git show --stat`), checks the coverage matrix, and reports missing ledger rows. Its typed verdict schema is `step-contract`'s REVIEW-VERDICT — do not write ad-hoc reviewer prose in the step file.

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


## Model Guide

Models are bound in the agent files (`claude/agents/*.md`), not in task strings. This skill only says
which role agent does the work. A per-run override is a Claude Code alias passed as the `Agent`
call's `model`.

| Role | Agent | Model | Rationale |
|------|-------|-------|-----------|
| Scouts (pre-investigation) | `wf-scout` | haiku | Fast, cheap, code reading |
| Angle planners | `wf-planner` | opus, effort medium | Complex reasoning, architectural tradeoffs |
| Synthesizer (unify / simple mode) | `wf-synthesizer` | fable, effort high | Holding several conflicting plans at once needs the strongest model; simple mode has the same ceiling |
| Fact-check | `wf-fact-checker` | opus, effort medium | Verifies gate commands and cited facts |
| Plan fix pass | `wf-worker` | sonnet, effort medium | Mechanical corrections under a stated scope |

**Why deep tier for planners:** planning requires evaluating architectural tradeoffs, anticipating downstream effects, and writing acceptance criteria precise enough that a different agent can verify them. A standard-tier model tends to produce thinner plans that miss edge cases. Use medium effort, not high/xhigh — cost climbs fast without a proportional quality gain for planning.

---

---

## Common Failures to Avoid

**Vague acceptance criteria:** "Tests pass" is not sufficient. Specify exactly which test command and what must be in the output.

**Missing file:line context:** Step files that say "update the model" without specifying which file and which class force workers to search.

**Duplicate planner angles:** Two planners both covering "database" produce redundant plans the unifier can't synthesize cleanly. Assign angles explicitly and tell each planner what to exclude.

**Planners implementing instead of planning:** Remind planners in the task: "Your deliverable is a plan document, not code. Do not implement anything."

**Context bloat in task strings:** Don't paste the entire investigation report into every planner's task. Extract the facts relevant to their angle.
