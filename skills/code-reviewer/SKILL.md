---
name: code-reviewer
description: Performs competitive multi-agent code review on uncommitted changes, branches, or GitHub PRs. Synthesizes findings from three independent reviewers into actionable inline feedback; optionally posts to GitHub or saves to a file. Use when changes are complete and ready for critique.
---

# Code Reviewer Skill

## Purpose

Performs comprehensive, high-quality code reviews using a competitive multi-agent approach. Three independent reviewers analyze changes in parallel, competing to find the most meaningful issues, then a synthesis agent consolidates findings into actionable feedback with context.

## When to Use

Activate this skill when you hear:
- "review this code" / "code review" / "review the PR"
- "review my changes" / "review this branch"
- "do a code review" / "check this code"
- "review before merge" / "thorough review"
- "what issues do you see" / "competitive review"
- "review these changes" / "can you review"

**Use when:**
- Staged or unstaged changes are ready for critique
- Development is complete and ready for review
- Before committing, before creating a PR, or before merging
- After addressing feedback (re-review)
- Want thorough, multi-perspective analysis

**Do NOT use when:**
- Mid-edit: changes are intentionally half-written
- Just checking syntax or linting
- User only wants explanation, not critique

## Prerequisites

**Required:**
- `gh` CLI (for PR reviews)
- Git repository context

**Optional:**
- Existing GitHub PR for PR-based reviews

## Multi-Agent Review Architecture

**Competitive Review Process:**

1. **Three Independent Reviewers** (parallel execution)
   - Each reviewer analyzes changes independently
   - Competitive prompt: Best performer gets promoted, worst gets demoted
   - Must find MEANINGFUL issues (nitpicking lowers performance)
   - Focus on: security, bugs, performance, maintainability, design

2. **Synthesis Agent** (final consolidation)
   - Reads all three reviews
   - Consolidates findings
   - Removes duplicates and trivial issues
   - Prioritizes by severity and impact
   - Provides brief context for each issue
   - Generates actionable recommendations

3. **User Decision**
   - Review key findings
   - Judge what's worth addressing
   - Choose output format (GitHub comments or local file)

## Workflow

### Step 1: Identify Review Target

**Detect available review sources:**

```bash
# Uncommitted changes
HAS_STAGED=$(git diff --staged --quiet || echo yes)
HAS_UNSTAGED=$(git diff --quiet || echo yes)

# Committed but not on base
BASE_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")
COMMITS_AHEAD=$(git log $BASE_BRANCH..HEAD --oneline 2>/dev/null)

# PR for current branch
PR_INFO=$(gh pr view --json number,url 2>/dev/null)
```

**Select target — ask only when ambiguous:**

| Situation | Action |
|-----------|--------|
| Only uncommitted changes exist, no commits ahead, no PR | Review uncommitted changes — no question needed |
| Only commits ahead of base, nothing uncommitted, no PR | Review branch diff — no question needed |
| PR exists and nothing uncommitted | Review PR context — no question needed |
| Multiple sources are non-empty | Ask which to review |

**Review modes:**
- **Uncommitted:** `git diff HEAD` (all uncommitted); offer to narrow to `--staged` or `--diff-filter` if large
- **Branch:** Compare against base (`git diff $BASE_BRANCH...HEAD`)
- **PR:** Use GitHub context (CI status, existing comments, PR description)
- **Commit range:** `git diff A..B` when user specifies

### Spec lookup (run after identifying changed files)

For each component touched by the diff, look for a spec file. Check the project's README
and agent instruction files for any stated convention on spec naming or location first.
The default is `SPEC.md` at the component root, but repos may vary.

If a spec is found:
- Read it fully before dispatching reviewers
- Extract MUST and MUST NOT requirements
- Pass them to every reviewer: "These are hard requirements from the component spec.
  Each one is pass/fail — not heuristic. Check compliance explicitly:
  [list MUST / MUST NOT statements]"
- A MUST violation is **BLOCKER** severity by definition, regardless of how minor
  it appears in isolation. The spec exists because this invariant was agreed to be
  non-negotiable — do not downgrade it in synthesis.

If no spec is found: proceed with standard heuristic review.

### Step 2: Gather Context

**For uncommitted changes:**
```bash
# All uncommitted (staged + unstaged)
git diff HEAD

# Staged only
git diff --staged

# Get stats
git diff HEAD --stat
git diff HEAD --shortstat
```

