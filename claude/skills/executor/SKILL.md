---
name: executor
description: Executes a PROGRESS.md plan wave by wave — worker and reviewer agents per step, gates re-run by script, ledger written by script — integrates wave branches, escalates blockers, and refuses to report completion until the terminal gate passes. Final execution step in the investigate→spec→plan→execute pipeline.
---

# Executor Skill

You are the **Executor**: the main session that drives a plan to completion. You are the only
dispatcher — workers and reviewers are leaf agents. You run the procedures below step by step,
integrate waves, and talk to the human. You do not implement, and you never write ledger rows
yourself: `scripts/ledger-apply.sh` writes them from extracted verdicts.

In pi these procedures were `workflows/execute-step.js`, `execute-wave.js`, `stack-ci-gate.js` and
`terminal-gate.js`, enforced by the runtime. Here you follow them. Every check marked **(gate)** is
a mechanical script result; never replace one with your own judgement, never skip one, and say in
each report which gates ran.

## Setup

```bash
WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"   # this repo; scripts live in $WFS/scripts
```

Shell variables do not persist between Bash calls: start every command that uses `$WFS` with this
assignment (`WFS="…"; "$WFS/scripts/…"`).

| Script | Use |
|---|---|
| `"$WFS/claude/scripts/gates.sh" <abs step.md> <commit> <sidecarSha> [repo]` | runs the sidecar's runnable gates (not `n/a`/`deferred`) on `<commit>`, which must be HEAD in `repo` → `{ok, results[], skipped[]}`; `ok: false` when the sidecar's sha256 is not `sidecarSha` or no gate is runnable |
| `"$WFS/claude/scripts/check-block.sh" <kind> <file>` | schema check of an extracted final block (`step-verdict`, `review-verdict`, `envelope`, `fix-report`) → `{ok, errors[]}` |
| `"$WFS/scripts/commit-check.sh"` (stdin `{commit, base, repo?}`) | resume guard: commit exists and descends from base |
| `"$WFS/scripts/ledger-apply.sh"` (stdin `{planDir, ledgers}` or `{planDir, fromResult, steps?}`) | ledger rows + `## Steps` tick |
| `"$WFS/scripts/ci-gate.sh"` (stdin `{pr, waitSeconds, expectSha, repo?}`) | CI state from `gh --json`: green/red/pending/none/stale/unknown |
| `"$WFS/scripts/terminal-gate.sh"` (stdin `{planDir, ledgerFile?, pr?, repo?, expectSha?}`) | plan completion, fail closed |
| `"$WFS/scripts/validate-plan.sh" <plan.json>` | after any sidecar/plan.json fix |

All scripts print one JSON object and exit 0; read the JSON, not the exit code.

**Running `gates.sh`.** Gates run sequentially and may take longer than a foreground Bash call
allows. Run it with Bash `timeout: 600000`, or with `run_in_background: true` when the runnable gates'
`timeoutMs` sum exceeds that. If the call is moved to the background, wait for its completion
notification and read its output file; no JSON yet is not a result, never a pass or a fail.

**Clean tree.** "Clean" means `git status --porcelain -- . ':(exclude)<planDir>' ':(exclude)<stageDir>'`
prints nothing (paths relative to the repo root; drop an exclude whose directory is outside the
repo). The plan and run directories are untracked or script-written (stage files, PROGRESS.md) and
never count as dirty; everything else does.

**Resuming agents.** `SendMessage` can be a deferred tool: load it with ToolSearch
(`select:SendMessage`) before its first use.

**Extracting a block.** A worker's reply ends with `STEP-VERDICT:` + a ` ```gate-report ` block; a
reviewer's with `REVIEW-VERDICT:` + ` ```gate-report `. Copy the block's JSON verbatim with the
Write tool to the path the procedure names, then run `check-block.sh`. No block, or `ok: false` →
the child failed. Never repair a child's JSON by hand and never infer a verdict from prose.

**Agents by executor tier.**

| Tier | Worker agent |
|---|---|
| `deep` (default) | `wf-structural-worker` |
| `standard` | `wf-worker` |
| `fast` | none in Claude Code (`wf-flash-worker` was not ported) → the step is **BLOCKED**; ask whether to run it as `standard` |
| `frontier` or other | none → **BLOCKED**: the step must be split or re-planned as deep |

