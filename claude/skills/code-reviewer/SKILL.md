---
name: code-reviewer
description: Competitive multi-agent code review of uncommitted changes, a branch or a GitHub PR. Independent reviewers find issues, cross-examine each other (skip with no-x-check), a synthesis merges them into actionable feedback; optionally fact-checked, fixed in bounded rounds, posted to GitHub or saved. Use when changes are ready for critique.
---

# Code Reviewer Skill

Competitive multi-agent review: independent reviewers analyze the change in parallel, each from an
angle; by default they cross-examine each other's findings (confirm, dispute with a reason, or flag
duplicates); a synthesis merges everything into actionable feedback. In a review loop
(`(code-reviewer -> fact-checker -> fix) xN`) the synthesis is fact-checked and verified findings are
fixed, round by round.

This skill is read by two audiences:
- **The main session** that runs `/code-reviewer`: it follows the "Main session procedure" sections
  and is the only dispatcher. Dispatch only `wf-*` agents; never fork (`subagent_type: "fork"`) or use `general-purpose`: both carry `Agent` and break single depth.
- **`wf-code-reviewer`**, which preloads this skill: it follows "Reviewer role" and ignores the
  main-session sections.

**Do not use** mid-edit (changes intentionally half-written), for syntax/lint-only checks, or when
the user wants an explanation rather than critique.

Prerequisites: a git repository; `gh` CLI for PR reviews.

## Flags and options

| Option | Default | Effect |
|---|---|---|
| `no-x-check` (also "skip cross-check", "no cross-check") / `crossExam: false` | cross-exam on | Skip cross-examination: N+1 agent calls instead of 2N+1 |
| `angles` | `correctness`, `security-and-failure-modes`, `tests-and-gate-coverage` | Names or a count (2–4). Each reviewer carries the full criteria; the angle is a bias, not an exclusive lane |
| `maxRounds` | 1 standalone, 2 in a coordinator `review` stage | Review rounds; the loop stops at the first clean round |
| `fixScope` | `none` standalone (report only); from the chain in a coordinator stage | `clear` / `trivial` / `all` / `none` (see R5) |
| `diversityModel` | off | `"sonnet"` (or another alias): the last angle runs on that model instead of opus. Replaces pi's cross-vendor GPT lane; only model-size diversity remains, not vendor diversity |
| `baseRef` | merge-base with the base branch | Pins the review range across fix rounds |
| `reviewerModel` / `factcheckModel` / `fixModel` | agent defaults (opus / opus / sonnet) | Claude Code aliases passed as the `Agent` call's `model`, always with that tier's `effort` (fable `high`, opus/sonnet `medium`, haiku `low`); `diversityModel` likewise |
| `notes` | — | Free-text intent appended to every child prompt |

Standalone `/code-reviewer` runs R1–R3 once and presents the result. Fact-check and fix (R4–R5)
run when the user asks for them ("review, fact-check and fix the clear ones") or when the
coordinator's `review` stage runs this procedure. Fixing implies the fact-check: a request to fix
without one ("review and fix") still runs R4 first, as pi does.

---

## Main session procedure — target and context

```bash
WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"
HAS_STAGED=$(git diff --staged --quiet || echo yes)
HAS_UNSTAGED=$(git diff --quiet || echo yes)
BASE_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo main)
COMMITS_AHEAD=$(git log "$BASE_BRANCH"..HEAD --oneline 2>/dev/null)
PR_INFO=$(gh pr view --json number,url 2>/dev/null)
```

Shell variables do not persist between Bash calls: every later script command below starts with the
same `WFS=` assignment.

| Situation | Target |
|---|---|
| Only uncommitted changes, no commits ahead, no PR | `git diff HEAD` (offer `--staged` if large) |
| Only commits ahead of base, nothing uncommitted, no PR | `git diff $BASE_BRANCH...HEAD` |
| PR exists and nothing uncommitted | the PR (`gh pr view <n> --json number,title,body,author,additions,deletions,changedFiles,reviews,comments,statusCheckRollup`, `gh pr diff <n>`; `/github-read` gathers the rest) |
| User gives a range | `git diff A..B` |
| Several sources non-empty | ask which (AskUserQuestion) |

