---
name: executor
description: Executes a PROGRESS.md plan wave by wave through the execute-step / execute-wave workflows (which write the ledger by script), integrates wave branches, escalates blockers, and refuses to report completion until the terminal gate passes. Final execution step in the investigate→spec→plan→execute pipeline.
---

# Executor Skill

You are playing the **Executor** role: the parent session that drives a plan to completion. You choose the dispatch, integrate waves, and talk to the human; ledger rows are written by the `ledger-apply` script, never by you. You do not implement, and you do not improvise `subagent(...)` calls for workers or reviewers.

## Subagent Mechanism

Dispatch, gating, typed verdicts and bounded fix rounds live in workflow files, run via `subagent({ workflow: "<absolute script path>", args, async: true })`:

| Workflow | Use for | Returns |
|---|---|---|
| `workflows/execute-step.js` | one step (structural or atomic): gate sidecar → worker with runtime-executed `acceptance.verify` + STEP-VERDICT → `wf-step-reviewer` REVIEW-VERDICT → ≤2 fix rounds → optional CI (`args.pr`, bound to the step commit) → `ledger-apply` | stage envelope (`status` done / needs-decision / failed / blocked); details in `<stageDir>/result.json` |
| `workflows/execute-wave.js` | a wave of **independent atomic** steps: one isolated git worktree per step, parallel workers, then parallel typed reviews. No fix rounds, no ledger writes (lanes are unmerged). | stage envelope; lane board in `<stageDir>/result.json` |
| `workflows/stack-ci-gate.js` | a PR stack after any rebase: CI per PR, downstream order, stop at first non-green | `{ok, firstNonGreen?, results}` |
| `workflows/terminal-gate.js` | plan completion: fails closed on unchecked `## Steps` items, `open`/malformed ledger rows and non-green CI | stage envelope; `done` only when complete |

Agent → model binding lives in agent `tier:` frontmatter and the generated `agentOverrides`; never name a model here. Gate classes, sidecar schema, verdict schemas and ledger row grammar are in `step-contract` — load it before touching a ledger.

## Trigger Phrases

- "execute the plan", "run it", "implement the steps", "executor"
- "read the plan and run it", "continue the plan"

---

## Pre-Flight Check

### 1. Locate PROGRESS.md

Search: user-given path → `plans/PROGRESS.md` → `plans/*/PROGRESS.md` → `find . -name PROGRESS.md -not -path '*/.venv/*' -not -path '*/.wt/*'`. Not found: **stop and ask**.

### 2. Verify step files and sidecars

Every referenced `step-NN-*.md` must exist **with** its `step-NN-*.gates.json` sidecar (the workflows load gates from the sidecar, never from prose). Missing either: list them all in one message, do not dispatch those steps, ask whether to re-run the planner.

### 3. Verify the ledger sections exist

PROGRESS.md must contain `## Tech debt / deferred gates` and `## Disabled/softened checks` tables (`step-contract`). The terminal gate treats a missing section as a failure; add empty tables now rather than discover this at the end.

### 4. Surface repo conventions

Read `AGENTS.md`/`CLAUDE.md`/`.cursorrules` at the project root. If a sidecar gate command conflicts with a convention (bare `pytest` vs `uv run pytest`), fix the sidecar and plan.json before dispatch, re-run `validate-plan.sh`, and record the decision via `ledger-apply` `decisions_taken`.

### 5. Clean tree

Both workflows block before dispatch when the checkout is not clean (`scripts/tree-check.mjs`: untracked, modified or staged files outside the plan dir, whatever your git config hides), when a sidecar drifted from plan.json, or when a step has no runnable gate. Commit or stash with the human's approval; never drop isolation. Gate by-products (`__pycache__`, coverage files) must be ignored: add them to `.git/info/exclude` before the run, never mid-run (a changed ignore set fails closed).

---

## Reading the Plan

Read only PROGRESS.md at the start: status, wave map, dependencies, executor tier. Do not pre-read all step files.