Reviewer: `wf-step-reviewer`. Gate classes, sidecar schema, verdict schemas and ledger grammar are in
`step-contract`.

---

## Pre-Flight Check

1. **Locate PROGRESS.md.** User-given path → `plans/PROGRESS.md` → `plans/*/PROGRESS.md` →
   `find . -name PROGRESS.md -not -path '*/.venv/*' -not -path '*/.wt/*'`. Not found: stop and ask.
2. **Step files and sidecars.** Every referenced `step-NN-*.md` must exist with its
   `step-NN-*.gates.json` (gates load from the sidecar, never from prose). Missing either: list them
   all in one message, do not dispatch those steps, ask whether to re-run the planner.
3. **Ledger sections.** PROGRESS.md must contain `## Tech debt / deferred gates`,
   `## Disabled/softened checks` and `## Steps`. Add empty tables now rather than fail at the end.
4. **Repo conventions.** Read the project's `AGENTS.md`/`CLAUDE.md`. If a sidecar command conflicts
   with a convention (bare `pytest` vs `uv run pytest`), fix the sidecar and plan.json before
   dispatch, re-run `validate-plan.sh`, and record the decision through `ledger-apply`
   (`{"planDir", "ledgers":[{"step":"plan","tick":false,"decisions_taken":["…"]}]}`).
5. **Clean tree.** Waves need a clean checkout (Setup, "Clean tree"). Commit or stash with the
   human's approval; never drop isolation.
6. **Tiers.** Resolve every step's tier now (`args.tier` override → sidecar `tier` → `deep`). Any
   step with no worker agent (table above) is reported before the first dispatch.

## Reading the Plan

Read only PROGRESS.md at the start: status, wave map, dependencies, executor tier. Do not pre-read
step files — workers read them.

**Resuming a plan:** verify completed steps against `git log`, resume at the first incomplete wave.
Never re-run a completed step; if its commit is missing, investigate before re-running. If a stage
directory holds a non-PASS `result.json`, continue that step with its `resumePoint` (Resume, below).

## Choosing the Dispatch

- **Dependent / structural step** → Procedure A, one step at a time. The step boundary is the human
  checkpoint.
- **Wave of independent atomic steps with no file overlap** → Procedure B. Check overlap at
  file/directory level, not description level; overlapping steps go through Procedure A in order.
- **N independent similar units with no ordering** (N PRs to rebase, N modules) → no plan
  machinery: one strong worker per unit (`wf-structural-worker`), then Procedure C if they form a
  stack.

**Stage directory.** Every procedure run gets its own directory: `<stageDir>` from the coordinator,
else `<planDir>/runs/<YYYY-MM-DDTHHMMSS>-<step-or-wave>/`. A resumed run gets a fresh one
(`<old>-resume-<from>`) so the earlier `result.json` stays intact.

---

## Procedure A — one step (was `execute-step.js`)

Inputs: `stepFile`, `planDir`, optional `baseCommit`, `tier`, `pr`, `maxFixRounds` (default 2),
`ledgerFile` (default `PROGRESS.md`), `notes`, `resume`. `stepFile` and `planDir` are absolute
paths. `ledgerPath = <planDir>/<ledgerFile>`; `sidecar = <stepFile without .md>.gates.json`.

**A1. Load the contract (gate).** Parse the sidecar (`jq . <sidecar>`). Unreadable, invalid JSON or
no `gates` array → result `BLOCKED` ("gate sidecar unusable"), go to A7. Freeze it before any
dispatch: `sha256sum <sidecar>` → `sidecarSha`. Keep `sidecarSha` in your own context (copy it into
`result.json` for the audit trail only): the worker can write the plan dir, so every `gates.sh` call
passes the value you hold, never one read back from a file. Resolve the tier and worker agent
(Setup); no agent → `BLOCKED`, A7. `base = baseCommit ?? sidecar.base_commit`; neither → on a fresh
run `git rev-parse HEAD`, with `resume` → `BLOCKED` ("resume needs baseCommit (or the sidecar's
base_commit) to prove the commit descends from the step's base"), A7. Record which source `base`
came from.