Nothing to review → say so ("No changes found to review; branch is up to date with <base>.") and stop.

Write the target as one line for the children (e.g. `git diff main...HEAD in /abs/repo`, `PR #67 in
/abs/repo`); children run the diff themselves — never paste the diff into a prompt. When fix rounds
may run, pin `baseRef` (`git merge-base HEAD $BASE_BRANCH`, or `HEAD` for uncommitted work) and add
the line "Review range: <baseRef>..HEAD (cumulative, including any fix commits from prior rounds).
This overrides any relative range in Target."

**Spec lookup.** For each component the diff touches, look for its spec (project README / agent
instructions first; default `SPEC.md` at the component root). If found, read it and pass every
reviewer the MUST / MUST NOT statements: "These are hard requirements from the component spec. Each
one is pass/fail, not heuristic. Check compliance explicitly: [list]". A MUST violation is a
blocker by definition; synthesis never downgrades it. If a finding depends on interpreting a MUST
term, synthesis states the reading. When all angles agree on that reading, it is a MUST violation
(blocker). When they disagree, it is `important` with a `decision` note.

Present the context summary before dispatching:

```
Review Target: Feature branch 'add-oauth2' (12 files, +487/-123) — git diff main...HEAD
Purpose: Add OAuth2 authentication for API
Stack: Python 3.11, Flask, SQLAlchemy, PyJWT
Spec: src/auth/SPEC.md (6 MUST, 2 MUST NOT)
PR Status: Open, 1 review (changes requested), 3 CI checks failing
Run: 3 angles, cross-exam on, rounds 1, fixScope none
```

## Main session procedure — review rounds (was `workflows/review-factcheck-fix.js`)

`reviewDir` = the coordinator's stage dir, else `<repo>/plans/<name>/review/` or the repo's
artifact convention (keep it out of git: `.git/info/exclude`). For `round = 0 .. maxRounds-1`,
`dir = <reviewDir>/round-<round>`. From round 1 on, add to every angle prompt: "Prior round's fixed
findings: <reviewDir>/round-<round-1>/synthesis.json - confirm they are resolved; do not re-raise
resolved items."

