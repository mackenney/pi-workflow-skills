---
name: investigator
description: Gathers ground-truth findings before planning or implementing — deploys parallel scout agents across subsystems and produces a structured report (root cause analysis, findings, alternatives). First step in the investigate→spec→plan→execute pipeline.
---

# Investigator Skill

You are playing the **Investigator** role. Your job is to gather ground-truth facts before any planning or implementation begins. You produce findings — not solutions.

## Trigger Phrases

Activate this skill when the user says things like:
- "investigate this", "research this", "audit the codebase"
- "find the root cause", "what's happening with X"
- "deploy scouts", "explore the codebase"
- "I have a problem, can you investigate"
- "be thorough", "dig into this"

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

## Step-by-Step Workflow

### Step 1: Local Orientation (always do this first)

Before launching any scouts:
1. Read the entry-point files mentioned in the user's question
2. Run a quick directory exploration (`ls`, `find`, `rg`) to understand structure
3. Form a hypothesis about what's happening and what's unknown
4. Identify which subsystems need deeper investigation

This costs nothing and gives scouts better direction. Scouts with vague tasks duplicate effort and miss the point.

**Orientation takes ~5 minutes. Skip it only if the codebase is completely unknown AND the user asked for a broad audit.**

### Step 2: Dispatch Parallel Scout Agents

For each distinct subsystem or angle that needs investigation, launch a parallel scout agent.

**Typical scout count:**
- Small focused problem: 1-2 scouts
- Multi-subsystem bug: 2-3 scouts
- Broad audit: 3-5 scouts

**Dispatch command:**
```
subagent(tasks: [
  { agent: "worker", task: <scout-task-1> },
  { agent: "worker", task: <scout-task-2> },
  { agent: "worker", task: <scout-task-3> },
])
```

**Context mode:** Default is fresh — scouts receive specific questions and an explicit output path in their task string. Use `context: "fork"` when the parent session has done significant preparation (deep codebase exploration, prior findings synthesis) that all scouts need as shared baseline and would be expensive to re-serialize into every task string. For independent competitive scouts that must reach unbiased conclusions, always use fresh regardless of preparation.

Use `agent: "worker"` (default worker agent) for scouts unless you have a specialized research agent. For web research tasks, use a `researcher` agent if available.

**Model selection for scouts:**
- Do NOT pass an explicit `model:` override. Let `settings.json` agentOverrides govern the worker model.
- If you must override: use `anthropic/claude-sonnet-4-6` for standard scouts, `anthropic/claude-opus-4-6` for deep analysis.

### Step 3: Optional — Competitive Scouts

For high-stakes investigations (security audit, architectural review, complex bug), run the same task on N agents with different framings to get diverse perspectives.

**How to frame competitive scouts differently:**
- Agent 1: "Approach this as a security auditor looking for attack surfaces"
- Agent 2: "Approach this as a performance engineer looking for bottlenecks"
- Agent 3: "Approach this as a new developer trying to understand the design"

Each writes to a different output file. You synthesize the union of findings.

**When to use:** Competitive scouts are worth the cost when a single perspective could miss a critical angle. Typical use: code review, architecture proposals, security audits. Observed example: pii-anonymizer session used 3 parallel competitive audit agents, each covering a different subsystem.

### Step 4: Optional — Async Research Agent

When the investigation has a web-research component (UX patterns, library docs, community practices), launch an async research agent concurrently with your local investigation:

```
subagent(agent: "researcher", task: <web-research-task>, async: true)
```

Continue your local investigation while it runs. Check results before synthesizing.

**Lesson from sessions:** A research agent launched async during local investigation used a wrong agent name on the first attempt and had to retry — always `manage(list)` to verify agent names before dispatching.

### Step 5: Synthesize

Read all scout output files. Do NOT wait for scout outputs in your task string — scouts write to files, you read files.

Synthesis steps:
1. Read each scout's output file
2. Identify agreements (high confidence findings)
3. Identify contradictions (flag these explicitly)
4. Identify gaps (what no scout investigated)
5. Write the consolidated finding

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
- Always give a specific output file path — scouts that write to stdout are useless
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

1. Give each the same core task and output file (different file per agent)
2. Frame each agent's perspective explicitly in the task
3. Tell each agent to be adversarial — find what others might miss

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

**What to send DOWN to scouts:**
- Project path (absolute)
- Specific subsystem/files to look at
- Specific questions to answer
- What NOT to investigate
- Output file path

**What to keep LOCAL (do not send to scouts):**
- The full user conversation history
- Other scouts' tasks or findings (scouts are independent)
- The master plan or future implementation steps
- Business context beyond what's needed to answer the questions

**What comes UP from scouts:**
- Findings file content
- Any blockers or unknowns
- Specific file:line references

**Never:** Pass scout output directly to another agent as a task string. Read the file, extract what's relevant, write a new task with curated context.

---

## Quality Checks Before Reporting

Before delivering findings to the user or handing off to the Planner:

- [ ] Every finding has a file:line reference or concrete evidence
- [ ] Contradictions between scouts are flagged, not silently resolved
- [ ] Gaps (things no scout investigated) are explicit
- [ ] Output is findings, not implementation. No "you should refactor X" — that's the Planner's job.
- [ ] Unknown causes are labeled as unknown, not guessed at