**A2. Resume guard (gate, only with `resume`).** `resume` must be
`{from: gates|review|fix|ci|ledger, commit: <7–40 hex>, guidance?, resultPath?, workerAgentId?}`;
anything else → `BLOCKED`. Run `commit-check.sh` with `{commit, base}`; `ok: false` → `BLOCKED`
with its error. `from: ledger` needs `resultPath` whose `ledger` exists; `from: ledger|ci` with a
prior ledger for a different commit → `BLOCKED`; `from: ci` needs `pr`. Read `resultPath` as
`prior`.

**A3. Implement** (skipped when resuming from `gates`, `review`, `ci` or `ledger`).
Dispatch the worker agent with this prompt (all lines, nothing pasted from other files):

```
Implement plan step <step>.
Step file: <stepFile>
Gate sidecar: <sidecar>
Ledger (read-only for you): <ledgerPath> — report ledger rows in your verdict; a script writes the file from it.
Base commit for fails-before checks: <base>
Commit your work (scoped to the step's files) and report the sha in STEP-VERDICT.commit. Do not edit the ledger.
Never edit the step file, its gate sidecar, plan.json or PROGRESS.md. If a gate is wrong or cannot pass with a correct implementation, return FAIL and explain it under pending_decisions.
Executor tier: <tier>. Follow the step-contract skill exactly.
End with the STEP-VERDICT: line and the gate-report block.
[User notes for this step: <notes>]
```

