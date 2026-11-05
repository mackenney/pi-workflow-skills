---
name: executor
description: Executes a PROGRESS.md plan wave by wave — worker and reviewer agents per step, gates re-run by script, ledger written by script — integrates wave branches, escalates blockers, and refuses to report completion until the terminal gate passes. Final execution step in the investigate→spec→plan→execute pipeline.
---

# Executor Skill

You are the **Executor**: the main session that drives a plan to completion. You are the only
dispatcher — workers and reviewers are leaf agents. You run the procedures below step by step,
integrate waves, and talk to the human. You do not implement (sole exception: B.7.2 union merges),
and you never write ledger rows yourself: `scripts/ledger-apply.sh` writes them from extracted
verdicts.

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
| `"$WFS/claude/scripts/gates.sh" <abs step.md> <commit> <sidecarSha> [repo] [--stage <stageDir>] [--wtdir <wtdir>]` | runs the sidecar's runnable gates (not `n/a`/`deferred`) on `<commit>`, which must be HEAD in `repo` → `{ok, head, results: [{id, pass, exitCode, timedOut, ms, tail}], skipped[]}`; `ok: false` with `error` (and `hint` naming likely gate by-products) and no `results` when the sidecar's sha256 is not `sidecarSha`, no gate is runnable, HEAD is not `commit`, or `repo` is not clean (below) |
| `"$WFS/claude/scripts/gates.sh" --clean <abs planDir> [repo] [--stage <stageDir>] [--wtdir <wtdir>]` | the clean-tree check alone → `{ok, paths[], error?, hint?}` |
| `"$WFS/claude/scripts/check-block.sh" <kind> <file>` | schema check of an extracted final block (`step-verdict`, `review-verdict`, `envelope`, `fix-report`) → `{ok, errors[]}` |
| `"$WFS/scripts/commit-check.sh"` (stdin `{commit, base, repo?}`) | resume guard: commit exists and descends from base |
| `"$WFS/scripts/ledger-apply.sh"` (stdin `{planDir, ledgers}` or `{planDir, fromResult, steps?}`) | ledger rows + `## Steps` tick |
| `"$WFS/scripts/ci-gate.sh"` (stdin `{pr, waitSeconds, expectSha, repo?}`) | CI state from `gh --json`: green/red/pending/none/stale/unknown |
| `"$WFS/scripts/terminal-gate.sh"` (stdin `{planDir, ledgerFile?, pr?, repo?, expectSha?}`) | plan completion, fail closed |
| `"$WFS/scripts/validate-plan.sh" <plan.json>` | after any sidecar/plan.json fix |

All scripts print one JSON object and exit 0; read the JSON, not the exit code.

