---
name: e2e-tester
description: Exercises a spec-driven implementation end-to-end against a running stack, working narrow-to-wide until the integration surface is covered. Produces bugs found, spec gaps closed, and documented test runs, after review and fact-check.
---

# E2E Tester Skill

You are playing the **E2E Tester** role. Your job is to verify that a reviewed implementation actually works as a whole — not just in unit tests — by running it against a live stack. You produce real bugs found in a running system. You are a single focused agent: you scan, provision, test, debug, fix, unify, and report. You do not delegate: no `Agent` calls, no further `wf-*` dispatch.


## Who Runs This

- **Main session:** follows the steps directly; asks the user with `AskUserQuestion` wherever a decision is needed.
- **`wf-worker` child** (coordinator "e2e" stage, see Stage mode): has no way to ask the user. Wherever this skill says "ask the user", "consult the user" or "stop and report", end your reply with a `NEEDS-DECISION:` line followed by a fenced block (decision, options, recommendation) instead, after saving state in the artifacts. Never end with a bare question.

## When to Use

**Use when:**
- An implementation has been reviewed (code-reviewer) and/or fact-checked (fact-checker)
- The gap between "unit tests pass" and "the thing actually works" needs to be closed
- You need to verify the system works as a whole, not just layer by layer

**Do NOT use when:**
- The user wants unit tests written — that is a worker task
- The code has not been reviewed yet — run code-reviewer first
- The environment is production — this skill provisions real infra and creates test data

## Artifacts

You produce five artifacts, written incrementally throughout the session:

| Artifact | When written |
|----------|-------------|
| `TESTING_PLAN.md` | Scan phase; updated as coverage expands |
| `RESOURCES.md` | Updated whenever a resource is created — never delete entries |
| `FINDINGS.md` | Updated after each bug loop iteration |
| `TEST_RUNS.md` | Append-only log of every test executed |
| Final Report | Delivered at session end or on blocker |

Check whether `plans/` is gitignored before writing. Use `docs/plans/` if it is. When run as a stage, the detail file named in the task is the Final Report; the other artifacts go in the plans directory.

## Blocking Protocol

Stop and report immediately — do not stall, loop, or improvise — when:

- A credential or external service is required that you cannot obtain from `.env`, the repo, or the running containers
- An environment or infrastructure decision requires user input
- A fix would affect files outside the current branch scope or another agent's concurrent work
- The same bug has been attempted twice and the second attempt produced a different error
- The test surface is large enough that splitting across worktrees is worth considering (see Step 6)

In the main session, present the report and ask via `AskUserQuestion`. As a `wf-worker` child, write the report to the detail file and end with `NEEDS-DECISION:` plus the fenced decision block.

**Blocker report format:**
```markdown
## Blocker Report

**Status at block:** <what was completed>
**Blocker:** <precise description — what is missing, what decision is needed>
**Options:** <2-3 approaches with trade-offs, if applicable>
**Artifacts written:** <state of TESTING_PLAN.md, RESOURCES.md, FINDINGS.md>
**To resume:** <exact steps to unblock>
```

## Step-by-Step Workflow

### Step 1: Scan

Read everything before touching the environment.

**1a. Read the SPECs**

```bash
find . -name "SPEC*.md" -o -name "SPEC-*.md" | grep -v ".venv\|node_modules\|.wt/" | sort
```

Read each in full. Extract:
- Every `MUST` and invariant observable at the integration layer
- Explicit "Verifiable Conditions" sections — copy every one verbatim into TESTING_PLAN.md; these are your authoritative test targets
- Async/sync boundary concerns — flag early, they are a common bug class in Django+asyncio

**1b. Read the implementation**

For each file changed in the PR, read it in full and trace the execution path from API call to final state mutation:

```bash
grep -r "urlpatterns\|@shared_task\|queue=" --include="*.py" -l | head -20
grep -r "boto3\|S3\|BinaryFileStore" --include="*.py" -l | head -10
```

**1c. Analyze existing test coverage**

Before writing any new tests, understand what already exists:

```bash
find . -path "*/tests/test_*.py" | xargs grep -l "<module>" 2>/dev/null | head -20
grep -n "def test_" <test_file> | head -40
```