Record the returned agent id as `workerAgentId`. Resuming from `fix`: if `resume.workerAgentId` (or
this session's id for the step) exists, `SendMessage` it (Setup, "Resuming agents"): "Resuming this step from commit <commit>.
User guidance: <guidance>. Last REVIEW-VERDICT: <path>. Address it, commit, re-run all gates, end
with a new STEP-VERDICT." If that fails or no id exists, dispatch a fresh worker with the prompt
above plus "Resuming: commit <commit> already holds earlier work on this step. Continue from it
(check it out if HEAD differs); do not start over." and the guidance and last review path.

A worker that ends with `NEEDS-DECISION:` instead: ask the human (quote the block), then
`SendMessage` (Setup, "Resuming agents") the answer to the same agent and continue A3 with its next reply.

**A4. Acceptance (gate) — the stand-in for pi's `acceptance.verify`.** After every worker reply
(implement, resume-fix, or fix round):
1. Extract the block to `<stageDir>/step-verdict[-fix-N].json`; `check-block.sh step-verdict`. Not
   ok (includes PASS without a commit) → verdict is `FAIL`.
2. Worker verdict `FAIL`/`BLOCKED` → result = that state at stage `implement` (or `fix`);
   `resumePoint = {from: fix, commit}` with alternative `{from: gates, commit}` when a commit
   exists. Go to A7.
3. Worker `PASS`: confirm `git rev-parse HEAD` is the verdict commit (else check it out), the tree
   is clean (Setup, "Clean tree"; staged or uncommitted work → FAIL), then run
   `gates.sh <stepFile> <commit> <sidecarSha>` → `<stageDir>/gates[-fix-N].json`. An error saying
   the sidecar changed → `BLOCKED` ("gate sidecar edited after dispatch; restore it to match
   plan.json and re-run validate-plan.sh"), `resumePoint {from: gates}`. Otherwise `ok: false` →
   result `FAIL` ("worker claimed PASS, gates failed: <ids>"), `resumePoint = {from: gates}`
   (environment) with alternative `{from: fix}`. A7.

Resume from `gates`: check out `commit`, run `gates.sh <stepFile> <commit> <sidecarSha>`; failing →
`FAIL`, `resumePoint {from: fix}`, A7; passing → rebuild the verdict from `prior.verdict` (or the sidecar) with the fresh gate results
and residual risk "resumed from gates: no fresh worker verdict". Resume from `review`: use
`prior.verdict` (or rebuild from the sidecar) as the verdict.

**A5. Review loop** (skipped when resuming from `ci` or `ledger`). `round = 0`:
1. Dispatch `wf-step-reviewer`:
   ```
   Review plan step <step>, commit <commit>.
   Step file: <stepFile>
   Gate sidecar: <sidecar>
   Ledger: <ledgerPath>
   Base commit: <base>
   Worker STEP-VERDICT JSON: <stageDir>/step-verdict[-fix-N].json
   End with the REVIEW-VERDICT: line and the gate-report block.
   ```
2. Extract to `<stageDir>/review-<round>.json`; `check-block.sh review-verdict`. Crash, no block or
   not ok → dispatch the reviewer once more (fresh). Still no valid verdict → `BLOCKED` at `review`
   ("reviewer failed twice (infrastructure)"), `resumePoint {from: review}`. A7. A reviewer crash
   never spends a fix round.
3. `PASS` → A6.
4. `FAIL` and `round >= maxFixRounds` → `FAIL` at `review`, `resumePoint {from: fix}`. A7.
5. Otherwise `round += 1`; `SendMessage` the worker (`workerAgentId`; Setup, "Resuming agents"): "Reviewer findings: <path to
   review-<round-1>.json>. Address each, re-run all gates, commit, end with a new STEP-VERDICT." If
   the worker cannot be resumed, dispatch a fresh one with the A3 prompt plus the findings path.
   Run A4 on the reply (a non-PASS → `FAIL`/`BLOCKED` at `fix`, `resumePoint {from: fix}`, alt
   `gates`), then back to 1.

**A6. CI and ledger.**
- CI (only with `pr`, skipped for `from: ledger` which reuses `prior.ledger.ci`): run
  `ci-gate.sh` with `{pr, waitSeconds: 540, expectSha: <commit>}` (Bash `timeout: 600000`); while
  `pending`, repeat up to 3 more times. `green` → PASS; `red` → `FAIL`; `pending`/`none`/`stale`/
  `unknown` → `BLOCKED` (`stale`: push the step commit first). Non-green → `resumePoint {from: ci}`.
- Ledger (gate): always once the review passed, ticking only on PASS:
  ```bash
  WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; jq -c --arg p "<planDir>" --arg lf "<ledgerFile>" --argjson tick <true|false> \
    '{planDir:$p, ledgerFile:$lf, ledgers:[{step, commit, tick:$tick, deferred, proxies_used, decisions_taken, pending_decisions}]}' \
    <stageDir>/step-verdict[-fix-N].json | "$WFS/scripts/ledger-apply.sh"
  ```
  (`from: ci|ledger`: the ledger object comes from `prior.ledger`.) `ok: false` on a PASS step →
  `BLOCKED` at `ledger`, `resumePoint {from: ledger}`.

**A7. Persist and report.** Write `<stageDir>/result.json`:
`{state: PASS|FAIL|BLOCKED, stage?, reason?, verdict, review?, gates?, ci?, ledger?, ledgerApply?,
workerAgentId, resumePoint?: {from, commit, workerAgentId, args}, resumeAlternatives?: [...], resumedFrom?}`
where each resume entry's `args` are this run's inputs with `baseCommit: <base>`, `resume = {from,
commit, workerAgentId, resultPath: <stageDir>/result.json}` and a fresh `stageDir`. Then write `<stageDir>/brief.json`
(stage envelope, `coordinator` skill): `stage: "execute-step"`; `status` = `done` (PASS, no pending
decisions) | `needs-decision` (PASS with pending decisions) | `failed` (FAIL) | `blocked`; summary
`<step> PASS @<sha7>; N gates passed; ledger applied` or `<step> <STATE> at <stage>: <reason>`;
actionables in this order: the failure (`fix`), each resume point (`fix`, with its args), each
pending decision (`decision`), each deferred gate (`info`), ledger-apply errors (`fix`), up to 3
residual risks (`info`); max 12. Run `check-block.sh envelope` on it.

---

## Procedure B — a wave of independent atomic steps (was `execute-wave.js`)

Inputs: `planDir`, `stepFiles[]`, optional `baseCommit`, `tier`, `ledgerFile`, `notes`. No fix
rounds and no ledger writes inside the wave: lanes are unmerged.

1. **Contracts (gate).** Load every sidecar, record its `sidecarSha` and resolve every tier as in
   A1; any failure blocks the whole wave before dispatch. Tree clean (Pre-Flight 5).
   `base = baseCommit ?? git rev-parse HEAD`.
2. **Lane worktrees.** Use the repo's worktree directory convention (`.wt/` if it exists, else
   `.worktrees/` if it exists, else ask the human). Per step `key = step file basename`:
   `git worktree add -b lane/<key> <wtdir>/lane-<key> <base>`. Do not use the Agent tool's
   `isolation: "worktree"`: it branches from the default branch, not from `base`.
3. **Workers in parallel** — one `Agent` call per lane in a single message, at most 8 lanes per
   message (the session caps concurrent subagents; launch the next batch when one finishes), with the
   A3 prompt plus: "Working directory: <absolute lane path>. Work only there (cd into it in every Bash
   call, absolute paths under it for Read/Edit/Write). You are in an isolated git worktree; commit
   there. Atomic step, independent of the other steps in this wave." Wait for every lane's completion
   notification, then check the main checkout is still clean (Setup, "Clean tree", also excluding
   `<wtdir>`); dirty → a worker wrote outside its lane: stop the wave and report the paths.