**Running `gates.sh`.** Gates run sequentially and may take longer than a foreground Bash call
allows. Run it with Bash `timeout: 600000`, or with `run_in_background: true` and `timeout` =
min(Σ runnable `timeoutMs` (default 900000 each) + 60000, 7200000) when that sum exceeds 540000. In
an unattended or cloud session (`-p`, Agent SDK, CI, cloud) the platform stops background commands
at that timeout, at most 2 h unless `BASH_MAX_TIMEOUT_MS` raises it: there, a sum over the cap →
`BLOCKED` at `gates` (split the step's gates). Local terminal, desktop and IDE sessions have no
background limit. If the call is moved to the background, wait for its
completion notification and read its output file; no JSON yet is not a result, never a pass or a
fail. A background stop notice, or an exit without JSON → `BLOCKED` at `gates`, `resumePoint {from: gates}`.

**`gates.sh` outcomes.** `error` set and no `results` array → `BLOCKED` at `gates` (infrastructure:
usage, bad sha, unreadable sidecar, HEAD mismatch, dirty tree), `resumePoint {from: gates}`; an
error saying the sidecar changed → `BLOCKED` ("gate sidecar edited after dispatch; restore it to
match plan.json"), resume from `gates` only once it is restored. `results` containing a fail → as
the calling step says.

**Clean tree.** "Clean" means `gates.sh --clean <planDir> <repo> --stage <stageDir> [--wtdir
<wtdir>]` prints `ok: true` (pass `--wtdir` whenever lane worktrees may exist; in a lane, `<repo>` is
the lane path). That one script is the definition both you and the gate run use: untracked files are
listed per file whatever the user's git config, submodules are never ignored, and these do not
count as dirty: the plan dir, its parent when nothing under the parent is tracked (sibling plan
dirs), the stage dir, and registered worktrees under `--wtdir`. Everything else does. A plan dir at
the repo root is an `error` (→ `BLOCKED`, stage `contract`: move the plan into a subdirectory).
Ignored files are never checked, so gate by-products (caches, coverage, build output) must be
gitignored; when `hint` names such paths, tell the human to gitignore them rather than calling it
worker dirt.

**Resuming agents.** If `SendMessage` is not in your tool list, load it with ToolSearch
(`select:SendMessage`) before its first use.

**Waiting.** After a dispatch, wait for every child's completion notification (a single dispatch
may also return inline). Notifications always arrive; do not schedule wakeups, crons or sleep loops
while waiting (in `-p` a pending wakeup keeps the process alive until it fires). Never put your own
attribution trailer (`Co-Authored-By`) into a child prompt: each agent names its own model.

**Envelope (`brief.json`).** Shape, no other keys: `{"stage", "status":
"done|needs-decision|failed|blocked", "summary" (≤400 chars), "actionables": [{"what" (≤300 chars),
"kind": "decision|fix|info", "ref": "<file#anchor>"}] (≤12), "artifacts": {"primary": "<path>",
"details"?: ["<path>"]}}`. Long resume args go in `result.json` and are `ref`'d, never put in
`what`. Check it with `check-block.sh envelope`.

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

Reviewer: `wf-step-reviewer`. Gate classes, sidecar schema, verdict schemas and ledger grammar are
in `step-contract`. **Single depth.** Dispatch only `wf-*` agents; never fork
(`subagent_type: "fork"`) or use `general-purpose`: both carry `Agent` and break single depth.

---

## Pre-Flight Check

1. **Locate PROGRESS.md.** User-given path → `plans/PROGRESS.md` → `plans/*/PROGRESS.md` →
   `find . -name PROGRESS.md -not -path '*/.venv/*' -not -path '*/.wt/*'`. Not found: stop and ask.
2. **Step files and sidecars.** Every referenced `step-NN-*.md` must exist with its
   `step-NN-*.gates.json` (gates load from the sidecar, never from prose). Missing either: list them
   all in one message, do not dispatch those steps, ask whether to re-run the planner. Do not run
   the whole-plan `validate-plan.sh` here: only after a sidecar/plan.json fix (step 4).
3. **Ledger sections.** PROGRESS.md must contain `## Tech debt / deferred gates`,
   `## Disabled/softened checks` and `## Steps`. Add empty tables now rather than fail at the end.
4. **Repo conventions.** Read the project's `AGENTS.md`/`CLAUDE.md`. If a sidecar command conflicts
   with a convention (bare `pytest` vs `uv run pytest`), fix the sidecar and plan.json before
   dispatch, re-run `validate-plan.sh`, and record the decision through `ledger-apply`
   (`{"planDir", "ledgers":[{"step":"plan","commit":"<git rev-parse HEAD>","tick":false,"decisions_taken":["…"]}]}`;
   without `commit` the row renders as `plan @?`).
5. **Clean tree.** Waves need a clean checkout (Setup, "Clean tree"). Commit or stash with the
   human's approval; never drop isolation.
6. **Tiers.** Resolve every step's tier now (`args.tier` override → sidecar `tier` → `deep`). Any
   step with no worker agent (table above) is reported before the first dispatch.

## Reading the Plan

Read only PROGRESS.md at the start: status, wave map, dependencies, executor tier. Do not pre-read
step files — workers read them. For file overlap (Choosing the Dispatch) use each step's `files` in
plan.json or its sidecar.

**Resuming a plan:** verify completed steps against `git log`, resume at the first incomplete wave.
Never re-run a completed step; if its commit is missing, investigate before re-running. If a stage
directory holds a non-PASS step `result.json`, continue that step with its `resumePoint` (Resume,
below); its `args` carry the `sidecarSha` recorded at first dispatch. A wave `result.json` (it has
`board`): resume its non-PASS lanes per B.8 from the board.

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
(`<old>-resume-<from>`) so the earlier `result.json` stays intact. A stage dir given for a run that
spans several procedures (a wave plus Procedure D, several steps) is a root: each procedure gets
`<root>/<YYYY-MM-DDTHHMMSS>-<step|wave-N|done-check>/` (timestamp from `date`, never invented).

---

## Procedure A — one step (was `execute-step.js`)

Inputs: `stepFile`, `planDir`, optional `baseCommit`, `reviewBase`, `tier`, `pr`, `maxFixRounds`
(default 2), `ledgerFile` (default `PROGRESS.md`), `notes`, `resume`, `sidecarSha` (required with
`resume`), `wtdir` (lane worktree dir, when lanes may exist), `stageDir`. `stepFile` and `planDir`
are absolute paths. `ledgerPath = <planDir>/<ledgerFile>`; `sidecar = <stepFile without
.md>.gates.json`; `repo` = the main checkout (`git -C <planDir> rev-parse --show-toplevel`, or the
repo the plan targets). Procedure A does not branch: the step commits on the current branch.

**A1. Load the contract (gate).** Every `BLOCKED` in A1 uses `stage: "contract"`. With `resume`, a
block in A1 or A2 sets `resumePoint` to the incoming `resume` (same `from`, `commit`, args, fresh
`stageDir`) so the next attempt can be launched from this run's `brief.json`. Parse the sidecar
(`jq . <sidecar>`). Unreadable, invalid JSON or no `gates` array → result `BLOCKED` ("gate sidecar
unusable"), go to A7. Check it against this step's plan.json entry (only this step: whole-plan
`validate-plan.sh` fails once ledger rows are discharged or waived):
`jq -n --slurpfile c <sidecar> --slurpfile p <planDir>/plan.json '$c[0] as $c | [$p[0].steps[] | select(.id == $c.step)] | length == 1 and (.[0].gates == $c.gates) and ((.[0].coverage // []) == ($c.coverage // [])) and (.[0].tier == $c.tier)'`
prints anything but `true` → `BLOCKED` ("sidecar drifted from plan.json"), A7. Freeze it before any dispatch:
`sha256sum <sidecar> | cut -d' ' -f1` → the current hash. `sidecarSha` supplied (always with
`resume`, and on a lane re-run) → it must equal the current hash; absent on a fresh run → take the
current hash. Absent with `resume` → `BLOCKED` ("resume needs the sidecar hash recorded at first
dispatch"); not equal → `BLOCKED` ("sidecar changed since the stopped run; restore it, or have the
human approve the new hash <current hash> and pass it as `sidecarSha`"), A7. The worker can write the
plan dir, so every `gates.sh` call passes the value from your inputs or first hash, never one
re-read from a file mid-run; A7 records it in `result.json` and every resume entry's `args`.
Resolve the tier and worker agent (Setup); no agent → `BLOCKED`, A7. `base = baseCommit ??
sidecar.base_commit`; neither → on a fresh run `git rev-parse HEAD`, with `resume` → `BLOCKED`
("resume needs baseCommit (or the sidecar's base_commit) to prove the commit descends from the
step's base"), A7. Record which source `base` came from. `reviewBase = reviewBase ?? base`: the tree
the step's own change is measured against (scope, fails-before). It differs from `base` only when
other lanes were integrated before this step's commit (B.7.2, B.8).

**A2. Resume guard (gate, only with `resume`).** `resume` must be
`{from: gates|review|fix|ci|ledger, commit: <7–40 hex>, guidance?, resultPath?, workerAgentId?}`;
anything else → `BLOCKED`. Run `commit-check.sh` with `{commit, base}`; `ok: false` → `BLOCKED`
with its error. Read `resultPath` as `prior`; a wave result (it has `board`) → `prior` is the board
lane whose `step` is the sidecar's `step`. `from: ledger` needs a `prior` whose `ledger` exists;
`from: ledger|ci` with a prior ledger for a different commit → `BLOCKED`; `from: ci` needs `pr`.
Never check out `commit`: checking out a sha in the main checkout detaches HEAD and drops what was
integrated after it. Each stage below that needs `commit` at HEAD checks it and blocks instead.

**A3. Implement** (skipped when resuming from `gates`, `review`, `ci` or `ledger`).
Dispatch the worker agent with this prompt (all lines, nothing pasted from other files):

```
Implement plan step <step>.
Repo: <repo> (commit on the current branch)
Step file: <stepFile>
Gate sidecar: <sidecar>
Ledger (read-only for you): <ledgerPath> — report ledger rows in your verdict; a script writes the file from it.
Base commit for fails-before checks: <reviewBase>
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
above plus "Resuming: commit <commit> already holds earlier work on this step. Continue on the
current branch; do not check out another commit and do not start over." and the guidance (which
wins where it says how to bring the commit onto the branch) and last review path.

A worker that ends with `NEEDS-DECISION:` instead: ask the human (quote the block), then
`SendMessage` (Setup, "Resuming agents") the answer to the same agent and continue A3 with its next reply.

**A4. Acceptance (gate) — the stand-in for pi's `acceptance.verify`.** After every worker reply
(implement, resume-fix, or fix round):
1. Extract the block to `<stageDir>/step-verdict[-fix-N].json`; `check-block.sh step-verdict`. Not
   ok (includes PASS without a commit), or its `step` is not the sidecar's `step` → verdict is
   `FAIL` (a wrong `step` would make ledger-apply tick another step).
2. Worker verdict `FAIL`/`BLOCKED` → result = that state at stage `implement` (or `fix`);
   `resumePoint = {from: fix, commit}` with alternative `{from: gates, commit}` when a commit
   exists. Go to A7.
3. Worker `PASS`: `git -C <repo> rev-parse HEAD` must be the verdict commit, else `BLOCKED` at
   `gates` ("HEAD is not the step commit; move the working branch to it"), `resumePoint {from:
   gates}`, A7 (never check it out). The tree must be clean (Setup, "Clean tree"; staged, uncommitted
   or stray work → FAIL, unless every path is in `hint`: then `BLOCKED`, gitignore them). Then run
   `gates.sh <stepFile> <commit> <sidecarSha> <repo> --stage <stageDir> [--wtdir <wtdir>]` →
   `<stageDir>/gates[-fix-N].json`. Error without `results` → Setup, "`gates.sh` outcomes". A
   failing gate → result `FAIL` ("worker claimed PASS, gates failed: <ids>"), `resumePoint = {from:
   gates}` (environment) with alternative `{from: fix}`. A7.

Resume from `gates`: HEAD must be `commit` (as in A4.3, `BLOCKED` otherwise), the tree clean; run
`gates.sh` as in A4.3; error without `results` → Setup, "`gates.sh` outcomes"; a failing gate →
`FAIL`, `resumePoint {from: fix}`, A7; passing → rebuild the verdict from `prior.verdict ??
prior.ledger` (or the sidecar) with the fresh gate results, `commit` set to the resume `commit`, and
residual risk "resumed from gates: no fresh worker verdict". Resume from `review`: rebuild it the
same way (`commit` = the resume `commit`). Either way write it to `<stageDir>/step-verdict.json` and
run `check-block.sh step-verdict`; not ok → `BLOCKED` at `gates`/`review` with its errors.

**A5. Review loop** (skipped when resuming from `ci` or `ledger`). `round = 0`:
1. Dispatch `wf-step-reviewer`:
   ```
   Review plan step <step>, commit <commit>.
   Repo: <repo> (the commit is HEAD of the current branch; Procedure A does not branch)
   Step file: <stepFile>
   Gate sidecar: <sidecar>
   Ledger: <ledgerPath>
   Base commit: <reviewBase> (the step's change is <reviewBase>..<commit>)
   Worker STEP-VERDICT JSON: <stageDir>/step-verdict[-fix-N].json
   End with the REVIEW-VERDICT: line and the gate-report block.
   ```
2. Extract to `<stageDir>/review-<round>.json`; `check-block.sh review-verdict`. If every error is a
   "contradictory PASS", route it as a `FAIL` with its findings (step 4/5; do not edit the block).
   Crash, no block or other errors → dispatch the reviewer once more (fresh). Still no valid
   verdict → `BLOCKED` at `review` ("reviewer failed twice (infrastructure)"), `resumePoint {from:
   review}`. A7. A reviewer crash never spends a fix round.
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
  WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; jq -c --arg p "<planDir>" --arg lf "<ledgerFile>" --arg s "<sidecar step>" --argjson tick <true|false> \
    '{planDir:$p, ledgerFile:$lf, ledgers:[{step:$s, commit, tick:$tick, deferred, proxies_used, decisions_taken, pending_decisions}]}' \
    <stageDir>/step-verdict[-fix-N].json | "$WFS/scripts/ledger-apply.sh"
  ```
  (`from: ci|ledger`: the ledger object comes from `prior.ledger`; its `step` must be the sidecar's
  `step`, else `BLOCKED` at `ledger` without running ledger-apply, which would tick the wrong
  step.) `ok: false` on a PASS step → `BLOCKED` at `ledger`, `resumePoint {from: ledger}`.

**A7. Persist and report.** Write `<stageDir>/result.json`:
`{state: PASS|FAIL|BLOCKED, stage?, reason?, verdict, review?, gates?, ci?, ledger?, ledgerApply?,
sidecarSha, workerAgentId, resumePoint?: {from, commit, workerAgentId, args}, resumeAlternatives?: [...], resumedFrom?}`
where each resume entry's `args` are this run's inputs with `baseCommit: <base>`, `reviewBase`,
`sidecarSha`, `resume = {from, commit, workerAgentId, resultPath: <stageDir>/result.json}` and a
fresh `stageDir`. Then write `<stageDir>/brief.json` (Setup, "Envelope"): `stage:
"execute-step"`; `status` = `done` (PASS, no pending
decisions) | `needs-decision` (PASS with pending decisions) | `failed` (FAIL) | `blocked`; summary
`<step> PASS @<sha7>; N gates passed; ledger applied` or `<step> <STATE> at <stage>: <reason>`;
actionables in this order: the failure (`fix`), each resume point (`fix`, with its args), each
pending decision (`decision`), each deferred gate (`info`), ledger-apply errors (`fix`), up to 3
residual risks (`info`); max 12. A resume point's actionable `ref`s `result.json#resumePoint`; a
hash-mismatch block's names the current hash for the human to approve. Run `check-block.sh
envelope` on it.

---

## Procedure B — a wave of independent atomic steps (was `execute-wave.js`)

Inputs: `planDir`, `stepFiles[]` (absolute; resolve PROGRESS.md's `./step-NN-*.md` links before
B.1), optional `baseCommit`, `tier`, `ledgerFile`, `notes`, `wtdir` (absolute lane worktree dir;
overrides the lookup in B.2), `stageDir`. No fix rounds and no ledger writes inside the wave: lanes
are unmerged. Per step, `key` = the sidecar's `step` (the step file basename without `.md`).

1. **Contracts (gate).** Load and check every sidecar, record its `sidecarSha` and resolve every
   tier as in A1; any failure blocks the whole wave before dispatch. A step whose `lane/<key>`
   branch survives from an earlier wave run takes `sidecarSha` from that run's board (`result.json`
   in its stage dir) and A1 compares it with the current hash; never re-hash a re-entered lane.
   Tree clean (Pre-Flight 5). `base = baseCommit ?? git rev-parse HEAD`.
2. **Lane worktrees.** `wtdir` input, else the repo's convention (`<repo>/.wt/` if it exists, else
   `<repo>/.worktrees/` if it exists). Neither: write `result.json` `{state: BLOCKED, stage:
   "lanes", reason}` and a `blocked` brief with one `decision` actionable, then ask the human,
   recommending `<repo>/.wt/` listed in `.git/info/exclude`. Whichever dir is used, it must be
   ignored: if `git check-ignore -q <wtdir>/x` fails, append `/<wtdir relative to the repo>/` to
   `$(git rev-parse --git-path info/exclude)` (never `.gitignore`: a tracked edit dirties the tree).
   Per step: `git worktree add -b lane/<key> <wtdir>/lane-<key> <base>`. If `lane/<key>` already
   exists (an earlier run of this step), reuse it only when `commit-check.sh` `{commit: <its tip>,
   base}` is ok, and add the A3 "Resuming: commit <tip>…" line to that worker's prompt; otherwise
   stop and ask the human. A reused lane whose worktree `git worktree list --porcelain` already
   shows at `<wtdir>/lane-<key>` keeps that worktree; else `git worktree add <wtdir>/lane-<key>
   lane/<key>`. Do not use the Agent tool's `isolation: "worktree"`: it branches from the default
   branch, not from `base`.
3. **Workers in parallel** — one `Agent` call per lane, at most 8 lane agents running at once (the
   first 8 in one message; launch the next lane on each completion notification). `Concurrent
   subagent limit reached` is not a failure, although its text says not to retry: wait for a
   running child's completion notification, then relaunch that lane. Each prompt is the A3 prompt
   with `Repo: <lane path>` plus: "Work only in <lane path> (cd into it in every Bash call, absolute
   paths under it for Read/Edit/Write). You are in an isolated git worktree on branch lane/<key>;
   commit there. Atomic step, independent of the other steps in this wave." Wait for every lane's
   completion notification (Setup, "Waiting"), then check the main checkout is still clean (Setup,
   "Clean tree", with `--wtdir <wtdir>`); dirty → a worker wrote outside its lane: stop the wave and
   report the paths.
4. **Acceptance per lane (gate):** A4 steps 1–3 with `<repo>` = the lane path: the HEAD check is
   `git -C <lane path> rev-parse HEAD`, the clean check `gates.sh --clean <planDir> <lane path>`, the
   gate run `gates.sh <stepFile> <commit> <sidecarSha> <lane path> --stage <stageDir>`.
5. **Reviews in parallel** for every lane that passed A4 — one `wf-step-reviewer` per lane, batched
   as in 3, the A5.1 prompt with `Repo: <lane path> (the commit is HEAD of branch lane/<key>; run
   gates there. Do not edit anything.)`. A review whose only `check-block` errors are "contradictory
   PASS" is a review `FAIL` (`resumeFrom: fix`), as in A5.2. Other crashed or invalid reviews are
   retried once (in one parallel batch); a lane whose review still fails is `BLOCKED` (re-review),
   never `FAIL`.
6. **Board (persist).** `<stageDir>/result.json` =
   `{state: PASS|PARTIAL|BLOCKED, base, wtdir, board: [{step, stepFile, sidecarSha, state, stage,
   commit, branch, worktree, workerAgentId, resumeFrom, resumeAlternative, error, ledger: {step,
   commit, ledgerPath, gates, deferred, proxies_used, decisions_taken, pending_decisions,
   residual_risks, review}}]}` — this is the shape `ledger-apply.sh {fromResult}` reads (it applies
   only `state: "PASS"` lanes). `step` and `ledger.step` are the sidecar's `step`; `ledger.gates` is
   the gates.sh `results` array. Wave `state`: `BLOCKED` only for a block before dispatch (B.1,
   B.2), else `PASS` when every lane passed, else `PARTIAL`.
   Lane state: worker failed or invalid block → `FAIL` (`resumeFrom: fix`, alt `gates` if a commit
   exists); gates.sh "sidecar changed" → `BLOCKED` (`resumeFrom: gates` once the sidecar is
   restored, the reason in `error`); other gates.sh error without `results` → `BLOCKED`
   (`resumeFrom: gates`); claimed PASS but a gate failed → `FAIL` (`resumeFrom: gates`, alt `fix`);
   review crashed twice → `BLOCKED` (`resumeFrom: review`); review FAIL → `FAIL` (`resumeFrom:
   fix`); else `PASS`.
   Write `brief.json` (Setup, "Envelope"; as pi's `execute-wave.js`): `stage: "execute-wave"`;
   `status` = `blocked` (wave `BLOCKED`) | `failed` (no lane PASS) | `needs-decision` (any pending
   decision) | `done` (all PASS) | else `failed`; summary `N/M lanes PASS. Next: merge PASS lanes in
   step order, re-run their gates on the merged tree, then ledger-apply fromResult.`; actionables:
   one `fix` per non-PASS lane (`what`: "<step> <state> at <stage>: resume from <resumeFrom> (B.8)",
   `ref`: `result.json#board[<i>]`), its alternative as `info`, then each pending decision
   (`decision`); max 12.
7. **Integration** — for each `PASS` lane, in step order:
   1. Merge `lane/<key>` onto the working branch (`git merge --no-edit`; `-c core.editor=true` for
      any commit that would open an editor).
   2. Mechanical conflict (imports, ordering, independent additions at one anchor) → resolve it
      yourself only by keeping both sides verbatim in step order; any other edit → dispatch a
      `wf-worker` with both commits. Record either resolution via `ledger-apply` `decisions_taken`
      (`{"step":"<key>","commit":"<merge sha>","tick":false,…}`). Real logic conflict → do not
      auto-merge: abort, keep that lane's branch and worktree, and after 7.5 run its step through
      Procedure A with `baseCommit: <wave base>`, `reviewBase: <integrated HEAD>`, `sidecarSha`
      (from the board), `wtdir`, a fresh `stageDir` (`<wave stageDir>-lane-<key>-resume-fix`, or the
      coordinator's next numbered stage dir) and `resume: {from: fix, commit: <lane commit>,
      guidance: "in the main checkout <repo> on the working branch (not the lane worktree),
      cherry-pick this commit onto the current HEAD and resolve the conflict with <steps>"}`
      (resolving it is new code, so never `from: review`). Record the dependency the plan missed
      via `ledger-apply` `decisions_taken` with `commit: <integrated HEAD>`, tell the human.
   3. After all merges, confirm the main checkout is clean (Setup, "Clean tree", with `--wtdir
      <wtdir>`: kept lanes still exist), then re-run every merged step's gates on the integrated
      tree (gate): `gates.sh <stepFile> "$(git rev-parse HEAD)" <sidecarSha> <repo> --stage
      <stageDir> --wtdir <wtdir>`. Lanes passed in isolation; only the integrated run proves the
      wave. A failure here stops the wave: report it, do not apply ledgers.
   4. Apply the lane ledgers (gate): `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"; echo '{"planDir":"<planDir>","fromResult":"<stageDir>/result.json","steps":[<merged sidecar step ids>]}' | "$WFS/scripts/ledger-apply.sh"`.
   5. Clean up each merged lane (not one aborted in 7.2): `git worktree remove --force <lane
      path>`, then `git branch -D lane/<key>`.
8. **Non-PASS lanes** (a lane aborted in 7.2 follows 7.2 instead), one at a time in step order. With
   a commit: note `pre = git rev-parse HEAD`, merge the lane branch (a conflict → handle as 7.2),
   then run Procedure A with `baseCommit: <wave base>`, `reviewBase: <pre>`, `sidecarSha: <lane
   sidecarSha>`, `wtdir`, a fresh `stageDir` (as in 7.2, `-resume-<from>`) and `resume: {from:
   <resumeFrom>, commit: <git rev-parse HEAD after the merge>, workerAgentId, resultPath:
   <stageDir>/result.json}` (show the human the alternative too). The resume commit is the merge
   commit, never the bare lane commit: it is HEAD, so A4 needs no checkout, and it carries the
   integrated wave. A resume-fix `SendMessage` to the lane worker adds: "Work in the main checkout
   <repo> on the working branch, not the lane worktree." Without a commit, re-run the step through
   Procedure A from scratch, passing the lane's `sidecarSha`. Remove the lane's worktree and branch
   (as in 7.5) only once its step reaches PASS; the same holds for a lane aborted in 7.2.

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
(`stage: "done-check"`, Setup "Envelope"): `ok` → `done`; no step attempted in this run →
`blocked`; unchecked steps, ledger errors or red CI → `failed` (your work); only open ledger rows → `needs-decision` (the human discharges or waives); otherwise
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

- `blocked` (sidecar unusable, drifted from plan.json or edited after dispatch, gates.sh
  infrastructure error, HEAD not the step commit, gate by-products in the tree, plan dir at the
  repo root, no worktree dir, no worker for the tier, resume without a base or `sidecarSha`,
  ledger-apply failed, CI pending/none/stale, reviewer failed twice) → fix the artifact or wait for
  CI, then resume.
- `failed` at implement → environmental (missing tool, network, stale checkout) → fix it, make
  sure the working branch's HEAD is the commit (move the branch; never check out a bare sha),
  resume from `gates` (no worker spent); real work left → resume from `fix` with the
  human's guidance; wrong gate/step → amend step file + sidecar, re-run `validate-plan.sh`, re-run
  from scratch.
- `failed` at review/fix → fix rounds exhausted. **Stop and escalate** with the step file, the final
  REVIEW-VERDICT, and your diagnosis; resume from `fix` with the human's guidance.
- A worker FAIL with a commit has two resume points (`fix` primary, `gates` alternative; reversed
  when the worker claimed PASS and the gates rejected it). You do not pick: show the human both.
- Once a step has a commit, never re-run it from scratch to get past a later stop. Re-launch
  Procedure A with `resumePoint.args` unchanged (except `sidecarSha` when the human approved a new
  hash, A1), adding `resume.guidance` (the human's words, quoted) for `fix`. `workerAgentId` only works within the session that created it; after `/clear` the
  fresh-worker fallback applies.
- Agent launch failure or tool error → infrastructure blocker: report the exact error and repo
  state; do not switch execution mode or do the step yourself. Exception: `Concurrent subagent
  limit reached` → wait for a running child to finish, then relaunch (B.3).

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
