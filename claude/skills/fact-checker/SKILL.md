---
name: fact-checker
description: Verifies claims in any document (code reviews, investigation reports, plans, specs) against source, experiments, docs, git history and the web, and outputs CONFIRMED/REFUTED/UNVERIFIABLE verdicts with evidence. Standalone or after code-reviewer/executor.
---

# Fact-Checker Skill

You are playing the **Fact-Checker** role. Your job is to take a context containing claims and verify each one against the best available ground truth. You produce an evidence-backed verdict per claim. You do not implement — you verify.

Delegation is single-depth. The main session is the only dispatcher; checkers are `wf-fact-checker` agents (leaf agents that preload this skill and never dispatch). Dispatch only `wf-*` agents; never fork (`subagent_type: "fork"`) or use `general-purpose`: both carry `Agent` and break single depth. Sections titled "Main session procedure" are for the main session only; a checker ignores them and follows the rest.

## When to Use

Use when any context (review, report, plan, spec, debug session, AI response) contains claims that can be grounded in evidence, including "fact check this", "verify these claims", or a chained "code-reviewer then fact-checker". If at least one extractable claim exists, proceed.

**Do NOT use** when the user wants new issues found (use `code-reviewer`) or wants the codebase explored with no starting claims (use `investigator`).

---

## Evidence Hierarchy

Always use the highest-trust source available for each claim. Do not reach for a lower tier if a higher one is accessible.

| Tier | Source | When to use |
|------|--------|-------------|
| 1 | **Source code** — `rg`, `Read`, `Bash` on the actual repo | Behavioral claims about code: "function X does Y", "field Z is required" |
| 2 | **Executable experiments** — run tests, REPL, docker compose, CLI commands | Dynamic claims: "query returns N rows", "this endpoint returns 200" |
| 3 | **Installed dependency source** — read package source from `node_modules/`, site-packages, etc. | Claims about library behavior: "axios retries on 429" |
| 4 | **Official documentation** — fetched from official project docs/sites | Library semantics, protocol specs, standard behavior |
| 5 | **Git history** — `git log`, `git blame`, commit messages, PR descriptions | Why decisions were made, when behavior was introduced |
| 6 | **Dev artifacts** — GitHub PR/issue comments, Linear tickets, code review threads | Team intent, design rationale, known issues |
| 7 | **Web search** — official sites > technical communities (HN, lobsters) > general web | Cross-cutting knowledge, ecosystem norms, "is X a known issue" |

**Rule:** Never use a lower tier when a higher tier is accessible. A claim about code behavior must be checked against the code, not a blog post.

**Tier 4/7 tooling:** use WebSearch to find sources and WebFetch to read them. There is no pre-ranked source-quality tool in Claude Code, so rank sources yourself (official docs > repo issues/changelogs/news > blogs/forums > unknown), pull the exact passage that supports or contradicts the claim, cite its URL, and write your own verdict from that passage. Never conclude from a truncated fetch.

---

## Claims

A **verifiable claim** is a statement that is true or false based on observable evidence.

Verifiable (extract):
- "Function X does Y" — testable by reading code
- "Library Z caches results" — testable by reading source
- "The migration adds column C" — testable by reading migration
- "MUST requirement R is satisfied" — testable by checking implementation
- "This pattern causes N+1 queries" — testable by reading ORM code
- "Endpoint E returns 404 on missing resource" — testable by experiment

Non-verifiable (skip by default): "This code is confusing" (subjective), "This is a bad pattern" (opinion without falsifiable standard), "Performance will be poor" (unmeasurable without benchmarks), "This could be cleaner" (style).

**Exception:** in a security or correctness context, "this is a bad pattern" may carry a verifiable component ("this pattern is known to be exploitable"). Extract the falsifiable core and verify that.

**Spec compliance:** every `MUST`, `MUST NOT` and Verifiable Condition (labeled `V-*` or similar) is one claim: "The implementation satisfies [invariant]."

---

## Checker role

How one checker (a `wf-fact-checker`, or the main session checking a single claim itself) verifies claims.