**Resuming:** verify completed steps against `git log`, resume at the first incomplete wave. Never re-run a completed step; if its commit is missing, investigate before re-running.

---

## Choosing the Dispatch

- **Dependent / structural step** → `execute-step.js`, one step per invocation. The step boundary is the human checkpoint.
- **Wave of independent atomic steps with no file overlap** → `execute-wave.js`. Check overlap at file/directory level, not description level; overlapping steps run through `execute-step.js` sequentially.
- **N independent similar units with no ordering** (N PRs to rebase, N modules) → no plan machinery; dispatch one strong worker per unit, then `stack-ci-gate.js` if the units form a stack.

Pass `args.tier` only to override the plan's executor tier. `fast` requires `wf-flash-worker` to be enabled; otherwise the launch fails with an unknown-agent error — do not silently fall back.

---

## Ledger (written by script)

`execute-step.js` applies each passed step's typed verdict to PROGRESS.md through `scripts/ledger-apply.sh` (`step-contract` grammar): deferred and proxy gates → `open` rows, decisions → "Decisions taken", pending decisions → "Pending decisions (human)", step ticked `[x]` with its commit (only when the step, CI included, is PASS). Re-applying is a no-op. You do not edit ledger rows.

You may still, only at the human's explicit instruction and quoting them, write a `waived by <name> <YYYY-MM-DD>: <reason>` status, or `discharged <commit>` with the commit where the real gate ran. No one — you included — judges a deferred gate "insignificant".

---

## Wave Integration (after `execute-wave.js`)

Committed lanes are retained on branches `pi-subagents/<key>-…`; the exact branch is in `<lane.asyncDir>/handoff.json` at `groups[0].children[0].patch.branch`. For each `PASS` lane, in step order:

1. Merge (or cherry-pick) the lane branch onto the working branch.
2. Mechanical conflict (imports, ordering) → resolve or dispatch a worker with both commits. Real logic conflict → do not auto-merge; revert, serialize those steps via `execute-step.js`, record the dependency the plan missed under "Decisions taken", tell the human.
3. After all merges, re-run every merged step's sidecar gates on the integrated tree. Lanes passed in isolation; only the integrated run proves the wave.
4. Apply the lane ledgers: `echo '{"planDir":"<planDir>","fromResult":"<stageDir>/result.json"}' | <skills>/scripts/ledger-apply.sh` (add `"steps":[...]` to apply only the lanes you merged). Then remove each lane's worktree before its branch (a branch checked out in a worktree cannot be deleted): `git worktree remove --force <path>` (paths from `git worktree list`), then `git branch -D <lane branch>`.

`FAIL` lanes: re-run individually through `execute-step.js` (it has fix rounds). A lane with a commit is merged first and resumed (below), with `commit` = HEAD after the merge (the lane commit only on a fast-forward), `reviewBase` = HEAD before the merge and the lane's `sidecarSha` from the board; a `review` resume becomes `gates` when the merge was not a fast-forward (the merged tree was never gated).

---

## Failure Handling

Read the envelope's `fix` actionable first; open `<stageDir>/result.json` only for the detail it points at.

- `blocked` (sidecar unusable or drifted, no runnable gate, tree not clean, sidecar hash changed, plan files edited during the run, HEAD not the step commit on a branch, gate by-products, no lane for the tier, ledger-apply failed, CI pending/none/stale, reviewer crashed twice) → fix the artifact, the checkout or wait for CI (push the step commit if CI is `stale`), then resume (below) or re-run.
- `failed` with "worker left uncommitted work" → the worker's commit is incomplete: resume from `fix`, or (the human decides) commit or remove the files and resume from `gates`.
- `failed` at implement → the runtime or the worker's own verdict failed a gate. Environmental issue → fix it and resume from `gates`; real work left → resume from `fix`; wrong gate/step → amend step file + sidecar (re-run `validate-plan.sh`), re-run from scratch.
- `failed` at review/fix → fix rounds are exhausted. **Stop and escalate** with the step file, the final REVIEW-VERDICT (from `result.json`), and your diagnosis; resume from `fix` with the human's guidance.