For each changed module ask:
- Do existing tests exercise the failure modes of this change?
- Are any existing tests using fakes (InMemoryStore, FakeWritableFileStore) where a real store is needed to catch integration bugs?
- Is there a test that should have caught a bug but didn't — and why?

Existing tests that should have caught a bug but didn't are candidates for strengthening: fix them rather than adding new ones alongside.

**1d. Understand infrastructure**

```bash
cat docker-compose.yml
cat .env 2>/dev/null | grep -v "^#" | grep -v "^$"
docker compose exec <worker> celery -A core inspect active_queues 2>&1 | grep '"name"'
```

Note backend port, queue prefix, and which credentials are present vs missing.

**1e. Write TESTING_PLAN.md**

```markdown
# Testing Plan

## System Under Test
<1-2 sentences>

## Integration Surface
Ordered narrow-to-wide — check off as exercised:
- [ ] <layer 1: e.g., REST API endpoint>
- [ ] <layer 2: e.g., Celery task dispatch>
- [ ] <layer 3: e.g., external file fetch>
- [ ] <layer 4: e.g., executor>
- [ ] <layer 5: e.g., output store>
- [ ] <layer 6: e.g., results API>

## SPEC Verifiable Conditions
(Copied verbatim from all SPEC files)
- [ ] <SPEC file § Section: exact condition text>

## Existing Coverage Gaps
- <file>: <what's missing — e.g., uses FakeStore, doesn't exercise async path>

## First Ambitious Run
<Single most complete scenario: inputs, code path, expected output>

## Narrow-to-Wide Progression
Levels 1-6 as in Step 5, each checked off when run.

## Known Risk Areas
<Async/sync boundaries, credential injection, path conventions, fake store gaps>
```

### Step 2: Provision

Set up everything the running system needs. **Document every resource in RESOURCES.md immediately — before moving on.**

**2a. Verify infrastructure**

```bash
docker compose ps
# If services are down:
docker compose up -d && docker compose ps
```

**`docker compose restart` does NOT pick up `.env` changes.** If you add env vars to `.env`:
```bash
docker compose up -d --force-recreate <service>
# Verify:
docker compose exec <service> env | grep <VAR>
```

**2b. Inject credentials**

```bash
docker compose exec <worker> env | grep -E "AWS|ANTHROPIC|API_KEY"
```

If missing: add to `.env`, force-recreate, verify. Never change bucket or resource policies. Note credential expiry in RESOURCES.md.

**2c. Create test fixtures**

API keys via Django shell:
```bash
docker compose exec <backend> python manage.py shell -c "
import secrets
from <app>.models import <KeyModel>
raw = 'e2e_test_' + secrets.token_hex(8)
key = <KeyModel>(name='e2e-test', <scope_field>=<scopes>)
key.api_key = raw; key.save()
print('KEY:', raw)
"
```

S3 test files — always use a trackable prefix:
```bash
aws s3 cp <local-file> s3://<bucket>/e2e-test-<date>/<filename>
```

**2d. Write RESOURCES.md**

```markdown
# Test Resources
Created during e2e-tester session — clean up all entries when done.

## AWS S3
- `s3://<bucket>/e2e-test-<date>/` — delete entire prefix when done

## API Keys
- Name: `e2e-test`, raw key: `<key>` — delete via Django admin or shell

## .env additions (remove after session)
AWS_ACCESS_KEY_ID=...   # added for e2e session, expires <time>

## Containers force-recreated
- `<service>` — recreated to pick up env vars above
```

### Step 3: First Ambitious Run

Design ONE test that exercises as much of the stack as possible in a single flow. **Do not start small.** Integration bugs only surface when the full path executes.

For a file-pipeline system, the most complete scenario is:
- External file source (S3) → task config → executor → output written → harvested to store → FileDescriptor in output_data → retrievable via results API

Execute:
1. POST to create the pipeline definition with maximum config
2. POST to create and start a run
3. Poll status:

```bash
for i in $(seq 1 <N>); do
  sleep <interval>
  STATUS=$(curl -s "<BASE>/runs/<RUN_ID>/" -H "<AUTH>")
  ST=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])")
  echo "[$(date -u +%H:%M:%S)] $ST"
  if [[ "$ST" == "completed" || "$ST" == "failed" ]]; then break; fi