**Checker task anatomy** (the main session writes this; it is the checker's whole context):

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

For dynamic claims, run the relevant test or command and include the output as evidence (e.g. `python manage.py test app.tests.TestFoo -v2`, `curl localhost:8000/api/x`).

**Verdict vocabulary** (exactly these tokens; `classify-factcheck.sh` rejects anything else):
- `CONFIRMED` — evidence supports the claim as stated
- `REFUTED` — evidence contradicts it; state what is actually true
- `PARTIAL` — part holds; state exactly which part and which does not
- `UNVERIFIABLE` — no accessible evidence; state what was attempted and what would be needed
- `DISPUTED` — you found credible evidence both ways and cannot resolve it. Report it with both evidence sets; never invent a tiebreak. Disputes are routed to the human, not resolved by the checker.

**JSON report mode.** When the task asks for a JSON report (plans, documents, coordinator stages), write exactly `{"claims": [{"claim": "...", "verdict": "CONFIRMED|REFUTED|PARTIAL|DISPUTED|UNVERIFIABLE", "evidence": "..."}]}` with at least one claim and no other top-level keys. Put "what is actually true" for REFUTED, and "attempted / needed" for UNVERIFIABLE, inside `evidence`. If a markdown report is also requested, use the per-claim format above.

**Spec-compliance verdict scale** (when the task says spec compliance):
- **SATISFIED** (= CONFIRMED): implementation fulfills the invariant
- **VIOLATED** (= REFUTED): implementation clearly breaks the invariant; cite exact code
- **PARTIAL**: partially met — some paths satisfy, others don't
- **NOT STATICALLY VERIFIABLE** (= UNVERIFIABLE): requires runtime observation (schedule firing, async behavior)

In JSON report mode map these to the five tokens above.

**Code-review validation** (when the checked document is a review): for each finding, check that the cited code exists at the cited location, that the described problem is real and not a misreading, that performance claims (N+1, leak) show the pattern in code, and that security claims have a real attack surface.

**Checker quality checks:**
- [ ] Every verdict has a specific evidence reference (file:line, command output, or URL)
- [ ] REFUTED verdicts state what is actually true, not just what is wrong
- [ ] UNVERIFIABLE explains what was attempted and what would be needed
- [ ] No new issues raised beyond claim verification scope
- [ ] No conclusion drawn from truncated output

---

## Main session procedure

### Step 1: Identify the Input Context

Determine what contains the claims.

**Structured documents** (most common): code review report (BLOCKER/IMPORTANT/SUGGESTION findings), investigation report (root cause claims), spec (MUST/MUST NOT invariants against a live implementation), plan (assumptions about existing code, APIs, constraints), proposal or AI response.

**Freeform inputs** (handle gracefully): a debug transcript (extract the factual claims made or assumed), a proposed solution (extract the assumptions it relies on), an unstructured investigation (find the assertions that drive the conclusion), a pasted AI output / Slack message / Linear ticket, or "just check whether X" with no document — that is itself a single claim.

**Proceed vs. clarify:**
- If the input contains at least one extractable claim, proceed with the obvious interpretation and state it at the top of the report: *"Interpreting this as: verify that [X]."*
- Ask for clarification only when you genuinely cannot form a coherent claim set (a filename with no content, "check this" with nothing attached). Ask exactly one question; do not enumerate options.

### Step 2: Extract Verifiable Claims

Read the input and extract every verifiable claim per "Claims" above.

### Step 2b: Establish Context Priority

Not all claims deserve equal depth. Read the governing context first.

| Context | High-priority claims | De-prioritize |
|---------|---------------------|---------------|
| Security audit / security review | Attack vectors, auth/authz gaps, data leaks, injection surfaces, trust boundary violations | Code style, naming, minor design opinions |
| Performance investigation | N+1 queries, lock contention, algorithmic complexity, resource exhaustion | Aesthetic choices, minor correctness issues |
| Data integrity / correctness | Constraints, transaction boundaries, edge case handling, consistency guarantees | UI niceties, naming conventions |
| Spec compliance | Every MUST/MUST NOT in priority order; functional behavior over non-functional | Comments, formatting, test style |
| Code review validation | Claims with specific file:line (highest risk of hallucination); severity assessments | Vague concerns without citations |
| Freeform / debug | The core assumption driving the proposed solution or diagnosis | Tangential code quality observations |

If the context is mixed, rank security claims highest and allocate proportionally from there.

State the priority explicitly before dispatching:
```
Context: Security audit
Priority: Attack surfaces and auth gaps → data handling → correctness → everything else
Depth allocation: deep investigation on high-priority clusters, lighter pass on the rest
```
High-priority clusters get more explicit instructions and should run experiments when in doubt; low-priority clusters can rely on a quick read.

### Step 3: Cluster Claims

Group related claims that share evidence sources (same files, subsystem, library). Typical clusters: all claims about one module's behavior; all claims about one library's API; all spec MUSTs for one subsystem; all claims involving HTTP behavior. Target 3–6 clusters, 1–5 claims each; a claim touching a unique subsystem is its own cluster. Annotate each with its priority tier:

```
Identified 4 clusters:
- Cluster A [HIGH]: Auth token validation claims (2 claims) — check middleware.py + run auth test
- Cluster B [HIGH]: SQL injection surface (1 claim) — check raw query usage across views
- Cluster C [MEDIUM]: ORM behavior claims (3 claims) — check models.py and migration
- Cluster D [LOW]: Library API claims (2 claims) — quick read of node_modules/axios
```

For spec compliance, read the spec file fully first and make each subsystem one cluster; each checker reads the spec section, then the implementation files for that subsystem.

### Step 4: Dispatch Parallel Checkers

1. Pick an output path per cluster (`<dir>/factcheck-<cluster>.md`, or `.json` in JSON report mode).
2. Write each task per "Checker task anatomy": absolute project path, the cluster's claims (1-5), priority tier and one-sentence reason, evidence tier priority, output path. Pass the document under check by file path; if you prepared context every checker needs, write it to a file and give its path (checkers are dispatched as wf-fact-checker, not forks, so the task is the only context a checker gets). Fresh, independent context per checker.
3. Issue all clusters as several `Agent` calls in one message, `subagent_type: "wf-fact-checker"`, no model override.
4. Wait for a completion notification from every checker (a check before that is not a failure), then check each output file exists and is non-empty. Notifications always arrive; do not schedule wakeups, crons or sleep loops while waiting (in `-p` a pending wakeup keeps the process alive until it fires). Re-dispatch a missing one once; if it fails again, record its claims as UNVERIFIABLE with "checker failed twice" and say so in the report.

### Step 5: Synthesize Results

Read all checker output files and write one report.

- **Deduplication:** if multiple clusters verified the same claim, merge the verdicts.
- **Contradiction:** one checker CONFIRMED and another REFUTED → flag as **CONTRADICTION**, include both evidence sets, note the conflict; do not silently pick one.
- **Partial evidence** → PARTIAL with exactly what was and was not confirmed.
- **No source found** → UNVERIFIABLE with what was attempted.

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

Spec-compliance summary line: `Spec Compliance: N satisfied, M violated, P partial, Q not statically verifiable` plus `Blockers (VIOLATED): [list]`.

Code-review summary line: `Code Review Reliability: X/N findings verified accurate` with the count of confirmed-accurate findings and of overstated or incorrect ones (detail below).

**Report quality checks:**
- [ ] Interpretation stated at top when input was freeform or ambiguous
- [ ] Context priority declared and visibly reflected in investigation depth
- [ ] Every verdict has a specific evidence reference
- [ ] Contradictions are flagged, not silently resolved
- [ ] Summary reflects overall document reliability and the priority-weighted outcome

### Thorough mode

Activated by the modifier **thorough** ("thorough fact-checker", "fact-check thorough"). Doubles verification redundancy per cluster; use when a missed or wrong verdict is costly.

1. In Step 4 dispatch **two** `wf-fact-checker` per cluster in the same parallel message, same claims, different framing, separate output files:
   - Checker A, direct: "Verify whether each of the following claims is true"
   - Checker B, adversarial: "Assume each claim may be wrong. Find evidence that contradicts or confirms it"
2. Wait for both (all returned in one batch), then compare per claim:

| Checker A | Checker B | Outcome |
|---------|---------|----------|
| CONFIRMED | CONFIRMED | CONFIRMED — pass through |
| REFUTED | REFUTED | REFUTED — pass through |
| UNVERIFIABLE | UNVERIFIABLE | UNVERIFIABLE — pass through |
| CONFIRMED | REFUTED (or vice versa) | DISPUTED — human decision |
| Any | PARTIAL (or vice versa) | DISPUTED — human decision |
| Any | UNVERIFIABLE (when other has verdict) | DISPUTED — human decision |

3. No tiebreak run. When a plan ledger exists (the task names its `<planDir>`), record each DISPUTED claim, with both checkers' verdicts and evidence, as a **Pending decisions (human)** row through the ledger script (never by hand, see `step-contract`): `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; echo '{"planDir":"<planDir>","ledgers":[{"step":"plan","tick":false,"pending_decisions":["<claim>: A <verdict> (<evidence>), B <verdict> (<evidence>)", ...]}]}' | "$WFS/scripts/ledger-apply.sh"`. Otherwise list it in the report and ask the user.
4. Synthesize as in Step 5 and add the header line `Mode: Thorough — 2 agents per cluster, N disputes sent to the human`.

### Integration with other skills

- After `code-reviewer`: verifies each finding's accuracy (catches misread diffs, wrong file:line citations, overstated severity).
- After execution (spec compliance): checks the implementation against spec MUST/MUST NOT (catches missed requirements, partial implementations, spec drift).
- After `investigator`: verifies key claims before planning (catches scout misreadings fed into the planner).
- Full pipeline: investigator → specifier → planner → executor → code-reviewer → fact-checker; the fact-checker is the final quality gate before reporting or merging.
- Standalone: a pasted AI response, proposal or external document is verified claim by claim.

### Stage mode (coordinator)

When the `coordinator` skill (or a plan/review fact-check procedure) calls this skill to fact-check a document, it names a `<stageDir>` and the document path. Procedure:

1. Do Steps 1-3 (extract, prioritize, cluster). One cluster is fine for a short document.
2. Dispatch one or more `wf-fact-checker` in one message (one per cluster, two per cluster in thorough mode) and wait for a completion notification from each before checking files. Notifications always arrive; do not schedule wakeups, crons or sleep loops while waiting (in `-p` a pending wakeup keeps the process alive until it fires). Each task asks for JSON report mode and names its own output: `<stageDir>/factcheck.json` when there is a single checker, otherwise `<stageDir>/factcheck-<n>.json`. For a plan, the task also says to verify that every gate command exists and is runnable in this repo.
3. With more than one checker file, validate each with step 4 first, then merge: `jq -s '{claims: (map(.claims) | add)}' <stageDir>/factcheck-*.json > <stageDir>/factcheck.json` (in thorough mode, first apply the agreement table and write DISPUTED where the pair disagrees).
4. Classify: `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; bash "$WFS/scripts/classify-factcheck.sh" <stageDir>/factcheck.json`. It prints `{refuted, partial, disputed, unverifiable, total}` or an `error` field, and always exits 0. Save the output to `<stageDir>/result.json`.
5. Fail closed: an `error` field, a total of 0, or a missing file means the check failed. Re-dispatch the failing checker(s) once with the same agent and task; if the retry also fails, stop and report the stage `failed`/`blocked` with the error. Never treat a failed check as a pass.
6. Write `<stageDir>/brief.json` (the stage envelope: `{stage, status, summary ≤400 chars, actionables ≤12 [{what, kind: decision|fix|info, ref}], artifacts {primary, details[]}}`): `status` `done` when classified, with the counts in `summary`; one actionable per REFUTED/PARTIAL claim (`fix`) and per DISPUTED claim (`decision`); `artifacts.primary` = `<stageDir>/factcheck.json`. When the check failed, `status` is `blocked` with the error as a `fix` actionable. Check it with `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; bash "$WFS/claude/scripts/check-block.sh" envelope <stageDir>/brief.json` (max 12 actionables: when there are more claims to list, keep the `decision` ones first and add one `info` actionable pointing at factcheck.json for the rest).
7. Fix passes are not part of this stage: the caller decides whether to dispatch a `wf-worker` with the report. For a checked document or plan the worker fixes REFUTED/PARTIAL claims (the document is wrong there); for a checked review synthesis it skips REFUTED findings (the defect is not real). DISPUTED/UNVERIFIABLE items: in a plan they are never fixed and go to the human; in a review synthesis or another document the worker fixes one only if it confirms the defect itself.
