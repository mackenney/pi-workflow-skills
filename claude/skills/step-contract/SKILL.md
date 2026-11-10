---
name: step-contract
description: "Shared vocabulary for planners, workers, reviewers and fact-checkers: gate classes, coverage matrix, Proxy and First-Artifact Rules, hard splits, tier→scope, the gates.json sidecar, STEP-VERDICT/REVIEW-VERDICT blocks and ledger row grammar. Knowledge only, preloaded by the wf-* agents."
user-invocable: false
---

# step-contract

This is the one document every role in the pipeline reads with the same meaning: the planner who
authors gates, the synthesizer who validates a plan, the worker who runs gates, the step reviewer
who re-runs and audits them, the fact-checker who verifies gate commands are real, the main
session that orchestrates them, and the terminal-gate script that parses the ledger. If your
instructions elsewhere in a skill or agent body conflict with this file on any of these
definitions, this file wins.

## Gate classes

Six classes (RECOMMENDATIONS-v2 naming). `proxy: true` (absent/false = a real, non-proxy gate) is an **attribute** on any gate, not a
separate class — a G-build or G-e2e-smoke gate can be `proxy` only when explicitly declared, with
the real gate named and owed (see Proxy Rule).

| Class | Question | Typical command | Cost |
|---|---|---|---|
| **G-build** | Does it compile, import, boot without error? | `cargo build`, `python -c "import pkg"`, `tsc --noEmit`, container `--help` | seconds |
| **G-static** | Lint, typecheck, format, no dead/unused imports from this diff | `ruff check`, `mypy`, `eslint`, `cargo clippy` | seconds |
| **G-unit** (direct test) | Does the new/changed unit have a test that fails without the change? | scoped `pytest path::test`, `cargo nextest run -E 'test(x)'` | seconds–minutes |
| **G-e2e-smoke** | Does the new behavior actually happen, end-to-end at the smallest viable scale? | `curl` the new endpoint; run the CLI; boot the profile and `tools/list`; apply+rollback the migration | minutes |
| **G-regress** | Does the surrounding scope still work? | scoped suite for the touched package; full suite at integration | minutes–30+ |
| **G-integ** | Full suite, cross-subsystem invariants, cold bake, measurements — always at plan/integration level, never skippable to a step | full suite; cold bake; boot every profile | 30+ min |

A build-artifact gate (image, binary, wheel, bundle) is a `G-build` or `G-e2e-smoke` gate with
a non-proxy gate (`proxy` absent/false) required — see First-Artifact Rule. `N/A: <reason>` is a valid verdict for a class
that does not apply to a step; an *omitted* class is a planning defect, not a valid absence.

## Coverage matrix (primary — this is what actually catches configuration escapes)

Gate-class coverage alone does not catch defects that live in **non-default configuration or
selector paths** (evidence: two P0 defects survived 15 steps, 33 BDD scenarios, 400+ unit tests
and 4 review rounds because every gate ran against the same baked-in default profile — see
`retro-orchestration-analysis.md` §2.2, revised). Every step declares a coverage matrix: one row
per profile, selector, flag, or non-default code path the step affects, each row naming the gate
id that exercises it. A row with no gate is a `FAIL` at review. An empty matrix on a step that
touches configuration/selection logic is a planning defect.

```json
"coverage": [
  { "row": "profile=full_v1 (default)", "gate": "g-e2e-smoke-1" },
  { "row": "profile=minimal (non-default)", "gate": "g-e2e-smoke-2" },
  { "row": "child-spawn path with STANDARD_TOOLS_ENABLED=0", "gate": "g-e2e-smoke-3" }
]
```

## Proxy Rule (non-negotiable)

A gate that observes a *description* of the artifact is not a gate on the artifact.

| Proxy (not sufficient) | Real gate |
|---|---|
| `docker buildx bake --print` | `docker buildx bake` then `docker run` and probe inside |
| `terraform plan` | `terraform apply` in a scratch workspace |
| reading a migration file | applying it, then rolling it back |
| `--dry-run` of anything | the non-dry run |
| grepping for a symbol | importing/calling it |