done
```

4. If `completed`: fetch results, verify shape matches SPEC Verifiable Conditions
5. If `failed`: enter the Bug Loop

**Append to TEST_RUNS.md after every run:**
```markdown
## Run <n> — <date> <time>
**Scenario:** <description>
**Run ID:** <id>
**Input:** <key inputs>
**Result:** completed / failed
**Code path traced:** API → <view> → <task dispatched> → <executor> → <store method>
**SPEC conditions exercised:** <list>
**Output verified:** <what was checked>
```

### Step 4: Bug Loop

When a failure surfaces, apply this loop exactly. Do not skip steps. Do not widen scope until the loop is complete.

**4a. Narrow scope**

Isolate the failing component from logs and DB state before reading source code:

```bash
# Exact error from task execution records
docker compose exec <backend> python manage.py shell -c "
from <app>.models import PipelineRunModel, TaskExecutionModel
run = PipelineRunModel.objects.get(run_id='<RUN_ID>')
for e in TaskExecutionModel.objects.filter(run=run).order_by('attempt'):
    print(f'attempt={e.attempt} status={e.status}')
    if e.error: print(f'  error={e.error}')
"

# Worker logs filtered to this run
docker compose logs <worker> --tail=60 --no-log-prefix 2>&1 \
  | grep -E "<run_id>|error|ERROR|Traceback" | head -40
```

**4b. Analyze existing tests for this component**

Run `grep -rn "def test_" <test_file_for_component>`.

- Is there a test that should have caught this? If so, why didn't it — fake store? wrong abstraction level?
- Strengthen the existing test rather than adding a parallel one alongside it.

**4c. RCA**

Trace root cause. Read the relevant source. Check the SPEC:

```bash
grep -r "<error_string>" --include="*.py" -n | head -20
```

Classify the root cause:
- **Implementation error** — SPEC was clear, code was wrong
- **Spec gap** — SPEC was silent or ambiguous, implementation guessed wrong
- **Spec conflict** — two SPEC clauses contradict each other
- **Spec composition gap** — each clause was individually correct but they compose incorrectly (e.g., `commit()` uses one path convention, `read_file()` uses another; neither clause was wrong alone)

Common bug classes in Django+asyncio — check these first:
- Sync ORM from `async def` → `SynchronousOnlyOperation` (fix: `asyncio.to_thread`)
- Default session storage (`~/.agent_driver`) not writable in Docker (`HOME=/app`)
- File path mismatch: store commits at `tmp_dir`-relative path, validator looks up `write_dir`-relative path
- FakeStore tests pass, real-store integration fails — fake masks path/async/ORM bugs

**4d. Write failing test(s)**

Write tests **before** the fix. They MUST fail on current code.

Rules: every test cites the exact SPEC clause it exercises; use real stores for storage/path/async bugs (fakes mask them); strengthen an existing test if one should have caught this, add new tests only for genuinely new coverage.

Template:
```python
class Test<BugName>(BufferedUnittestCase):
    """SPEC ref: <path/to/SPEC.md> § <Section>:
    '<Exact SPEC clause being tested>'
    """

    def test_<behavior>(self):
        """<SPEC clause> MUST hold when <condition>."""
        # Arrange
        ...
        # Act + Assert
        self.assertEqual(actual, expected, (
            "SPEC violation: <what should have happened>. "
            f"Got: {actual!r}"
        ))
```

For async/sync boundary bugs, `asyncio.run()` in a sync Django test:
```python
def test_store_save_works_from_async_context(self):
    """SPEC INV-HARVEST-1: BinaryFileStore.save() MUST complete before output_data is returned.
    Django ORM is sync-only; direct call from async raises SynchronousOnlyOperation.
    """
    async def run():
        return await executor._build_output_data(output, contracts)

    result = asyncio.run(run())
    self.assertIn("expected_key", result)
