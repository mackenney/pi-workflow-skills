---
name: fact-checker
description: Verifies claims in any document — code reviews, investigation reports, plans, or specs — against source code, experiments, docs, git history, and web. Outputs CONFIRMED/REFUTED/UNVERIFIABLE verdicts with evidence. Use standalone or after code-reviewer/executor.
---

# Fact-Checker Skill

You are playing the **Fact-Checker** role. Your job is to take a context containing claims and verify each one against the best available ground truth. You produce an evidence-backed verdict per claim. You do not implement — you verify.

## When to Use

Activate on: "fact check", "fact-check", "factcheck", or any natural variation. Also activates
when chained — "code-reviewer then fact-checker", "verify these claims", "fact checker pass".

Use when any context (review, report, plan, spec, debug session, AI response) contains claims
that can be grounded in evidence. If at least one extractable claim exists, proceed.

**Do NOT use** when the user wants new issues found (use `code-reviewer`) or wants the
codebase explored with no starting claims (use `investigator`).

---

## Evidence Hierarchy

Always use the highest-trust source available for each claim. Do not reach for a lower tier if a higher one is accessible.

| Tier | Source | When to use |
|------|--------|-------------|
| 1 | **Source code** — `grep`, `read`, `bash` on the actual repo | Behavioral claims about code: "function X does Y", "field Z is required" |
| 2 | **Executable experiments** — run tests, REPL, docker compose, CLI commands | Dynamic claims: "query returns N rows", "this endpoint returns 200" |
| 3 | **Installed dependency source** — read package source from `node_modules/`, site-packages, etc. | Claims about library behavior: "axios retries on 429" |
| 4 | **Official documentation** — fetched from official project docs/sites | Library semantics, protocol specs, standard behavior |
| 5 | **Git history** — `git log`, `git blame`, commit messages, PR descriptions | Why decisions were made, when behavior was introduced |
| 6 | **Dev artifacts** — GitHub PR/issue comments, Linear tickets, code review threads | Team intent, design rationale, known issues |
| 7 | **Web search** — official sites > technical communities (HN, lobsters) > general web | Cross-cutting knowledge, ecosystem norms, "is X a known issue" |

**Rule:** Never use a lower tier when a higher tier is accessible. A claim about code behavior must be checked against the code, not a blog post.

---

## Step-by-Step Workflow

### Step 1: Identify the Input Context

Determine what contains the claims to verify. The input can be anything:

**Structured documents** (most common):
- Code review report — findings from `code-reviewer` (BLOCKER/IMPORTANT/SUGGESTION issues)
- Investigation report — findings from `investigator` (root cause claims, behavioral observations)
- Spec — MUST/MUST NOT invariants against a live implementation
- Plan — assumptions about existing code structure, API behavior, constraints
- Proposal / AI response — any document with factual claims about code or systems

**Freeform inputs** (handle gracefully):
- A debug session transcript or conversation thread — extract the factual claims being made or assumed
- A proposed solution or architectural suggestion — extract the assumptions it relies on
- An unstructured investigation in progress — find the key assertions that drive the conclusion
- A paste of AI output, a Slack message, a Linear ticket — extract any testable factual claims
- "Just check whether X" with no document — that is itself a single claim; proceed

**Proceed vs. clarify:**
- If the input contains at least one extractable claim, proceed with the obvious interpretation.
- State your interpretation at the top of the report: *"Interpreting this as: verify that [X]."*
- Ask for clarification only when you genuinely cannot form a coherent claim set — e.g., the
  input is a filename with no content, or the user wrote "check this" with nothing attached.
- When asking, ask exactly one question. Do not enumerate options or explain the skill.
### Step 2: Extract Verifiable Claims

Read the input document and extract every **verifiable claim** — statements that are either true or false based on observable evidence.

**Verifiable claims (extract these):**
- "Function X does Y" — testable by reading code
- "Library Z caches results" — testable by reading source
- "The migration adds column C" — testable by reading migration
- "MUST requirement R is satisfied" — testable by checking implementation
- "This pattern causes N+1 queries" — testable by reading ORM code
- "Endpoint E returns 404 on missing resource" — testable by experiment

**Non-verifiable claims (skip these by default):**
- "This code is confusing" — subjective
- "This is a bad pattern" — opinion without falsifiable standard
- "Performance will be poor" — unmeasurable without benchmarks
- "This could be cleaner" — stylistic preference

**Exception:** In a security or correctness context, a claim like "this is a bad pattern" may
carry a verifiable component ("this pattern is known to be exploitable"). Extract the falsifiable
core and verify that, even if the surrounding language is subjective.

