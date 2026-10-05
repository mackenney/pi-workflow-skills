---
name: step-contract
description: "Shared vocabulary for planner, synthesizer, structural/atomic workers, step reviewer, and fact-checker — gate classes, coverage matrix, Proxy Rule, First-Artifact Rule, hard-splits, tier→scope, the step-NN.gates.json sidecar schema, STEP-VERDICT/REVIEW-VERDICT, and the PROGRESS.md ledger row grammar. Knowledge only: no dispatch syntax, no tiers-to-models, no verdict-parsing prose."
disable-model-invocation: true
---

# step-contract

This is the one document every role in the pipeline reads with the same meaning: the planner who
authors gates, the synthesizer who validates a plan mechanically, the worker who runs gates, the
step reviewer who re-runs and audits them, the fact-checker who verifies gate commands are real,
and the terminal-gate script that parses the ledger. If your instructions elsewhere in a skill or
agent body conflict with this file on any of these definitions, this file wins.

## Gate classes

Six classes (RECOMMENDATIONS-v2 naming). `real: true|proxy` is an **attribute** on any gate, not a
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
`real: true` required — see First-Artifact Rule. `N/A: <reason>` is a valid verdict for a class
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
the ledger's "Tech debt / deferred gates" section until the real gate runs.

## First-Artifact Rule

**The first step in a plan that touches a build-artifact definition (Dockerfile, packaging
manifest, lockfile, bundle spec) must run a real, non-proxy build in that same step.** Not
deferred to the end. Grounding: three consecutive epochs verified Dockerfile changes with
`bake --print` only, and a 15-step plan's first real bake — run at step 15 — immediately
surfaced two P0 defects no earlier gate could see. `validate-plan.sh` rejects a plan whose first
artifact-touching step lacks a `real: true` G-build/G-e2e-smoke gate.

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

| Executor tier | Files touched | Distinct concerns | Net LOC (indicative) | Architectural decisions | Gate authoring |
|---|---|---|---|---|---|
| **fast** | 1–3 | 1, fully specified | ≤150 | None — every name, signature, and path is pre-decided in the step file | 100% mechanical gates: exact command + exact expected output. No gate requiring judgment. |
| **standard** | 3–8 | 1–2, closely related | ≤400 | None — may choose local implementation details, not interfaces/schemas/module boundaries | Mechanical gates; may add supplementary tests, may not weaken planner gates |
| **deep** | 8–40 | 2–4 within one subsystem | ≤2500 | Bounded — may restructure inside the subsystem it owns; may not change an externally consumed interface, schema, permission, ownership, mode, or visibility path unless the step says so | May author additional gates; must run every planner gate verbatim; must declare any proxy used |
| **frontier** | 40+ | a whole subsystem/epoch | 2500+ | Same bound as deep, plus may *propose* (never enact) cross-subsystem changes as an Open Decision | Same as deep, plus responsible for flagging a missing gate class or coverage row back to the planner |

## The `step-NN.gates.json` sidecar

One sidecar per step file, same basename with `.gates.json`. The runtime executes this
mechanically (`acceptance.verify[]`); the markdown step file is what humans read. `validate-plan.sh`
cross-checks the two do not disagree.

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
    { "id": "g-build-2", "class": "build", "result": "n/a", "reason": "no artifact definition touched" }
  ],
  "coverage": [
    { "row": "loader version >= 2 (non-default)", "gate": "g-unit-1" }
  ],
  "hard_splits_declared": []
}
```

Every `gates[]` entry with a `cmd` and no explicit `"result": "n/a"` becomes an
`acceptance.verify[]` item the runtime executes; the worker's own claims are evidence, not
verdict. `timeoutMs` defaults to 120000 (the runtime's own default) but real builds must set it
explicitly higher.

## STEP-VERDICT (worker `outputSchema`)

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

Any gate with `result: "proxy"` must have a matching `proxies_used` entry. Any `deferred` entry
becomes an `open` row in the ledger's "Tech debt / deferred gates" section. If no
`structured_output` tool is present, end with a `STEP-VERDICT:` line followed by this object as a
fenced ` ```gate-report ` block, as the last content of the message — never mid-message, never
truncatable from the front.

## REVIEW-VERDICT (step reviewer `outputSchema`)

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

## PROGRESS.md ledger — sections and row grammar

The plan directory's ledger file (`PROGRESS.md` by default) is authoritative — not mission
`state`. Sections, in this order:

```markdown
## Executor Tier
<fast | standard | deep | frontier>

## Decisions taken
- <one line, with commit or step reference>

## Pending decisions (human)
- <one line — unresolved after a second fresh fact-check/review round, or a worker escalation>

## Tech debt / deferred gates
| Gate | Class | Owed by | Reason deferred | Status |
|------|-------|---------|-----------------|--------|
| full mcp-tools suite (405 tests) | G-regress→G-integ | step-15 | 10–25 min per step; scoped per-step instead | open |

## Disabled/softened checks
| Check | Where | Why | Status |
|-------|-------|-----|--------|
| CI job X | .github/workflows/x.yml | flaky on shared runner | open |
```

The `## Steps` section is a `- [ ]`/`- [x]` checklist, one item per step; the parent ticks a step after applying its ledger. The terminal gate fails while any item is unchecked, or when the section is missing or empty.

Every data row is a real item. An empty table (header + separator only) means nothing recorded; never write placeholder rows such as `| (none) | | |` — they have no valid Status and fail the terminal gate.

**Status grammar** (exactly one of):
- `open` — the plan is **not** complete while any row reads `open`.
- `discharged <commit>` — the real gate ran, or the disabled check was re-enabled, at that commit.
- `waived by <human name> <YYYY-MM-DD>: <reason>` — a human wrote this row, or explicitly
  instructed the parent to write it verbatim, quoting them. No model classifies significance and
  no model waives its own or another agent's deferred gate.

The parent session writes every row from each workflow script's returned `ledger` object before
dispatching the next step; it does not delegate ledger writes to a child. Mission `state.ledger.<step>`
is an optional, best-effort mirror — never read as authority by `terminal-gate.sh` or anything else.