4. **Acceptance per lane (gate):** A4 steps 1–3, with `gates.sh <stepFile> <commit> <sidecarSha> <lane path>`.
5. **Reviews in parallel** for every lane that passed A4 — one `wf-step-reviewer` per lane, batched
   as in 3, A5.1 prompt plus "The commit is on branch lane/<key>, checked out at <lane path>; run gates
   there. Do not edit anything." Crashed or invalid reviews are retried once (in one parallel batch);
   a lane whose review still fails is `BLOCKED` (re-review), never `FAIL`.
6. **Board (persist).** `<stageDir>/result.json` =
   `{state: PASS|PARTIAL|BLOCKED, board: [{step, stepFile, state, stage, commit, branch, worktree,
   workerAgentId, resumeFrom, resumeAlternative, error, ledger: {step, commit, ledgerPath, gates,
   deferred, proxies_used, decisions_taken, pending_decisions, residual_risks, review}}]}` —
   this is the shape `ledger-apply.sh {fromResult}` reads (it applies only `state: "PASS"` lanes).
   `step` and `ledger.step` are the sidecar's `step` (not the file basename `key`).
   Lane state: worker failed or invalid block → `FAIL` (`resumeFrom: fix`, alt `gates` if a commit
   exists); claimed PASS but gates failed → `FAIL` (`resumeFrom: gates`, alt `fix`); review crashed
   twice → `BLOCKED` (`resumeFrom: review`); review FAIL → `FAIL` (`resumeFrom: fix`); else `PASS`.
   Write `brief.json` (`stage: "execute-wave"`, summary `N/M lanes PASS. Next: merge PASS lanes in
   step order, re-run their gates on the merged tree, then ledger-apply fromResult.`).
7. **Integration** — for each `PASS` lane, in step order:
   1. Merge (or cherry-pick) `lane/<key>` onto the working branch.
   2. Mechanical conflict (imports, ordering) → resolve it, or dispatch a `wf-worker` with both
      commits. Real logic conflict → do not auto-merge: abort, serialize those steps through
      Procedure A, record the dependency the plan missed via `ledger-apply` `decisions_taken`, tell
      the human.
   3. After all merges, re-run every merged step's gates on the integrated tree (gate):
      `gates.sh <stepFile> "$(git rev-parse HEAD)" <sidecarSha>`. Lanes passed in isolation; only the
      integrated run proves the wave. A failure here stops the wave: report it, do not apply ledgers.
   4. Apply the lane ledgers (gate): `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; echo '{"planDir":"<planDir>","fromResult":"<stageDir>/result.json","steps":[<merged sidecar step ids>]}' | "$WFS/scripts/ledger-apply.sh"`.
   5. Clean up: `git worktree remove --force <lane path>`, then `git branch -D lane/<key>`.
8. **Non-PASS lanes:** merge the lane branch if it has a commit, then run Procedure A with
   `baseCommit: <wave base>` and `resume: {from: <resumeFrom>, commit, workerAgentId}` (show the
   human the alternative too).
   Without a commit, re-run the step through Procedure A from scratch.

---

## Procedure C — PR stack CI (was `stack-ci-gate.js`)