**For branch review:**
```bash
# Get base branch
BASE_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")

# Get diff
git diff $BASE_BRANCH...HEAD

# Get commit messages
git log $BASE_BRANCH..HEAD --format="%h %s"

# Get stats
git diff $BASE_BRANCH...HEAD --stat
git diff $BASE_BRANCH...HEAD --shortstat
```

**For PR review:**
```bash
# Use github-read skill to gather comprehensive PR context
# This gets: PR description, comments, reviews, CI status, failures

gh pr view <number> --json \
  number,title,body,author,\
  additions,deletions,changedFiles,\
  reviews,comments,statusCheckRollup

# Get PR diff
gh pr diff <number>
```

**Context to collect:**
- **Changes:** Files modified, lines added/deleted
- **Purpose:** What the code is trying to achieve (from commits/PR)
- **Technology stack:** Languages, frameworks, libraries used
- **Existing feedback:** Reviewer comments, CI failures (if PR)
- **Repository patterns:** Existing code style, architecture

**Present context summary:**
```
Review Target: Uncommitted changes (3 files, +87/-12)
Purpose: Inferred from diff / commit messages
Stack: Python 3.11, Flask, SQLAlchemy
Changes:
  - Modified: src/auth/oauth.py, src/api/routes.py
  - New: tests/test_auth.py
No remote branch or PR — results will be reported inline.
```

or for branch/PR:

```
Review Target: Feature branch 'add-oauth2' (12 files, +487/-123)
Purpose: Add OAuth2 authentication for API
Stack: Python 3.11, Flask, SQLAlchemy, PyJWT
Changes:
  - New: src/auth/oauth.py, src/auth/tokens.py
  - Modified: src/api/routes.py, src/models/user.py
  - Tests: tests/test_auth.py
PR Status: Open, 1 review (changes requested), 3 CI checks failing
```

### Step 3: Deploy Three Competitive Reviewers

**Spawn three parallel review agents using Task tool:**

Use the `Task` tool with `subagent_type: "general-purpose"` to create three independent reviewers.

**Competitive prompt template for each reviewer:**

```
You are Reviewer [1/2/3] in a competitive code review process.

PERFORMANCE EVALUATION:
- The BEST reviewer (most valuable findings) will be PROMOTED
- The WORST reviewer (trivial/irrelevant issues) will be DEMOTED
- Your performance is judged on MEANINGFUL, ACTIONABLE feedback

REVIEW CRITERIA - Focus on HIGH-VALUE issues:
1. Security vulnerabilities (injection, auth bypass, data leaks)
2. Bugs and logic errors (crashes, incorrect behavior, edge cases)
3. Performance problems (N+1 queries, memory leaks, inefficiencies)
4. Maintainability issues (unclear code, poor naming, complexity)
5. Design flaws (tight coupling, violations of principles)
6. Testing gaps (missing tests, inadequate coverage)

AVOID (these LOWER your score):
- Trivial style nitpicks (unless style causes bugs)
- Personal preference opinions
- Issues already flagged by linters/CI
- Suggestions without clear benefit
- Overly pedantic comments

CODE TO REVIEW:
[Full diff with context]

ADDITIONAL CONTEXT:
[Purpose, PR description, commit messages, existing feedback]

YOUR TASK:
Perform a thorough review focusing on meaningful issues that truly improve code quality, security, or reliability. Prioritize findings by severity:
- CRITICAL: Security vulnerabilities, data loss, crashes
- HIGH: Bugs, performance issues, design flaws
- MEDIUM: Maintainability, testing, unclear logic
- LOW: Minor improvements, suggestions

For EACH issue found, provide:
1. Severity level (CRITICAL/HIGH/MEDIUM/LOW)
2. File and line number (e.g., src/auth.py:42)
3. Issue description (what's wrong and why it matters)
4. Concrete suggestion (how to fix it)
5. Context (brief surrounding code/behavior)

Output format:
## Reviewer [N] Findings

### CRITICAL
- **File:Line** - Issue description
  Context: [brief context]
  Suggestion: [concrete fix]

### HIGH
[same format]

### MEDIUM
[same format]

### LOW
[same format]

## Summary
- Total issues: X
- Risk level: [assessment]
- Recommendation: [merge/fix/major-rework]

Remember: Quality > Quantity. Find issues that truly matter.
```

**Execute three reviews in parallel:**

Send a SINGLE message with THREE Task tool calls:
- Reviewer 1: Focus on security and correctness
- Reviewer 2: Focus on performance and design
- Reviewer 3: Focus on maintainability and testing