A proxy is permitted only when the sidecar marks that gate `"proxy": true` with a `real_gate`
field naming the real command and the step that owes it. An undeclared proxy is a review `FAIL`
regardless of whether the step otherwise passes. Every declared proxy becomes an `open` row in
the ledger's "Tech debt / deferred gates" section until the real gate has run.

## First-Artifact Rule

**The first step in a plan that touches a build-artifact definition (Dockerfile, packaging
manifest, lockfile, bundle spec) must run a real, non-proxy build in that same step.** Not
deferred to the end. Grounding: three consecutive epochs verified Dockerfile changes with
`bake --print` only, and a 15-step plan's first real bake — run at step 15 — immediately
surfaced two P0 defects no earlier gate could see. `validate-plan.sh` rejects a plan whose first
artifact-touching step lacks a non-proxy (`proxy` absent/false) G-build/G-e2e-smoke gate.

## Hard splits — atomic at every tier, regardless of executor strength

A step must not do more than one of these; each gets its own step:

1. Implement X **and** redesign the data model / change a schema / change a persisted format.
2. Refactor **and** change behavior in the same diff.
3. Change a security/permissions boundary **and** anything else.
4. Add a capability **and** change who can see or select it (visibility/registration).
5. Anything whose rollback is not a clean `git revert` (migrations, external API calls,
   production-data touches) is atomic by definition.
6. Cross-repo / cross-submodule changes split at the repo boundary, always.

A step that combines two of these is a planning defect; the worker escalates rather than
silently splitting or silently merging.

## Tier → scope (planner sizing input; the executor tier is a planning input, not a planner output)

Claude Code has worker agents for the **standard** (`wf-worker`) and **deep** (`wf-structural-worker`) tiers only. `validate-plan.sh` still accepts `fast` (pi has a fast lane), but the `executor` skill blocks a `fast` step in Claude Code: plan for standard or deep. Size frontier-scale work as deep steps (or split it) until a frontier worker exists.

| Executor tier | Files touched | Distinct concerns | Net LOC (indicative) | Architectural decisions | Gate authoring |
|---|---|---|---|---|---|
| **fast** | 1–3 | 1, fully specified | ≤150 | None — every name, signature, and path is pre-decided in the step file | 100% mechanical gates: exact command + exact expected output. No gate requiring judgment. |
| **standard** | 3–8 | 1–2, closely related | ≤400 | None — may choose local implementation details, not interfaces/schemas/module boundaries | Mechanical gates; may add supplementary tests, may not weaken planner gates |
| **deep** | 8–40 | 2–4 within one subsystem | ≤2500 | Bounded — may restructure inside the subsystem it owns; may not change an externally consumed interface, schema, permission, ownership, mode, or visibility path unless the step says so | May author additional gates; must run every planner gate verbatim; must declare any proxy used |
| **frontier** | 40+ | a whole subsystem/epoch | 2500+ | Same bound as deep, plus may *propose* (never enact) cross-subsystem changes as an Open Decision | Same as deep, plus responsible for flagging a missing gate class or coverage row back to the planner |

## The `step-NN.gates.json` sidecar