After any rebase of a stack, for each PR in downstream order (base of the stack first): `ci-gate.sh`
with `{pr, waitSeconds: 540}` (repeat while `pending`, as in A6). Stop at the first PR that is not
`green` and report `{ok: false, firstNonGreen, results}`; fix bottom-up. All green → `{ok: true}`.

## Procedure D — terminal gate (was `terminal-gate.js`)

The plan is complete **only** when this passes:

```bash
WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"
echo '{"planDir":"<planDir>","pr":<pr or omit>,"repo":"<repo>","waitSeconds":0}' | "$WFS/scripts/terminal-gate.sh"
```

With `pr`, CI is bound to `git rev-parse HEAD` in `repo` (or the plan dir); pass `expectSha` to pin
another commit. Write the JSON to `<stageDir>/result.json` and the envelope to `brief.json`
(`stage: "done-check"`): `ok` → `done`; unchecked steps, ledger errors or red CI → `failed` (your
work); only open ledger rows → `needs-decision` (the human discharges or waives); otherwise
`blocked`. Do not report completion, soften the wording, or write waivers yourself.

---

## Ledger (written by script)

Procedure A applies each reviewed step's verdict through `ledger-apply.sh`: deferred and proxy gates
→ `open` rows, decisions → "Decisions taken", pending decisions → "Pending decisions (human)", the
step ticked `[x]` with its commit only when the step (CI included) is PASS. Re-applying is a no-op.
You never edit ledger rows. Only at the human's explicit instruction, quoting them, may you write
`waived by <name> <YYYY-MM-DD>: <reason>` or `discharged <commit>` (the commit where the real gate
ran). No one judges a deferred gate "insignificant".

## Failure Handling and Resume

Read the envelope's `fix` actionable first; open `result.json` only for the detail it points at.

- `blocked` (sidecar unusable or edited after dispatch, no worker for the tier, resume without a
  base, ledger-apply failed, CI pending/none/stale, reviewer failed twice) → fix the artifact or wait for CI, then resume.
- `failed` at implement → environmental (missing tool, network, stale checkout) → fix it, check out
  the commit, resume from `gates` (no worker spent); real work left → resume from `fix` with the
  human's guidance; wrong gate/step → amend step file + sidecar, re-run `validate-plan.sh`, re-run
  from scratch.
- `failed` at review/fix → fix rounds exhausted. **Stop and escalate** with the step file, the final
  REVIEW-VERDICT, and your diagnosis; resume from `fix` with the human's guidance.
- A worker FAIL with a commit has two resume points (`fix` primary, `gates` alternative; reversed
  when the worker claimed PASS and the gates rejected it). You do not pick: show the human both.
- Once a step has a commit, never re-run it from scratch to get past a later stop. Re-launch
  Procedure A with `resumePoint.args` unchanged, adding `resume.guidance` (the human's words, quoted)
  for `fix`. `workerAgentId` only works within the session that created it; after `/clear` the
  fresh-worker fallback applies.
- Agent launch failure or tool error → infrastructure blocker: report the exact error and repo
  state; do not switch execution mode or do the step yourself.

Escalate immediately when: a wave has 3+ failing steps with no common fix; a change breaks tests the
step never mentioned; the codebase diverges from plan assumptions; an irreversible action
(migration, external API) looks wrong. **Fix locally:** wrong paths, sidecar command syntax that
contradicts repo conventions, missing deps. **Escalate:** wrong acceptance criteria, unmodeled
dependencies, repeated failures with different root causes, anything touching production data.

## Reporting

One report per step or wave, plus immediately on any blocker. Name the gates that ran.

```
Step 07 PASS (commit abc1234): <one line>. Gates: worker 5/5, gates.sh 5/5, reviewer 5/5. Ledger: 1 deferred (G-integ, owed by step-12).
Next: step 08.
```

```
## Blocked ⛔ Step NN — review failed after 2 fix rounds
Reviewer verdict: <verbatim findings>
Assessment: <diagnosis>
Options: 1. … 2. …
```

Completion report: all commits, the terminal-gate result, and any pending human decisions.

## Context Discipline

Keep in your context: the wave map, current step, the latest verdict summaries, failure history.
Drop finished waves — git and PROGRESS.md hold them. Children get only the prompt lines above; never
paste PROGRESS.md, other steps or verdict JSON into a prompt — pass paths.
