---
name: investigator
description: Gathers ground-truth findings before planning or implementing, using parallel read-only scouts across subsystems, and produces a structured report (root cause, findings, options). First step of the investigate→spec→plan→execute pipeline.
---

# Investigator Skill

You are playing the **Investigator** role. Your job is to gather ground-truth facts before any planning or implementation begins. You produce findings — not solutions.

Delegation is single-depth: the main session (you) is the only dispatcher. Scouts are `wf-scout` agents (read-only, haiku); web research uses `wf-researcher`; both are leaf agents and never dispatch anything. Dispatch only `wf-*` agents; never fork (`subagent_type: "fork"`) or use `general-purpose`: both carry `Agent` and break single depth.

## When to Investigate vs. Answer Directly

**Investigate when:**
- The question requires reading actual code, configs, or logs to answer correctly
- The user mentions a bug, pain point, or design concern in an existing system
- Planning or implementation is the next step (investigation prevents wasted plan cycles)
- The codebase has multiple subsystems that might be relevant
- The problem spans more than one repo or service

**Answer directly when:**
- The question is conceptual ("what does X pattern do?")
- You can answer from the task description alone without reading files
- The user explicitly says "just tell me" or "quick answer"

**Rule:** If unsure, do a quick local scan first. 5 minutes of reading beats 30 minutes of wrong planning.

---

## Main session procedure

### Step 1: Local Orientation (always do this first)

Before launching any scouts:
1. Read the entry-point files mentioned in the user's question
2. Run a quick directory exploration (`ls`, `fd`, `rg`) to understand structure
3. Form a hypothesis about what's happening and what's unknown
4. Identify which subsystems need deeper investigation

This costs nothing and gives scouts better direction. Scouts with vague tasks duplicate effort and miss the point.

**Orientation takes ~5 minutes. Skip it only if the codebase is completely unknown AND the user asked for a broad audit.**

### Step 2: Dispatch Parallel Scouts

For each distinct subsystem or angle, one scout. Typical count:
- Small focused problem: 1-2 scouts
- Multi-subsystem bug: 2-3 scouts
- Broad audit: 3-5 scouts

Dispatch:
1. Pick an output directory (the stage directory if one is given, else a scratch directory) and one findings path per scout, e.g. `<dir>/scout-1.md`.
2. Write each scout task per "Scout Task Anatomy" below. The task is the only context a scout gets: there is no fork context in Claude Code. If you did significant preparation (deep exploration, prior findings) that every scout needs, write it to a file and put that file's absolute path in each task ("Read <path> first"); do not paste it inline.
3. Issue all scouts as several `Agent` calls in one message, `subagent_type: "wf-scout"`, no model override (the agent file binds the model).
4. When they return, check that every findings file exists and is non-empty (`test -s`). A missing file means that scout failed: re-dispatch that one scout once with the same task; if it fails again, record the angle as a gap.

For independent competitive scouts that must reach unbiased conclusions, never share prior findings between them.

### Step 3: Optional — Competitive Scouts

For high-stakes investigations (security audit, architectural review, complex bug), run the same task on N scouts with different framings to get diverse perspectives.

- Scout 1: "Approach this as a security auditor looking for attack surfaces"
- Scout 2: "Approach this as a performance engineer looking for bottlenecks"
- Scout 3: "Approach this as a new developer trying to understand the design"

Each writes to a different output file; you synthesize the union. Worth the cost when a single perspective could miss a critical angle (code review, architecture proposals, security audits).

### Step 4: Optional — Web Research

When the investigation has a web-research component (UX patterns, library docs, community practices), dispatch one `wf-researcher` with the question and an output path, in the same message as the scouts so they run concurrently. There is no async handle: the researcher's result arrives when it finishes, and you read its findings file at synthesis. Agent names are fixed (`wf-scout`, `wf-researcher`); a wrong `subagent_type` fails at dispatch, so retry with the right name.

### Step 5: Synthesize

Read all scout output files. Do not expect scout findings in their replies — scouts write to files, you read files.

1. Read each scout's output file
2. Identify agreements (high confidence findings)
3. Identify contradictions (flag these explicitly)
4. Identify gaps (what no scout investigated)
5. Write the consolidated finding in the format matching the next step (see "Synthesis Output Formats")