```

Confirm tests fail before fixing:
```bash
PARALLEL=1 just tests::run luna <module>.<TestClass> 2>&1 | tail -15
# Must see FAILED
```

**4e. Fix**

Apply the minimal fix. Do not refactor adjacent code.

```bash
just fix   # ruff format + lint fix
```

**4f. Verify**

```bash
PARALLEL=1 just tests::run luna <module>.<TestClass> --keepdb 2>&1 | tail -8
just tests::run <package> --keepdb 2>&1 | grep -E "^(OK|FAIL|Ran )"
```

Both must pass before proceeding.

**4g. Resume**

```bash
docker compose restart <worker>  # bind-mounted code — restart is sufficient
```

Post a **new** run — do not retry the old run ID; failed runs may hit idempotency guards.

- If it passes: update TESTING_PLAN.md, FINDINGS.md, TEST_RUNS.md; advance scope
- If it fails with a new error: re-enter bug loop for the new failure
- If it fails with the same error on the second attempt: **stop and file a blocking report**

### Step 5: Increase Scope

After each successful run, advance to the next level. Do not skip a level while one is failing.

1. Happy path — most complete single scenario
2. Same path, different input types
3. Error paths — missing file, bad credentials, invalid schema
4. Retry/backoff — transient failure that resolves, exhausted budget
5. Multi-stage — output of one task feeds input of next
6. Concurrent runs

For each level: state in TESTING_PLAN.md what you are about to test, run it, append to TEST_RUNS.md with the code path traced, check the layer off on pass.

### Step 6: Worktree Strategy

For large test surfaces — a PR touching multiple independent subsystems, or when a full test cycle takes >30 min — splitting across worktrees is viable. **Do not do this unilaterally. Consult the user first** (main session: `AskUserQuestion`; `wf-worker` child: `NEEDS-DECISION:`). Each worktree is a separate session started by the user or the main session; this skill never spawns agents.

Raise this when:
- TESTING_PLAN.md has more than one major independent subsystem with its own docker stack
- The test surface is large enough that a single sequential pass is impractical

Present this proposal to the user:
```markdown
## Worktree Split Proposal

The test surface has two independent subsystems:
- **Subsystem A** (<what it is>): <infra required>, estimated <N> scenarios
- **Subsystem B** (<what it is>): <different infra>, estimated <M> scenarios

**Coordination risks:** two worktrees fixing the same bug produce conflicting fixes; a shared SPEC change must propagate before the other worktree fixes against it.