One sidecar per step file, same basename with `.gates.json`. The orchestrating session runs it
mechanically (`claude/scripts/gates.sh` on the worker's commit, see the `executor` skill); the
markdown step file is what humans read. `validate-plan.sh` cross-checks the two do not disagree.

```json
{
  "step": "step-07-loader-versioning",
  "tier": "deep",
  "base_commit": "abc1234",
  "gates": [
    { "id": "g-build-1", "class": "build", "cmd": "uv run python -c 'import mcp_compose'", "timeoutMs": 60000 },
    { "id": "g-static-1", "class": "static", "cmd": "ruff check packages/mcp_compose", "timeoutMs": 60000 },
    { "id": "g-unit-1", "class": "unit", "cmd": "uv run pytest packages/mcp_compose/tests/test_loader.py::test_rejects_unknown_version -q", "timeoutMs": 120000 },
    { "id": "g-e2e-smoke-1", "class": "e2e-smoke", "cmd": "uv run gym-capabilities validate samples/descriptor.json", "timeoutMs": 60000 },
    { "id": "g-regress-1", "class": "regress", "cmd": "uv run pytest packages/mcp_compose -q", "timeoutMs": 300000 },
    { "id": "g-build-2", "class": "build", "result": "n/a", "reason": "no artifact definition touched" },
    { "id": "g-integ-1", "class": "integ", "result": "n/a", "reason": "integration step owns it" }
  ],
  "coverage": [
    { "row": "loader version >= 2 (non-default)", "gate": "g-unit-1" }
  ],
  "hard_splits_declared": []
}
```

A sidecar may pre-set only `"result": "n/a"` (with `reason`) or `"result": "deferred"` (with `owed_by`, the step that runs the real gate, plus an `open` row in "Tech debt / deferred gates" naming the gate id). Workers and reviewers never edit the step file, the sidecar, plan.json or PROGRESS.md: a gate that cannot pass with a correct implementation is reported (FAIL + `pending_decisions`), not rewritten. Every other `gates[]` entry with a `cmd` is run by the orchestrator on the worker's commit and again by the reviewer; the worker's own claims are evidence, not verdict. `timeoutMs` defaults to 900000 when omitted; real builds must set it explicitly higher.

Each `cmd` runs as `bash -c "<cmd>"` with cwd = repo root, no TTY, stdout and stderr captured; exit 0
= pass. Avoid `rm` in `cmd`: subagent safety checks can deny a `bash -c` script containing `rm`, even
under `bypassPermissions`. Gate outputs and by-products (caches, coverage files, build dirs) must be
gitignored: the executor's clean-tree check treats any untracked non-ignored file as dirty, and
ignored files are never checked.

## STEP-VERDICT (worker final block)

The last content of a worker's reply is a `STEP-VERDICT:` line followed by this object in a fenced
` ```gate-report ` block — never mid-message, never truncatable from the front, nothing after it.
The orchestrator extracts it verbatim, saves it as JSON and checks it with
`claude/scripts/check-block.sh`; a missing or invalid block (including a PASS with a failed gate) is
a failed worker.

```json
{
  "verdict": "PASS | FAIL | BLOCKED",
  "step": "step-07-loader-versioning",
  "commit": "abc1234",
  "gates": [ { "id": "g-build-1", "class": "build", "cmd": "...", "result": "pass|fail|proxy|deferred|n/a", "note": "..." } ],
  "coverage": [ { "row": "...", "gate": "g-unit-1" } ],
  "proxies_used": [ { "gate": "g-build-2", "proxy_cmd": "...", "real_gate": "..." } ],
  "deferred": [ { "gate": "g-integ-1", "owed_by": "step-15", "reason": "..." } ],
  "decisions_taken": ["..."],
  "pending_decisions": ["..."],
  "residual_risks": ["..."]
}
```

Nine keys are required: all of the above except `commit`, which may be omitted or empty only on
FAIL/BLOCKED. `gates[].cmd` and `gates[].note` are optional (the orchestrator runs the sidecar's
commands, not the reported ones). `verdict` is one of `PASS`, `FAIL`, `BLOCKED`. `gates[].class` is one of
`build`, `static`, `unit`, `integ`, `e2e-smoke`, `regress`; `gates[].result` one of `pass`, `fail`,
`proxy`, `deferred`, `n/a`. `commit` is a 7–40 char lowercase hex sha, or empty only on
FAIL/BLOCKED; the orchestrator turns a PASS without a commit into FAIL. Any gate with
`result: "proxy"` must have a matching `proxies_used` entry. Any `deferred` entry becomes an `open`
row in the ledger's "Tech debt / deferred gates" section.

## REVIEW-VERDICT (step reviewer final block)

Same placement rule: a `REVIEW-VERDICT:` line followed by a fenced ` ```gate-report ` block, last.

```json
{
  "verdict": "PASS | FAIL",
  "step": "step-07-loader-versioning",
  "commit": "abc1234",
  "gates": [ /* same shape as STEP-VERDICT.gates, reviewer's own re-run results */ ],
  "findings": [ { "severity": "P0|P1|P2", "class": "...", "location": "path:line", "evidence": "command + output", "smallest_fix": "..." } ],
  "ledger_gaps": ["..."]
}
```

## NEEDS-DECISION (any agent)

An agent that hits a product, architecture or scope decision its task did not approve stops and
ends its reply with a `NEEDS-DECISION:` line followed by a fenced block: the decision, the options,
its recommendation, and the commit holding any work so far. It does not guess and does not end with
a bare question. The orchestrator asks the human and resumes the agent (`SendMessage`; if it is not in the tool list, load it
with ToolSearch (`select:SendMessage`)) or re-dispatches it with the answer.

## Resuming a stopped step

A step that stopped after its commit exists is resumed, not re-implemented (`executor` skill,
"Resume"). The orchestrator first proves `commit` exists and descends from the run's `baseCommit`
(or the sidecar's `base_commit`) with `scripts/commit-check.sh`; with neither, or a failed check, the
step is `blocked`. `from`: `gates` (re-run the sidecar gates on `commit`, which must be HEAD of the
working branch: the orchestrator moves the branch there and never checks out a bare sha, then review), `review` (review `commit`), `fix` (continue the worker with the human's guidance — resumed with `SendMessage` if it
is still in this session, else a fresh worker from `commit` — then review), `ci` (CI read bound to
`commit`, then ledger), `ledger` (apply the ledger from the prior `result.json` only). Every
non-PASS step result records `resumePoint: {from, commit, workerAgentId, args}` in its `result.json`,
with the resolved base in `args.baseCommit` and the sidecar hash recorded at first dispatch in
`args.sidecarSha`; a resume without it, or with a sidecar whose hash differs, is blocked.

## PROGRESS.md ledger — sections and row grammar

The plan directory's ledger file (`PROGRESS.md` by default) is authoritative — not mission
`state`. Sections, in this order:

```markdown
## Executor Tier
<fast | standard | deep>   (steps are sized <= deep)

## Decisions taken
- <one line, with commit or step reference>

## Pending decisions (human)
- <one line — a disputed fact-check claim, or a worker escalation>

## Tech debt / deferred gates
| Gate | Class | Owed by | Reason deferred | Status |
|------|-------|---------|-----------------|--------|
| full mcp-tools suite (405 tests) | G-regress→G-integ | step-15 | 10–25 min per step; scoped per-step instead | open |

## Disabled/softened checks
| Check | Where | Why | Status |
|-------|-------|-----|--------|
| CI job X | .github/workflows/x.yml | flaky on shared runner | open |
```

The `## Steps` section is a `- [ ]`/`- [x]` checklist, one item per step; `ledger-apply` ticks it (with the commit) when the step passes. The terminal gate fails while any item is unchecked, or when the section is missing or empty.

Inside the two debt sections every non-blank line must be part of the table (an HTML comment is allowed); prose or list items there fail the terminal gate, because they could hide an open item. Inside `## Steps` every list item must be a checkbox. Every data row is a real item. An empty table (header + separator only) means nothing recorded; never write placeholder rows such as `| (none) | | |` — they have no valid Status and fail the terminal gate.

**Status grammar** (exactly one of):
- `open` — the plan is **not** complete while any row reads `open`.
- `discharged <commit>` — the real gate ran, or the disabled check was re-enabled, at that commit.
- `waived by <human name> <YYYY-MM-DD>: <reason>` — a human wrote this row, or explicitly
  instructed the parent to write it verbatim, quoting them. No model classifies significance and
  no model waives its own or another agent's deferred gate.

Rows are written by `scripts/ledger-apply.sh` from each step's extracted verdict (piped in by the
orchestrator after the review passes, and after merge + re-gate for wave lanes); no model edits
ledger rows, apart from human-dictated waivers/discharges.