**Wait for all three reviews to complete.**

### Step 4: Synthesize Final Review

**Deploy synthesis agent using Task tool:**

```
You are the SYNTHESIS REVIEWER consolidating three independent code reviews.

CONTEXT:
[Full diff, purpose, PR description]

REVIEWER 1 FINDINGS:
[Complete review 1]

REVIEWER 2 FINDINGS:
[Complete review 2]

REVIEWER 3 FINDINGS:
[Complete review 3]

YOUR TASK:
Consolidate findings into terse, actionable format following CLAUDE.md style:
- No fluff, maximum information density
- Direct statements (no "Let me...", "I'll help...", meta-commentary)
- State issue + reasoning + fix
- No emojis, no time estimates, no pleasantries
- Complete grammatically correct sentences
- CRITICAL: Never use "#N" notation (e.g., "#2", "Issue #3") in GitHub reviews - it auto-links to PR/issue. Use "Point 2", "Item 2", "the second issue" instead.

EVALUATION (internal only, not shown to user):
1. Rank reviewers by finding quality (for your judgment)
2. Identify duplicates and trivial issues
3. Keep all meaningful findings

OUTPUT STRUCTURE:

Generate TWO outputs:

---
## INLINE_COMMENTS
[Array of inline comments for specific code locations]

File: [path]
Line: [number]
Severity: [BLOCKER/IMPORTANT/SUGGESTION]
Body: |
**[SEVERITY]: [Issue title]**

[Why this matters - 1-2 sentences max]

Fix:
```[language]
[code suggestion]
```

[Optional: Brief additional context if needed]

---
## GENERAL_REVIEW
[Main review body in markdown]

## Code Review

**Assessment:** [APPROVE/CHANGES_REQUESTED/COMMENT]

### Issues by Severity

**BLOCKER** - [File:Line] - [Issue summary]
Reasoning: [Why this matters, what breaks]
Fix: [Concrete solution]

**IMPORTANT** - [File:Line] - [Issue summary]
Reasoning: [Impact if unfixed]
Fix: [Concrete solution]

**SUGGESTION** - [File:Line] - [Issue summary]
Fix: [Concrete solution]

### Recommendation

[Direct next steps - what to fix, what's good about the PR]

*Co-authored by Claude Code*

---
## INTERNAL_NOTES (not posted to GitHub)

### Rejected Findings
[List false positives/overstated concerns with brief reasoning - for your synthesis judgment only, DO NOT include in GitHub review]

---

STRUCTURE GUIDANCE:
- Line-specific issues (1-10 lines affected) → INLINE_COMMENTS block
- File-level issues (spans entire file) → Inline at line 1
- General/architectural (multiple files) → GENERAL_REVIEW only
- Rejected findings → INTERNAL_NOTES only, never surface to user
- Don't duplicate between inline and general
- Reference inline comments in general review if needed ("See N inline comments")
- CRITICAL: Never use "#N" notation (e.g., "#2") — it auto-links to GitHub issues. Use "Point 2", "Item 2", or "the second issue" instead.

Provide both INLINE_COMMENTS array and GENERAL_REVIEW body.
```

**Wait for synthesis to complete.**

### Step 5: Report Findings Inline

**Always present the full consolidated review in the conversation.** Never silently post to GitHub without showing results first.

**Parse synthesis output:**
1. Extract INLINE_COMMENTS array (file, line, severity, body)
2. Extract GENERAL_REVIEW markdown
3. Count issues by severity

**Present the full review inline:**

Output the GENERAL_REVIEW body directly in the conversation, followed by any inline-comment findings formatted with their file/line context.

**After presenting, offer follow-up actions based on detected context:**

```
Review complete: [N] blockers, [N] important, [N] suggestions.

[If PR exists]    → Post to PR #N?
                  → Save to markdown file?
[If no PR]        → Save to markdown file?
                    Create a PR? (triggers github-pr-create)
```

Wait for user input before taking any further action.

### Step 6: Optional Follow-up Outputs

**Post to GitHub PR (if user confirms and PR exists):**

```bash
# 1. Post inline comments
for comment in INLINE_COMMENTS:
  gh api "repos/{owner}/{repo}/pulls/<number>/comments" \
    -f body="$comment.body" \
    -f path="$comment.file_path" \
    -f line=$comment.line \
    -f side="RIGHT" \
    -f commit_id="$LATEST_COMMIT"

# 2. Post general review
gh pr review <number> --comment --body "$GENERAL_REVIEW"
```