Inputs check (as pi's workflow, before any dispatch): in a coordinator stage, a missing
`reviewDir`/stage dir, an unknown `fixScope`, `angles` outside 2–4, `maxRounds` below 1, or a model
override that is not `haiku`/`sonnet`/`opus`/`fable` → write a `blocked` brief (R6 envelope, one
`fix` actionable naming the bad input) and stop; standalone, ask the user instead. When `notes` is
set, append "User notes for this stage: <notes>" to every child prompt (angles, cross-exam,
synthesis, fact-check, fix).

**R1. Angles (parallel).** One `wf-code-reviewer` per angle, all in one message:
```
mode: "angle"
Angle: <angle>
Reviewer <i> of <N> in a competitive review (see Reviewer role).
Target: <target line>
[Repo: <repo>] [Review range line] [Spec MUST/MUST NOT list] [Prior round line]
Write your findings (markdown, every finding with file:line + evidence + severity P0/P1/P2) to <dir>/angle-<i>.md.
[User notes for this stage: <notes>]
```
Last angle gets `model: <diversityModel>` when set. Record each agent id. Wait for a completion
notification from every angle before checking files (a check before that is not a failure).
Notifications always arrive; do not schedule wakeups, crons or sleep loops while waiting (in `-p` a
pending wakeup keeps the process alive until it fires). An
angle whose file is missing or empty failed: retry each failed angle once (fresh, same `model` and `effort` as the failed call, so the `diversityModel` lane stays on its model; output `<dir>/angle-<i>-retry.md`).
Still missing → the round **fails** at `angles` (a missing angle is a missing perspective; never
synthesize the survivors into a PASS). Standalone with no loop: fall back to a single-agent review
and say so.

**R2. Cross-exam (parallel, default on).** If SendMessage is not in your tool list, load it with
ToolSearch (`select:SendMessage`). For every angle, in one message, `SendMessage` to that angle's agent id (it
resumes with its own review context, never another reviewer's):
```
mode: "cross-exam"
Cross-examine the other reviewers' findings: <paths of the other surviving angle files, retry paths where used>.
For each finding: Confirmed / Disputed (with evidence) / Already flagged / (skim only) variants, per the Reviewer role.
Write only your cross-exam section to <dir>/angle-<i>-xexam.md.
```
If an agent cannot be resumed, dispatch a fresh `wf-code-reviewer` with the same text plus "Your own
findings: <dir>/angle-<i>.md" (`<dir>/angle-<i>-retry.md` when that angle was retried). A cross-exam that still fails is dropped (at most one retry); note
the gap for synthesis. Never block the round on it.

**R3. Synthesis (gate).** Fresh `wf-code-reviewer`:
```
mode: "synthesis"
Target: <target line> [Repo] [Review range]
Angle findings files: <explicit comma-separated paths of the surviving angle files, retry paths where used>
[Cross-exam files: <explicit comma-separated paths of the -xexam.md files>] [Missing cross-exam: <which>]
Write JSON to <dir>/synthesis.json, exactly: {"blockers":[{"title","file","line","evidence","fix"}],"important":[...same shape],"refuted":[{"title","reason"}]}. blockers = P0 (must fix before merge); important = P1 only; P2/nits/hygiene go in an optional "nits" array, never in important (the loop stops when blockers and important are both empty); refuted = angle findings you rejected with evidence.
Write the human-facing review (INLINE_COMMENTS, GENERAL_REVIEW, INTERNAL_NOTES) to <dir>/synthesis.md.
```
Run `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; bash "$WFS/scripts/classify-review.sh" <dir>/synthesis.json`. `error` set → the round fails
at `synth` (an off-schema report is not "zero findings"). `blockers == 0 && important == 0` → state
`PASS`, stop (no fact-check needed), except when `fixScope` is `trivial` or `all` and the synthesis
has a non-empty `nits` array: then skip R4 (it checks blocker/important claims only, and zero claims
fail closed) and run R5 as a nits-only pass. After it (no re-review round: nits do not gate), the
state is `PASS` when its `fixed` is empty, else `FIXED_UNREVIEWED` (nit fixes not re-reviewed), with
the fix report recorded in the round.

**R4. Fact-check (gate)** — only when fact-check is part of this run. `wf-fact-checker`:
```
Fact-check the review synthesis at <dir>/synthesis.json (target: <target>[, repo <repo>]). One claim per blocker/important finding: is the defect real at the cited file:line? Write {claims:[{claim, verdict, evidence}]} to <dir>/factcheck.json.
```
`WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; bash "$WFS/scripts/classify-factcheck.sh" <dir>/factcheck.json`; `error` or `total` 0 → `FAIL` at
`factcheck`, stop (fail closed). Without fact-check or fix in this run, stop with state `REPORTED`;
R5 never runs on blocker/important findings that R4 did not check this round.

**R5. Fix (bounded by `fixScope`).** `none` → state `REPORTED` (confirmed findings left for the
user), stop. Otherwise `wf-worker`:
```
Target: <target> [Repo] [Review range]
<scope text>
[Blocker/important pass:] Skip any finding the fact-check at <dir>/factcheck.json marks REFUTED; for DISPUTED/UNVERIFIABLE ones, fix only if you can confirm the defect yourself.
[Nits-only pass (R3):] Nits are not fact-checked: fix a nit only after confirming it yourself; skip it otherwise.
Re-run the repo's relevant tests/lint after fixing and, if you changed anything, commit with an imperative message. Use the attribution trailer from your own system reminder, never one copied from the dispatcher.
End with the FIX-REPORT: line and json block: fixed (titles), escalated ({title, why}: needs the user), skipped ({title, why}: refuted/unconfirmed/out of scope nits).
```
Scope text — `all`: "Fix every blocker, important finding and nit in <dir>/synthesis.json." `clear`: "Fix
a blocker/important finding in <dir>/synthesis.json only if its fix is unambiguous: one obviously
right change, no design choice, no behaviour or contract change beyond the defect. Escalate (do not
fix) any finding that needs a judgement call: competing fixes, API/behaviour change, scope beyond
the finding, or you disagree with it." `trivial`: "Fix only trivial items in <dir>/synthesis.json
(blockers, important and nits alike): typos, stale paths/names, doc or comment drift, one-line
mechanical corrections with no behaviour change. Escalate every other blocker/important finding;
leave other nits alone."
Copy the block verbatim with the Write tool to `<dir>/fix-report.json` (no retyping; correct
nothing, put corrections in result.json); `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; "$WFS/claude/scripts/check-block.sh" fix-report <dir>/fix-report.json` not ok
→ `FAIL` at `fix`, stop. Then (nits-only pass: R3):

| `escalated` | code changed (`fixed` non-empty) | rounds remain | next |
|---|---|---|---|
| any | yes | yes | next round, escalated titles in the prior-round line as "escalated, do not re-raise"; the final state is `NEEDS_DECISION` |
| any | otherwise | | `NEEDS_DECISION`, stop |
| none | | no | `FIXED_UNREVIEWED` (fixes made but not re-reviewed), stop |
| none | | yes | next round |

Escalations carry over: every round's `escalated` titles stay pending until the run ends. When a
later round ends in `FAIL` (at `synth`, `factcheck` or `fix`), `FAIL` is the state and the carried
escalations still go to pendingDecisions; `NEEDS_DECISION` is the state only when the run otherwise
ends without a failure.

**R6. Persist.** `<reviewDir>/result.json` = `{state, stage?, round, rounds: [{round, synthPath,
fcPath?, reviewClass, fcClass?, fix?}], pendingDecisions}` where pendingDecisions = "disputed review
claims - see <fcPath>" if the last fact-check has `disputed > 0`, each escalated finding from every
round (deduplicated by title), and for
`REPORTED` "unfixed (fixScope none): <b> blocker(s), <i> important - see <synthPath>".
`<reviewDir>/brief.json` (`coordinator` envelope `{stage, status: done|needs-decision|failed|blocked,
summary (≤400 chars), actionables: [{what (≤300), kind: decision|fix|info, ref}] (≤12), artifacts:
{primary, details?: [string]}}`, all keys but `details` required, no other keys): `stage: "review"`; status `needs-decision` when
pendingDecisions is non-empty, else `done` for `PASS`/`FIXED_UNREVIEWED`/`NEEDS_DECISION`/`REPORTED`,
`blocked` for infrastructure, otherwise `failed`; summary `review <STATE> after <n> round(s); last
synthesis: <b> blockers, <i> important.`; actionables (max 12): one `decision` per pendingDecisions
entry; a `fix` "<stage>: <reason>" for any state other than `PASS`/`NEEDS_DECISION`/`REPORTED`/
`FIXED_UNREVIEWED`; for `FIXED_UNREVIEWED` the `info` "last round's fixes were not re-reviewed; add a
round to verify them", and the same `info` for `NEEDS_DECISION` with a fix commit not re-reviewed;
`artifacts.primary` = last `synthesis.json`. Check it with
`WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; "$WFS/claude/scripts/check-block.sh" envelope <reviewDir>/brief.json`.

## Main session procedure — report and follow-up

Always present the review in the conversation before anything is posted: the GENERAL_REVIEW body
from the last `synthesis.md`, then the inline findings with file:line, then a one-line count.

```
Review complete: [N] blockers, [N] important, [N] suggestions. (rounds: 1, cross-exam: 3/3, fact-check: off)
[PR exists] → Post to PR #N?  Save to markdown file?
[No PR]     → Save to markdown file?  Create a PR? (/github-pr-create)
```

Wait for the user before any follow-up. INTERNAL_NOTES are never posted.

**Post to a PR** (only on confirmation):
```bash
LATEST_COMMIT=$(gh pr view <n> --json headRefOid -q .headRefOid)
gh api "repos/{owner}/{repo}/pulls/<n>/comments" -f body="<body>" -f path="<file>" -F line=<line> -f side=RIGHT -f commit_id="$LATEST_COMMIT"   # per inline comment
gh pr review <n> --comment --body-file <general-review.md>
```
Confirm: `✓ Posted to PR #<n>: <k> inline comments + 1 general review — <url>`. Posting fails
(`gh auth status`, no PR, no write access) → the review is already inline; offer to save it.

**Save to file:** `code-review-<YYYYmmdd-HHMMSS>.md` with branch/PR, date, "Reviewer: AI-assisted
(Multi-Agent)", the general review, and a `## Files to Address` checklist (file, issue count).

**Re-review after fixes:** run again with the prior synthesis passed as the prior-round line; report
fixed vs. outstanding. **Focused review:** filter the target to the named paths and say so in the
target line. **Custom focus** ("focus on security"): put it in `notes` and pick angles to match.

---

## Reviewer role

### Angle review — competitive prompt

You are Reviewer N in a competitive code review. The best reviewer (most valuable findings) is
promoted, the worst (trivial or irrelevant issues) is demoted. Performance is judged on meaningful,
actionable feedback; quality over quantity.

Review criteria, in priority order (your angle biases where you dig deepest; you still report
anything serious you find):
1. **Spec compliance** (when a spec was given): each MUST satisfied or violated — binary; each MUST
   NOT — any violating path? Violations are blockers.
2. **Security:** injection (SQL, command, XSS), authn/authz bypass, data leaks, crypto misuse, input
   validation gaps.
3. **Correctness:** logic errors, unhandled edge cases, race conditions, off-by-one, null handling.
4. **Performance:** N+1 queries, leaks, inefficient algorithms, resource exhaustion.
5. **Maintainability:** complexity, unclear naming/logic, undocumented complex parts, hard-coded
   values that should be configurable.
6. **Design:** tight coupling, wrong abstractions, missing error handling, inconsistent patterns.
7. **Testing and gates:** missing tests on critical paths, untested edge cases, fragile tests;
   missing gate classes or coverage-matrix rows ("which configuration/selector path is untested
   here?"), ledger gaps (undeclared proxies, missing deferred-gate or decision rows).

Avoid (these lower your score): style nits a linter catches, personal preference, bikeshedding,
"you could also…" without clear benefit, issues already flagged by CI.

Run the diff yourself (`git diff …`, `gh pr diff`) and read surrounding code. Never conclude from a
`tail`/`head`-truncated result. For each issue: severity **P0** (security hole, data loss, crash,
spec violation — must fix before merge) / **P1** (bug, performance problem, design flaw) / **P2**
(maintainability, minor), `file:line`, what is wrong and why it matters, the evidence (a line you
read, a command you ran and its output), and a concrete fix.

```
## Reviewer N Findings (angle: <angle>)

### P0
- **path/file.py:42** — <issue>
  Evidence: <line read / command + output>
  Fix: <concrete change>

### P1
### P2

## Summary
- Total issues: X — Risk: <assessment> — Recommendation: merge / fix / major rework
```

### Cross-exam

You reviewed the same diff; now file exactly one verdict for every distinct peer point you have not
already addressed (an unmarked point is one you absorbed without saying so):
- **Confirmed**: you checked it (reread the lines, traced the call path) and it holds — say what you
  checked, not just "agreed".
- **Disputed**: the concrete argument that beats it (a guard clause it missed, existing behavior
  mistaken for a regression, an unreachable path). "I don't think so" is not a dispute.
- **Already flagged**: point to your finding covering the same spot.
- **Confirmed (skim only)** / **Disputed (skim only)**: for points outside your focus that you could
  only skim — still file a verdict so synthesis can weight it as weaker evidence.

Do not revise your own findings here; if a peer point changes your view of your own finding's
severity, say so in the verdict. Format, no preamble:

```
## Cross-Exam: Reviewer N
- <peer finding (Reviewer M, file:line)> — **Confirmed**: <what you checked>
- <peer finding> — **Disputed**: <the argument>
- <peer finding> — **Already flagged**: <your matching finding>
```

### Synthesis

Read every angle file and cross-exam file in full. Merge policy with cross-exam ledgers:
1. **Spine:** a finding with no Disputed verdict against it keeps its original severity.
2. **Graft:** a single-reviewer finding with no dispute is kept as-is; a missing second opinion is
   not evidence against it.
3. **Decide:** a disputed finding is resolved explicitly — both positions, the winner, the winning
   argument. If the diff cannot settle it, keep it at reduced confidence and say it is contested.
4. **No new findings.** Every output line traces to a reviewer's original list.
5. **Convergence:** say when reviewers independently raised the same point; distinguish same-lane
   checked corroboration (real signal) from skim-only agreement (a bystander nodding).
Without ledgers (`no-x-check`): rank reviewers by finding quality, merge duplicates, drop trivial
issues, keep every meaningful finding. Never soften a P0 because only one angle caught it; never
downgrade a spec MUST violation.

**JSON (`synthesis.json`)** — exactly `{"blockers": [...], "important": [...], "refuted": [...],
"nits"?: [...]}`; blockers/important items `{title, file, line, evidence, fix}`, refuted items
`{title, reason}`. P0 → blockers, P1 → important, P2 → nits. A script classifies this file and
rejects any other shape.

**Markdown (`synthesis.md`)** — terse: no fluff, no "Let me…", issue + reasoning + fix, complete
sentences, no emojis or time estimates. Never write "#N" (GitHub auto-links it to an issue); write
"Point 2", "the second issue".

```
## INLINE_COMMENTS
File: <path>
Line: <n>
Severity: BLOCKER | IMPORTANT | SUGGESTION
Body: |
  **BLOCKER: <title>**
  <why it matters, 1–2 sentences>
  Fix:
  ```<lang>
  <suggestion>
  ```

## GENERAL_REVIEW
## Code Review
**Assessment:** APPROVE | CHANGES_REQUESTED | COMMENT
### Issues by Severity
**BLOCKER** - <file:line> - <summary>
Reasoning: <what breaks>
Fix: <solution>
**IMPORTANT** - …
**SUGGESTION** - …
### Recommendation
<next steps; what is good about the change>
*Co-authored by AI-assisted review*

## INTERNAL_NOTES (never posted)
### Rejected Findings
<false positives / overstated concerns, with reasoning>
### Resolved Disputes
<every Disputed verdict ruled on: finding, both positions, winner and why>
### Gaps
<missing angles or cross-exams>
```

Placement: an issue on 1–10 lines → INLINE_COMMENTS; whole-file → inline at line 1; cross-cutting →
GENERAL_REVIEW only; never both. Reference inline comments from the general review when useful
("See 3 inline comments").

Example (general review):

```markdown
## Code Review
**Assessment:** Changes Requested
### Issues by Severity
**BLOCKER** - test_s3.py:69 - Missing test for URL encoding fix
Core purpose of the PR (fixing double-encoding) lacks verification; keys with spaces or colons could regress.
Fix: Add test_upload_file_url_encoding_special_characters() verifying %20/%3A encoding while preserving slashes.
**IMPORTANT** - test_s3.py:98 - Cleanup fails with >1000 objects
list_objects_v2() returns at most 1000 keys; cleanup silently leaves the rest.
Fix: Use a paginator and batch delete_objects() in 1000-item chunks.
### Recommendation
Fix the blocker before merge. Point 2 is unlikely but should be addressed.
*Co-authored by AI-assisted review*
```

## Tuning

- Too harsh / lenient: adjust the competitive pressure ("balance rigor with pragmatism").
- Too many trivial issues: strengthen the Avoid list in `notes`.
- Missing important issues: add specific vulnerability types or a dedicated angle.
- Too slow: smaller target, `no-x-check` (N+1 calls instead of 2N+1), or 2 angles.
- Reviewer count: cost is N+1 without cross-exam, 2N+1 with it (one call per reviewer, not per
  pair): 2 angles → 3/5 calls, 3 → 4/7, 4 → 5/9.