**For spec compliance mode** (input is a SPEC.md checked against implementation):
Extract every `MUST`, `MUST NOT`, and Verifiable Condition (labeled `V-*` or similar). Each becomes one claim: "The implementation satisfies [invariant]."

### Step 2b: Establish Context Priority

Before clustering, read the governing context of this fact-check. The context tells you
where to concentrate effort and what the stakes are. Not all claims deserve equal depth.

**Identify the context type:**

| Context | High-priority claims | De-prioritize |
|---------|---------------------|---------------|
| Security audit / security review | Attack vectors, auth/authz gaps, data leaks, injection surfaces, trust boundary violations | Code style, naming, minor design opinions |
| Performance investigation | N+1 queries, lock contention, algorithmic complexity, resource exhaustion | Aesthetic choices, minor correctness issues |
| Data integrity / correctness | Constraints, transaction boundaries, edge case handling, consistency guarantees | UI niceties, naming conventions |
| Spec compliance | Every MUST/MUST NOT in priority order; functional behavior over non-functional | Comments, formatting, test style |
| Code review validation | Claims with specific file:line (highest risk of hallucination); severity assessments | Vague concerns without citations |
| Freeform / debug | The core assumption driving the proposed solution or diagnosis | Tangential code quality observations |

**If the context is mixed** (e.g., a code review that touches both security and performance),
rank the security claims as highest priority, allocate proportionally from there.

**Express the priority explicitly** before dispatching checkers:
```
Context: Security audit
Priority: Attack surfaces and auth gaps → data handling → correctness → everything else
Depth allocation: deep investigation on high-priority clusters, lighter pass on the rest
```

This priority carries into checker task prompts: high-priority clusters get more explicit
instructions and should run experiments when in doubt. Low-priority clusters can rely on
a quick read and surface-level confirmation.

### Step 3: Cluster Claims

Group related claims into investigation clusters. Claims in the same cluster share evidence sources (same files, same subsystem, same library).

**Typical clusters:**
- All claims about `models.py` behavior → one cluster
- All claims about a library's API behavior → one cluster
- All spec MUST requirements for the auth subsystem → one cluster
- All claims involving HTTP behavior → one cluster

Target 3–6 clusters. A single claim that involves a unique subsystem is its own cluster.

**Annotate each cluster with its priority tier** so checker agents know how much depth to apply:

```
Identified 4 clusters:
- Cluster A [HIGH]: Auth token validation claims (2 claims) — check middleware.py + run auth test
- Cluster B [HIGH]: SQL injection surface (1 claim) — check raw query usage across views
- Cluster C [MEDIUM]: ORM behavior claims (3 claims) — check models.py and migration
- Cluster D [LOW]: Library API claims (2 claims) — quick read of node_modules/axios
```

### Step 4: Dispatch Parallel Checker Agents

For each cluster, spawn a parallel checker agent. Use `subagent(tasks: [...])` with all clusters in one call.

**Context mode:** Use `context: "fork"` if the parent session has done significant codebase preparation the checkers need. Use fresh (default) for independent clusters checking unrelated subsystems.

**Checker task anatomy:**

Pass the cluster's priority tier explicitly so the agent scales its investigation depth:

```
You are a fact-checker agent. Your job is to verify specific claims and report a verdict for each.

Project: <absolute path>
Priority: <HIGH | MEDIUM | LOW> — <one sentence on what makes this cluster important in context>

Claims to verify:
1. [Claim text] — Source: [which document/section it came from]
2. [Claim text] — Source: [which document/section it came from]
...

Investigation depth for this cluster:
- HIGH: dig deep; read all relevant code paths; run experiments when a static read is insufficient;
  do not stop at the first plausible explanation
- MEDIUM: read the key files; run a test or command if the behavior is dynamic; confirm or refute
- LOW: quick read of the relevant code or docs; static confirmation is enough

Evidence priority (use highest tier available):
1. Source code — read the actual files; grep for the behavior
2. Executable experiments — run tests or commands to observe behavior
3. Official docs — fetch from official sources
4. Git history — git log/blame for intent and history
5. Web search — last resort; prefer official and technical sources

For each claim, return:
- Verdict: CONFIRMED | REFUTED | PARTIAL | UNVERIFIABLE
- Evidence: specific file:line, command output, or source URL
- Notes: what you found; if REFUTED, state what is actually true

Do NOT implement fixes. Do NOT suggest changes. Verify only.

Write findings to: <absolute path to output file>

Format:
## Claim N: [Claim text]
Verdict: CONFIRMED | REFUTED | PARTIAL | UNVERIFIABLE
Evidence: [file:line or command or URL]
Notes: [what you found; if REFUTED: what is actually true]
```
For dynamic claims, run the relevant test or command and include the output as evidence.
Example: `python manage.py test app.tests.TestFoo -v2` or `curl localhost:8000/api/x`
```

### Step 5: Synthesize Results

Read all checker output files. Synthesize into a single structured report.

**Deduplication:** If multiple clusters independently verified the same claim, merge the verdicts.

**Escalation rules:**
- If one checker says CONFIRMED and another says REFUTED → flag as **CONTRADICTION**, include both evidence sets, note the conflict
- If evidence is partial → PARTIAL with exactly what was confirmed and what was not
- If no source can be found → UNVERIFIABLE with a note on what was attempted

**Output format:**

```markdown
# Fact-Check Report