Confirm after posting:
```
✓ Posted to PR #[number]: [N] inline comments + 1 general review
View: [PR URL]
```

**Save to markdown file (if user requests):**

```bash
cat > code-review-$(date +%Y%m%d-%H%M%S).md <<'EOF'
# Code Review - [Branch/PR/Uncommitted]
Date: [timestamp]
Reviewer: Claude Code (Multi-Agent)

[Full consolidated review]

## Files to Address
- [ ] src/auth/oauth.py (3 issues)
- [ ] src/auth/tokens.py (2 issues)

*Co-authored by Claude Code*
EOF
```

**Inline comment placement guidance:**
- Issue targets specific line or small block (1-10 lines) → INLINE_COMMENTS
- Issue spans entire file → inline at line 1
- Cross-cutting / architectural → GENERAL_REVIEW only
- Never duplicate same issue in both sections

## Review Quality Standards

**Reviewers must focus on:**

1. **Spec compliance** (highest priority, when a spec exists)
   - Each MUST requirement: satisfied or violated? (binary, not judgment)
   - Each MUST NOT requirement: any code path that violates it?
   - Violations are BLOCKER severity — do not negotiate this in synthesis

2. **Security**
   - Injection vulnerabilities (SQL, command, XSS)
   - Authentication/authorization bypass
   - Data leaks and privacy issues
   - Cryptographic misuse
   - Input validation gaps

2. **Correctness**
   - Logic errors and bugs
   - Edge cases not handled
   - Race conditions
   - Off-by-one errors
   - Null/undefined handling

3. **Performance**
   - N+1 query problems
   - Memory leaks
   - Inefficient algorithms
   - Unnecessary computations
   - Resource exhaustion risks

4. **Maintainability**
   - Code complexity (cyclomatic, cognitive)
   - Unclear naming or logic
   - Missing documentation for complex parts
   - Violation of DRY principle
   - Hard-coded values that should be configurable

5. **Design**
   - Tight coupling
   - SOLID principle violations
   - Inappropriate abstractions
   - Missing error handling
   - Inconsistent patterns

6. **Testing**
   - Missing test coverage for critical paths
   - Edge cases not tested
   - Integration test gaps
   - Fragile or flaky tests

**Avoid (low-value feedback):**
- Style issues caught by linters
- Personal preference debates
- Bikeshedding (arguing over trivial choices)
- "You could also..." without clear benefit
- Purely subjective opinions

## Error Handling

**No changes to review:**
```
No changes found to review.

Current branch is up to date with [base].
Make changes first, then request review.
```

**PR not found:**
```
No PR found for current branch.

Options:
1. Review branch changes: "review this branch"
2. Review specific PR: "review PR 123"
3. Create PR first: "create PR" (triggers github-pr-create)
```

**Review agents fail:**
```
Error: One or more review agents failed.

Falling back to single-agent review...
[Perform simplified review without competition]
```

**Cannot post to GitHub:**
```
Error: Cannot post comments to GitHub.

Possible causes:
- Not authenticated: gh auth status
- No PR exists for branch
- No write access to repository

Review was already reported inline. Save to local file instead?
```

## Best Practices

**Review Scope:**
1. Focus on changes in the diff, not entire codebase
2. Understand the PURPOSE before critiquing implementation
3. Consider the context (quick fix vs. architectural change)
4. Check if existing patterns are being followed
5. Verify tests cover the changes

**Communication:**
1. Be specific (file, line, concrete issue)
2. Explain WHY something is a problem
3. Suggest HOW to fix it
4. Indicate severity (critical vs. nice-to-have)
5. Provide context so user can judge

**Competitive Agent Prompting:**
1. Emphasize MEANINGFUL over NUMEROUS issues
2. Penalize trivial nitpicking explicitly
3. Reward high-value discoveries
4. Create accountability (ranking published)
5. Frame as professional performance review

**Synthesis Quality:**
1. Remove duplicate findings across reviewers
2. Upgrade severity if multiple reviewers flag same issue
3. Downgrade or remove purely subjective comments
4. Add business/technical impact context
5. Prioritize actionable over theoretical

## Advanced Features

**Focused review:**
```
User: "Review just the authentication code"
Filter diff to specific files/directories
```

**Re-review after fixes:**
```
User: "Re-review after addressing feedback"
Compare against previous review
Show what was fixed vs. outstanding
```

**Custom review focus:**
```
User: "Focus on security in this review"
Emphasize security in competitive prompts
Weight security issues higher
```