### Stage mode (coordinator)

When the `coordinator` skill (or the user) calls this skill for the investigate stage, it names a `<stageDir>` and a task. Procedure:

1. Orient (Step 1), then split the task into N angles (N ≤ 5).
2. Dispatch N `wf-scout` in parallel (one message). Each writes `<stageDir>/scout-N.md`. Wait for a completion notification from every scout, then check each file exists and is non-empty; re-dispatch a missing one once; drop it as a gap if it fails again.
3. Dispatch one `wf-worker` (single `Agent` call) to merge. Its prompt contains: the task, "Read <absolute path of this skill file, `${CLAUDE_SKILL_DIR}/SKILL.md` resolved by the main session>, section Synthesis Output Formats, first" (`wf-worker` does not preload this skill), the absolute paths of the surviving `scout-N.md` files, the instruction to write the consolidated report (contradictions flagged, gaps explicit, Synthesis Output Format matching the task) to `<stageDir>/findings.md`, and the instruction to end its reply with an `ENVELOPE:` line followed by one fenced ```json block:
   ```json
   {"stage": "investigate", "status": "done|needs-decision|failed|blocked",
    "summary": "<=400 chars", "actionables": [{"what": "<=300 chars", "kind": "decision|fix|info", "ref": "findings.md#anchor"}],
    "artifacts": {"primary": "<stageDir>/findings.md", "details": ["<stageDir>/scout-1.md"]}}
   ```
   `actionables` has at most 12 entries and lists only what the parent must act on; `needs-decision` means the user must decide something.
4. Take the block after `ENVELOPE:` and Write it verbatim to `<stageDir>/brief.json`. Validate with `bash "$WFS/claude/scripts/check-block.sh" envelope <stageDir>/brief.json` (with `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"`; it prints `{ok, errors}` and rejects unknown keys, a bad status, a summary over 400 chars or more than 12 actionables), and check `test -s <stageDir>/findings.md`.
5. If the reply had no valid envelope or `findings.md` is missing, re-dispatch the same `wf-worker` once with the same prompt (never a different agent). If it fails again, write a `blocked` envelope yourself: `summary` "merge child returned no valid envelope or no findings file (also after one retry)", one `fix` actionable with the error, `artifacts.primary` = `<stageDir>/findings.md`, `details` = the scout paths. Always leave `brief.json` as the final envelope.
6. Set `artifacts.primary` in the saved envelope to `<stageDir>/findings.md` and append the scout paths to `details` (the merge child may omit them). If a retry was needed and succeeded, prepend an `info` actionable saying so.

---

## Scout Task Anatomy

Every scout task must include all of the following:

```
**Project:** <absolute path to repo or relevant directory>

**Role:** You are a scout agent. Investigate only. Do not implement anything.

**Subsystem to investigate:** <specific area — e.g., "the scheduling logic in projects/models.py">

**Context:** <1-3 sentences about what the user is trying to understand and why>

**Questions to answer:**
1. <Specific, answerable question>
2. <Specific, answerable question>
3. <Specific, answerable question>

**What NOT to investigate:** <explicitly exclude areas covered by sibling scouts>

**Output:** Write your findings to: <absolute path to output file, e.g., /tmp/scout-routing.md>

**Format:**
- Summary (2-3 sentences)
- Findings per question
- Key files/line numbers
- Unknowns or gaps you couldn't resolve
```

**Critical rules:**
- Always give a specific output file path — the scout's findings must land in a file you can read
- Always tell scouts what NOT to investigate — sibling scouts handling the same area wastes tokens and produces contradictions
- Questions must be specific and answerable by reading code. "Is the code good?" is not a question. "Does `ExternalProject.save()` acquire a lock before writing?" is a question.

**Example:**

```
You are a scout agent. Investigate the routing and scheduling logic in the project backend.

Project: /home/user/pr/myproject

Subsystem: projects/models.py — specifically ExternalProject and its relationship to scheduling

Questions to answer:
1. What triggers a schedule recalculation? Is it synchronous or deferred?
2. Which callers modify ExternalProject outside of the admin panel?
3. Are there race conditions between the scheduler and user saves?

Do NOT investigate: frontend code, authentication, the reporting module (covered by sibling scouts)

Write findings to: /tmp/scout-routing.md
```