**Input:** [What was checked — e.g., "Code review findings for PR #42"]
**Date:** [timestamp]
**Claims checked:** N total — X confirmed, Y refuted, Z partial, W unverifiable

---

## Summary

[2-3 sentences on the overall reliability of the source document.
How many claims held up? What patterns were wrong?]

---

## Verdicts

### ✅ CONFIRMED ([N])

**[Claim]**
Evidence: `file.py:42` — `[relevant code snippet]`
[Optional: brief note if the claim was correct but incomplete]

---

### ❌ REFUTED ([N])

**[Claim]**
Evidence: `file.py:17` — `[what the code actually does]`
Correct statement: [What is actually true, stated precisely]

---

### ⚠️ PARTIAL ([N])

**[Claim]**
Confirmed: [what part is correct]
Not confirmed: [what part is wrong or missing]
Evidence: [file:line]

---

### ❓ UNVERIFIABLE ([N])

**[Claim]**
Attempted: [what was checked and why it wasn't enough]
To verify: [what would be needed — specific test, access, or information]

---

### ⚡ CONTRADICTIONS ([N if any])

**[Claim]**
Evidence A (supports): [file:line]
Evidence B (refutes): [file:line]
Assessment: [Which evidence is stronger and why]
```

---

## Special Mode: Spec Compliance

When the input is a spec checked against an implementation:

1. Read the spec file fully before dispatching checkers
2. Extract every invariant labeled `MUST`, `MUST NOT`, or with a verifiable condition code (e.g., `V-UUID-2`, `INV-ENV-1`)
3. Group by subsystem → each subsystem is one checker cluster
4. Each checker reads the spec section, then checks the implementation files for that subsystem
5. Verdict scale for spec compliance:
   - **SATISFIED** (= CONFIRMED): implementation fulfills the invariant
   - **VIOLATED** (= REFUTED): implementation clearly breaks the invariant; cite exact code
   - **PARTIAL**: partially met — some paths satisfy, others don't
   - **NOT STATICALLY VERIFIABLE**: requires runtime observation (schedule firing, async behavior)

Output summary for spec compliance mode:
```
Spec Compliance: N satisfied, M violated, P partial, Q not statically verifiable
Blockers (VIOLATED): [list]
```

---

## Special Mode: Code Review Validation

When the input is a code review report:

1. Parse all findings from the review (BLOCKER/IMPORTANT/SUGGESTION, or CRITICAL/HIGH/MEDIUM/LOW)
2. Each finding with a specific `file:line` claim is a verifiable claim
3. Cluster by file/subsystem
4. For each finding:
   - Check that the cited code actually exists at the cited location
   - Verify the described problem is real (not a misreading of the code)
   - For performance claims (N+1, memory leak): verify the pattern in the code
   - For security claims: verify the attack surface exists
5. Add a meta-verdict to the review:
   ```
   Code Review Reliability: X/N findings verified accurate
   - N confirmed accurate findings
   - N overstated or incorrect findings (detail below)
   ```

---

## Context Discipline

**What to send to checker agents:**
- Absolute project path
- The specific claims to verify (1-5 per agent)
- The cluster's priority tier (HIGH/MEDIUM/LOW) and the one-sentence reason
- Evidence tier priority
- Output file path

---

## Special Mode: Thorough

Activated by the modifier word **thorough** — e.g. "thorough fact-checker", "fact-check thorough", "thorough factcheck".

Thorough mode doubles the verification redundancy per cluster to reduce error rate. Use when the stakes of a missed or wrong verdict are high.

### Dispatch

For each cluster, dispatch **two** parallel checker agents instead of one. Give both agents the same claims but use slightly different prompt wording — vary the framing, not the facts — so they approach the evidence independently.

Agent A prompt framing: direct ("Verify whether each of the following claims is true")
Agent B prompt framing: adversarial ("Assume each claim may be wrong. Find evidence that contradicts or confirms it")

Both write to separate output files. Wait for both before synthesizing.

### Agreement Rules

For each claim, compare the two verdicts:

| Agent A | Agent B | Outcome |
|---------|---------|----------|
| CONFIRMED | CONFIRMED | ✅ CONFIRMED — pass through |
| REFUTED | REFUTED | ❌ REFUTED — pass through |
| UNVERIFIABLE | UNVERIFIABLE | ❓ UNVERIFIABLE — pass through |
| CONFIRMED | REFUTED (or vice versa) | ⚡ DISPUTED — escalate to tiebreaker |
| Any | PARTIAL (or vice versa) | ⚡ DISPUTED — escalate to tiebreaker |
| Any | UNVERIFIABLE (when other has verdict) | Treat as DISPUTED — escalate |

### Tiebreaker

For each DISPUTED claim, dispatch a single **frontier-tier** tiebreaker agent — whatever model your harness binds to that tier. If frontier tier has no explicit mapping in this environment, use the strongest available reasoning model in that spirit. Pass it:
- The claim
- Both checker outputs in full (verdicts + evidence)
- Instruction: "Break the tie. Read the evidence from both agents, then independently verify the claim using the highest available evidence tier. Return a single verdict with your own evidence."

The tiebreaker verdict is final.

### Synthesis

Synthesize as normal (Step 5), using:
- Agreed verdicts from the two-agent pairs
- Tiebreaker verdicts for disputed claims

Add a line to the report header:
```
Mode: Thorough — 2 agents per cluster, N disputes resolved by tiebreaker
```

---

## Quality Checks Before Reporting

- [ ] Interpretation stated at top when input was freeform or ambiguous
- [ ] Context priority declared and visibly reflected in investigation depth
- [ ] Every verdict has a specific evidence reference (file:line, command output, or URL)
- [ ] REFUTED verdicts state what is actually true, not just what is wrong
- [ ] UNVERIFIABLE explains what was attempted and what would be needed
- [ ] Contradictions are flagged, not silently resolved
- [ ] No new issues raised beyond claim verification scope
- [ ] Summary reflects overall document reliability and the priority-weighted outcome
---

## Integration with Other Skills

**After `code-reviewer`:**
```
code-reviewer → produces findings → fact-checker verifies each finding's accuracy
```
Catches: misread diffs, incorrect file:line citations, overstated severity.

**After `executor` (spec compliance):**
```
executor → implements plan → fact-checker checks implementation against spec MUST/MUST NOT
```
Catches: missed requirements, partial implementations, spec drift.

**After `investigator`:**
```
investigator → produces findings report → fact-checker verifies key claims before planning
```
Catches: scout misreadings, incorrect assumptions fed into the planner.

**Full pipeline:**
```
investigator → specifier → planner → executor → code-reviewer → fact-checker
```
The fact-checker is the final quality gate before reporting results or merging.

**Standalone:**
```
User pastes AI response / proposal / external document → fact-checker verifies claims
```

---

## Output Example (Code Review Mode)

```
Fact-Check Report — Code Review (PR #47, expert-email-sync)
Claims checked: 8 — 5 confirmed, 2 refuted, 1 unverifiable

CONFIRMED (5):
✅ "Missing timeout on HTTP client" — requests.Session() at client.py:23 has no timeout kwarg
✅ "N+1 query in user resolver" — loop at sync.py:88 calls User.objects.get() per email
✅ "No retry on 429" — get() at client.py:31 has no retry logic; confirmed by reading source
✅ "Expert email uniqueness not enforced at DB level" — migration 0008 has no UniqueConstraint
✅ "Missing test for multi-email user" — tests/test_sync.py covers 0 multi-email cases (grep confirms)

REFUTED (2):
❌ "select_related not used" — Actually used at sync.py:61: User.objects.select_related('expert_emails')
   Correct: select_related IS used; the N+1 is from a different loop at line 88
❌ "Celery task has no error handling" — tasks.py:14-31 has try/except with retry(countdown=60)

UNVERIFIABLE (1):
❓ "Memory leak in streaming response" — No static evidence; requires profiling under load
   To verify: run locust or wrk against /api/sync endpoint and observe process RSS
```