**Export review for team:**
```
# Generate shareable report
Include: findings, code snippets, fix suggestions
Format: Markdown, JSON, or GitHub-flavored
```

**Integration with PR workflow:**
```
1. User: "review PR 123"
2. Skill performs multi-agent review
3. User addresses blockers
4. User: "re-review PR 123"
5. Skill verifies fixes
6. User: "approve and merge"
```

## Integration with Other Skills

**Works with github-read:**
```
1. github-read: Gather PR context (comments, CI, reviews)
2. code-reviewer: Perform technical review of code
3. Consolidated context: existing feedback + new review
```

**Works with github-pr-create:**
```
1. code-reviewer: Review branch before submitting
2. Fix issues found
3. github-pr-create: Create PR with clean code
```

**Workflow example:**
```
User: "Review this before I create a PR"
→ code-reviewer: Finds 5 issues
→ User fixes 5 issues
User: "Create PR"
→ github-pr-create: Creates professional PR
```

## Output Format Examples

**GitHub General Review (terse format):**
```markdown
## Code Review

**Assessment:** Changes Requested

### Issues by Severity

**BLOCKER** - test_s3.py:69 - Missing test for URL encoding fix
Core purpose of PR (fixing double-encoding) lacks verification. Special characters (spaces, colons) in keys could regress.
Fix: Add test_upload_file_url_encoding_special_characters() verifying %20/%3A encoding while preserving slashes.

**IMPORTANT** - test_s3.py:98 - Cleanup fails with >1000 objects
list_objects_v2() returns max 1000. If tests create more, cleanup silently fails.
Fix: Use paginator and batch delete_objects() in 1000-item chunks.

**SUGGESTION** - test_helpers.py:81,95 - Use self.assertEqual() not assert
Violates CLAUDE.md style guide. Not blocking this PR.

### Recommendation

Fix blocker before merge. Point 2 unlikely but should be addressed. PR fixes critical bug, test expansion is excellent.

*Co-authored by Claude Code*
```

**GitHub Inline Comment (terse format):**
```markdown
**BLOCKER: Missing test for core bug fix**

PR fixes URL encoding (now uses `quote(key, safe='/')` instead of quoting entire URL) but lacks test with special characters.

Fix:
```python
def test_upload_file_url_encoding_special_characters(self):
    """Verify upload_file returns correctly encoded URLs."""
    client = BucketHelper(bucket_name=BUCKET_NAME)
    test_key = "path/file with spaces:timestamp.txt"

    url = client.upload_file(
        content=b"test",
        name=test_key,
        content_type="text/plain",
        check_existing=False
    )

    # Verify encoding: spaces→%20, colons→%3A, slashes preserved
    self.assertIn("%20", url)
    self.assertIn("%3A", url)
    self.assertNotIn("%2F", url)

    # Verify roundtrip
    parsed = parse_s3_url(url)
    self.assertEqual(parsed["Key"], test_key)
```

Ensures bug doesn't regress.
```

**Local Markdown File Format:**
```markdown
# Code Review Report
**Branch:** feature/add-oauth2
**Date:** 2025-11-19 14:30:00
**Reviewer:** Claude Code (Multi-Agent)
**Files Changed:** 12 (+487/-123)

## Code Review

**Assessment:** Changes Requested

[Same content as general review above]

## Files to Address
- [ ] src/auth/oauth.py (3 issues)
- [ ] src/auth/tokens.py (2 issues)
- [ ] tests/test_auth.py (1 issue)

*Co-authored by Claude Code*
```

## Troubleshooting

**Q: Reviews are too harsh/lenient**
Adjust competitive pressure in prompts:
- Harsher: Emphasize promotion/demotion more
- Lenient: Add "balance rigor with pragmatism"

**Q: Too many trivial issues**
Strengthen "AVOID" section in reviewer prompts:
- Explicitly penalize style nitpicks
- Reward only high-impact findings

**Q: Missing important issues**
Expand review criteria in prompts:
- Add specific vulnerability types
- Include examples of issues to catch

**Q: Reviews take too long**
- Use `model: "haiku"` for reviewers (faster)
- Limit diff size (review in chunks)
- Use sonnet for synthesis only

**Q: Want different number of reviewers**
Modify workflow to use 2 or 4 reviewers:
- 2: Faster, less comprehensive
- 4: More thorough, slower

---

*This skill uses competitive multi-agent review to deliver high-quality, actionable code feedback.*