### Resuming a step

Once a step has a commit, never re-run it from scratch to get past a later stop. Every non-PASS `execute-step.js` envelope with a commit carries a `fix` actionable `resume from <from> at <sha>: args.resume=…`, and `result.json` holds `resumePoint.args`: the exact args for the next run (fresh `stageDir`, `resume.resultPath` = this run's `result.json`). Re-launch `execute-step.js` with them unchanged, except: add `resume.guidance` (the human's words, quoted) for `fix`. `gates` and `review` need the commit at HEAD of the working branch: if HEAD differs, move the branch there (`git merge --ff-only <commit>`; anything else needs the human), and never check out the bare sha, which detaches HEAD and drops later work. The workflow blocks if the commit is missing or does not descend from the step base, if HEAD is not the commit for `gates`/`review`, or if the sidecar's sha256 differs from `sidecarSha` (recorded at first dispatch and carried in `resumePoint.args`; a human-approved sidecar change passes the new hash). A worker `FAIL` with a commit offers two `fix` actionables and `result.json` holds `resumePoint` (`fix`, primary) plus `resumeAlternatives[0]` (`gates`, its own full args and `-resume-gates` stageDir); a worker claim of PASS that the runtime gates rejected keeps `gates` primary with `fix` as the alternative. You do not pick: show the human both. `gates` — if the failure looks environmental (missing tool, network, stale checkout), fix the environment, re-run gates with the commit at HEAD; no worker is spent. `fix` — the work itself is wrong: continue the worker with `resume.guidance`. `execute-wave.js` lanes get both as actionables too. Other points the workflow sets: `gates` (worker claimed PASS, runtime gates rejected it — environment), `fix` (worker FAIL, review FAIL after the last round, gates still failing on resume), `review` (reviewer crashed twice; no fix round spent), `ci` (CI not green), `ledger` (PASS but ledger-apply failed). An `execute-wave.js` lane `BLOCKED` at review gets the same treatment after you merge it: `resume {from: "review", commit, workerRunId}`.
- Workflow/launch/extension failure → infrastructure blocker. Report the exact error, run id and repo state; do not switch execution mode.

Escalate immediately when: a wave has 3+ failing steps with no common fix; a change breaks tests the step never mentioned; the codebase diverges from plan assumptions; an irreversible action (migration, external API) looks wrong.

**Fix locally:** wrong paths, sidecar command syntax that contradicts repo conventions, missing deps. **Escalate:** acceptance criteria wrong for the requirement, unmodeled dependencies, repeated failures with different root causes, anything touching production data.

---

## Terminal Gate

The plan is complete **only** when `terminal-gate.js` returns `status: "done"` (pass `args.pr` when a PR exists; CI is then bound to `git rev-parse HEAD` in `args.repo` or the plan dir, so pass `repo` if the plan dir is outside the work repo, or `expectSha` to pin another commit). Otherwise act on its actionables: `fix` (unfinished step, malformed ledger, red CI) is your work; `decision` (an open ledger row) goes to the human to discharge or waive. Do not report completion, do not soften the wording, do not write waivers yourself.

---

## Reporting

One report per step or wave, plus immediately on any blocker:

```
Step 07 PASS (commit abc1234): <one line>. Ledger: 1 deferred (G-integ, owed by step-12).
Next: step 08.
```

```
## Blocked ⛔ Step NN — review failed after 2 fix rounds
Reviewer verdict: <verbatim findings>
Assessment: <diagnosis>
Options: 1. … 2. …
```

Completion report: all commits, the terminal-gate envelope, and any pending human decisions.

## Context Discipline

Keep in your context: the wave map, current step, the latest envelopes, failure history. Drop finished waves — git and PROGRESS.md hold them. Children get only what the workflow passes them; never paste PROGRESS.md or other steps into a task.