**To proceed I need:** your decision to split, the worktree directory convention (follow the repo's; prefer `.wt/<name>/`), and which shared SPECs are read-only until the unification pass.
```

If the user approves, document the coordination boundary in RESOURCES.md and both worktrees' TESTING_PLAN.md.

### Step 7: Unification and Verification

Once all planned test surface is covered, or after substantive fixes have been made, run this pass before closing. It is not optional.

**7a. Cross-check fix coherence**

```bash
git diff origin/<base-branch> --stat
git log --oneline origin/<base-branch>..HEAD
```

For each fix: does it follow the same pattern as similar fixes in the codebase? If two bugs had the same root cause, were they fixed the same way?

**7b. SPEC amendment gate**

For every spec gap or conflict found during this session, verify the spec was amended. A gap recorded in FINDINGS.md but not yet closed in the SPEC is not done.

```bash
grep -n "gap\|limitation\|silent\|unspecified" packages/*/SPEC.md apps/*/SPEC*.md 2>/dev/null
```

**7c. Documentation check**

Update docs that mention the changed class or function (`grep -rl` over `*.md`, excluding `.venv`, `node_modules`).

**7d. Quality checks**

```bash
just fix                    # ruff check --fix + format
just quality::typecheck     # basedpyright with baseline
git add -u
just tests::run <package> --keepdb 2>&1 | grep -E "^(OK|FAIL|Ran )"
```

All must exit 0.

### Step 8: Final Report

Deliver at session end, or on a blocking stop.

```markdown
# E2E Testing Session Report

**Date:** <date>
**System under test:** <name and branch>
**Outcome:** Complete / Blocked (<reason>) / Partial (<what remains>)

## Coverage Achieved
| Layer | Status | Test / Run ID |
|-------|--------|---------------|
| <layer> | ✅ Covered / ⚠️ Partial / ❌ Not reached | Run <id> — <scenario or blocker> |

**SPEC Verifiable Conditions:** one row per condition: ✅ Exercised in Run <id> / ❌ Not reached

## Bugs Found and Fixed

### Bug 1: <title>
**Classification:** Implementation error / Spec gap / Spec conflict / Spec composition gap
**SPEC ref:** <file § section>
**Root cause:** <precise statement>
**Fix:** <file, method, what changed>
**Tests added:** `<TestClass.test_method>` in `<path>`
**Status:** Fixed ✅ / Deferred ⏳

## Spec Gaps and Conflicts
Per gap: what the SPEC said, what was missing, amendment applied (commit ref).

## Existing Tests Strengthened
- `<test file>`: `<test name>` — e.g. was using FakeStore; now uses a real store

## Blockers / Open Items
<None — session complete. | Or: description of what remains>

## Resources to Clean Up
See RESOURCES.md for full inventory.
```

## Operational Notes

- **Worktree coordination:** with two worktrees running concurrently, treat shared SPECs as read-only and reconcile amendments in the unification pass. Never amend the same SPEC clause from two worktrees.
- **TEST_RUNS.md is append-only:** never edit or delete an entry.
- **Binding rules defined above:** `--force-recreate` over `restart` for env changes (2a); real stores over fakes for storage/path/async bugs (4c, 4d); no level skipped while one fails (5); spec gaps closed by committed amendment, not just logged (7b); fix a broken existing test rather than adding one beside it (4b).

## Quality Checks Before Reporting

Before the final report or a blocker escalation, confirm:

- Every bug has a SPEC reference, classification, fix and committed test; every spec gap has a committed amendment (or an explicit decision to defer)
- TESTING_PLAN.md reflects coverage achieved, not planned; TEST_RUNS.md has every run with code path traced; RESOURCES.md has every created resource (S3 prefix, API keys, `.env` additions)
- `just fix` and `just quality::typecheck` exit 0; the full suite for every touched package passes with `--keepdb`

## Stage mode (coordinator)

The coordinator runs e2e as a single-agent stage. Single depth: only the main session dispatches. Dispatch only `wf-*` agents; never fork (`subagent_type: "fork"`) or use `general-purpose`: both carry `Agent` and break single depth.

1. Main session calls `Agent` with `subagent_type: "wf-worker"`. `wf-worker` does not preload this skill, so the task gives the absolute path of this file (`"${CLAUDE_SKILL_DIR}/SKILL.md"` resolved by the main session) to read first, plus the system under test, SPEC paths, review/fact-check reports, the plans directory, and the detail-file path (default `<stageDir>/e2e-report.md`, as the coordinator's e2e row). Pass paths, not content. Working directory is the repo (or lane worktree) named in the task.
2. The child follows Steps 1-8, writes the Final Report to the detail file, and ends its reply with a line `ENVELOPE:` followed by one fenced ```json block, the last content of the reply:

```json
{"stage": "e2e", "status": "done", "summary": "<=400 chars", "actionables": [{"what": "<=300 chars", "kind": "fix", "ref": "FINDINGS.md Bug 2"}], "artifacts": {"primary": "<detail file>", "details": ["TESTING_PLAN.md", "RESOURCES.md", "FINDINGS.md", "TEST_RUNS.md"]}}
```

   - `status`: `done` | `needs-decision` | `failed` | `blocked`. A Blocker Report maps to `needs-decision` (with `decision` actionables) or `blocked` (nothing the user can unblock in-flow). At most 12 actionables; `kind` is `decision`, `fix` or `info`; summary at most 400 chars.
3. The main session copies the block verbatim to `<stageDir>/brief.json` with Write, checks it with `bash "$WFS/claude/scripts/check-block.sh" envelope <stageDir>/brief.json` (with `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"`; it prints `{ok, errors}` and rejects unknown keys, a bad status, a summary over 400 chars or more than 12 actionables) and checks the detail file exists (`test -s`). It then sets `artifacts.primary` to the detail file in `brief.json` whatever the child reported (coordinator rule 5; re-run `check-block.sh envelope`).
4. On a missing/invalid block, failed check or missing detail file, retry once with the same agent (`wf-worker`). If the retry also fails, the main session writes a `blocked` envelope to `<stageDir>/brief.json` itself, with the reason in `summary` and a `fix` actionable.
5. If the child ended with `NEEDS-DECISION:`, the main session asks the user, then resumes the child with `SendMessage` (if SendMessage is not in your tool list, load it with ToolSearch (`select:SendMessage`)) or re-dispatches with the answer and the artifact paths.