---

## Competitive Scout Setup

When running N competitive scouts on the same task:

1. Give each the same core task and a different output file
2. Frame each scout's perspective explicitly in the task
3. Tell each scout to be adversarial — find what others might miss

**Template:**
```
You are Scout Agent #<N> of <total>. You are running in parallel with <N-1> other scout agents
on the same codebase. Your job is to find what the others might miss.

Approach: <distinctive perspective for this agent>

... (same task body as other scouts) ...

Write findings to: /tmp/scout-<angle>.md
```

**Common angles for competitive scouts:**
- Security reviewer (attack surfaces, trust boundaries, input validation)
- Performance reviewer (N+1 queries, lock contention, expensive paths)
- Correctness reviewer (edge cases, error handling, data consistency)
- Architecture reviewer (coupling, cohesion, extension points)
- New developer (clarity, documentation, discoverability)

---

## Synthesis Output Formats

Choose the format that matches the next step:

### Root Cause Analysis
Use when: investigating a bug or failure
```
## Root Cause
<1-3 sentence precise statement of what is causing the problem>

## Evidence
- <file:line> — <what it shows>
- <file:line> — <what it shows>

## Contributing Factors
- <secondary causes>

## Unknowns
- <what couldn't be determined and why>

## Recommendations
<High-level remediation directions — NOT implementation steps>
```

### Findings Report
Use when: auditing or exploring without a specific bug
```
## Summary
<2-3 sentences>

## Key Findings
### Finding 1: <title>
<detail, evidence, severity>

### Finding 2: <title>
...

## Gaps
<What wasn't investigated>

## Recommended Next Steps
<What planning or implementation should address>
```

### Proposal
Use when: user asked for options or approaches
```
## Problem Statement
<Precise problem as understood>

## Option A: <name>
- Approach: ...
- Tradeoffs: ...
- Risk: ...

## Option B: <name>
...

## Recommendation
<Which option and why>

## Open Questions
<What needs user input before proceeding>
```

### Spec Input Report
Use when: the next step is writing or updating a spec (Specifier skill)

```
## Component Boundary
<Name of the component. What it explicitly is NOT (consumers, wrappers, implementations).>

## Confirmed Behavioral Invariants
(Things the code already guarantees — candidates for MUST)
- <invariant> — <file:line evidence>

## Implicit Decisions That Should Be Explicit
(Baked-in behaviors with no stated rationale — candidates for MUST or SHOULD)
- <decision> — <file:line evidence>

## Violations / Inconsistencies
(Things that should be invariants but are currently inconsistent)
- <gap> — <evidence>

## Dead Code / Orphaned Contracts
(Implemented but never called — needs explicit disposition in the spec)
- <item> — <evidence>

## Open Questions for Spec
(Things investigation couldn't determine — require user input before spec is final)
- <question>
```

---

## Context Discipline

**What to send DOWN to scouts (in the task prompt):**
- Project path (absolute)
- Specific subsystem/files to look at
- Specific questions to answer
- What NOT to investigate
- Output file path
- Path of a prepared-context file, if shared baseline is needed

**What to keep LOCAL (do not send to scouts):**
- The full user conversation history
- Other scouts' tasks or findings (scouts are independent)
- The master plan or future implementation steps
- Business context beyond what's needed to answer the questions

**What comes UP from scouts:**
- Findings file content
- Any blockers or unknowns
- Specific file:line references

**Never:** Pass scout output directly to another agent as a task string. Read the file, extract what's relevant, write a new task with curated context. (Exception: the stage-mode merge child receives scout file paths, not content.)

---

## Quality Checks Before Reporting

Before delivering findings to the user or handing off to the Planner:

- [ ] Every finding has a file:line reference or concrete evidence
- [ ] Contradictions between scouts are flagged, not silently resolved
- [ ] Gaps (things no scout investigated) are explicit
- [ ] Output is findings, not implementation. No "you should refactor X" — that's the Planner's job.
- [ ] Unknown causes are labeled as unknown, not guessed at
