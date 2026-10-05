# Retrospective: Step Sizing and Success Gates in the pi-workflow-skills Pipeline

**Status:** PROPOSAL FOR REVIEW — nothing in this document has been applied to any SKILL.md.
Section 6 contains draft markdown intended to be pasted into `skills/planner/SKILL.md` and
`skills/executor/SKILL.md` after the user reviews and edits it.

**Date of review:** retrospective over ~4 weeks of real usage (2026-08-05 → 2026-09-23).

**Evidence base (read in full):**
- Skills: `planner`, `executor`, `specifier`, `investigator`, `fact-checker`, `code-reviewer`, `coordinator`
- Scout reports: `/tmp/pi_analysis/A-capability-registration.md`, `B-stem-inverse.md`, `C-coregym-misc.md`, `D-carbondash-and-misc.md`
- **Not read:** `/tmp/pi_analysis/E-bundle-studio-and-more.md` — did not exist on disk at the time of this review. Any bundle-studio-specific evidence is therefore absent from this analysis. Conclusions below should be re-checked against E when it lands.

---

## 0. The question, restated precisely

Two questions are entangled in the user's prompt and they need to be separated, because they
have different answers:

1. **Is atomic step sizing now too conservative, given stronger models?**
   Answer: *yes, but only as a default* — and the harm it causes is not primarily "slowness."
   The harm is **unshippability** (commit tangles, handoff churn) and **false confidence**.

2. **Would bigger chunks have prevented the defects that escaped?**
   Answer: **no.** The evidence is unambiguous that chunk size and defect escape are largely
   independent axes. Capability-registration escaped 2 P0s through a 15-step atomic plan with
   4 review rounds; stem-inverse Phase B (6 large epochs, opus-5) shipped with "no image ever
   built" and needed one full epoch rework. Different sizes, same class of escape.

So the correct framing is: **relax step sizing along the model-tier axis, and independently
fix the gate contract along the verification axis.** Doing only the first makes things worse.

---

## 1. What's working

Each point below is tied to specific evidence. Points not supported by the material are omitted
deliberately.

### 1.1 Coordinator mode with epoch-sized briefs on a deep-tier worker is dramatically faster and produces shippable history

**Evidence (B):** The same feature set was built twice. Phase A (atomic `step-01..step-10`,
waves 0–5, sonnet-5 workers) ran 2026-08-17 → ~08-26, ~9–10 days, 57 session files, ~10
`HANDOFF-*.md` documents forced by repeated context exhaustion, and produced PR #64: **99
commits stacked on another in-flight 61-commit PR**, described by the user as needing a
scout-driven "classification of the features/changes by topic" before it could even be reasoned
about. Phase B (coordinator mode, 6 whole-subsystem epochs T0–T4b, one `claude-opus-5` worker
per epoch, human review gate between epochs) redid the bulk of it in **≈6.3 hours wall clock,
~41 commits, ~205 files, ~19.7k insertions**, landing 6 clean topic-scoped branches.

The decisive win is not raw speed — it is that **epoch boundaries == topic boundaries == branch
boundaries**, so the output is reviewable and shippable by construction. Atomic steps executed
across many sessions produced commit history whose topology did not match any human's mental
model of the change.

### 1.2 Direct per-unit dispatch to a deep-tier worker, with no plan artifact at all, works well for bounded parallel maintenance

**Evidence (C, B2):** GYM-891 — 10 stacked PRs (#67–#76), each rebased onto a moving base,
each defect-fixed (real fixes: TOCTOU in #70/#71, truncation-flag false positive in #73, DRY
`guard_offset_limit` + test brittleness in #74, missing `SANDBOX_ROOT` monkeypatch in #76) and
each reviewer-comment-answered — **one `claude-opus-5` worker per PR, no planner, no
PROGRESS.md, no step files**. Completed same day, ~5 hours across 3 session files, "all 10 PRs
rebased/pushed and green." One recovery event (a worker run failed and was resumed from its
persisted child session).

The planner's own "When to Plan vs. Implement Directly" section would have *mandated* a plan
here (multiple repos/services-adjacent, parallel agents, 3+ behavior-changing steps). The plan
would have added nothing. This is direct evidence the planning threshold is miscalibrated.

### 1.3 Fact-checking the *plan* before execution catches real, expensive errors

**Evidence (A):** The post-planning fact-check on capability-registration checked 51 claims
→ 32 CONFIRMED / 8 REFUTED / 10 PARTIAL / 1 UNVERIFIABLE, driving 11 mechanical corrections
(stale tool counts 96→101, wrong file references, an **invented "mandatory-checks config"** that
did not exist, an incomplete call-site inventory 7→11 rows) and 4 escalations — including a
**naming collision** where the plan's `legal_v2` profile collided with a name reserved by the
just-merged PR #78. That collision would have caused a mid-execution rework.

**Evidence (C, A2):** `results-match-revert`'s own `FACTCHECK.md` (26 claims, 23 CONFIRMED /
3 PARTIAL / 0 REFUTED) tightened a step instruction because a test used
`pytest.raises(..., match=...)` against a string the step would have changed.

Plan fact-check is high ROI and should be preserved regardless of chunk size. It gets *more*
valuable with bigger chunks, not less, because a wrong premise in a large step is more expensive.

### 1.4 Competitive review + fact-check of the review keeps review honest

**Evidence (A):** Round 1 of cross-cutting review produced 1 P0 / 2 P1 / 7 P2 → fact-check:
16 CONFIRMED / 2 REFUTED / 5 PARTIAL. Round 2: **26 CONFIRMED, 0 REFUTED — "no finding
hallucinated."** The reviewer→fact-checker chain demonstrably suppresses false-positive review
noise and, critically, produced an auditable rate for it.

**Evidence (C, B3):** The `danilo`/`joao`/`jose` worktrees show the user has internalized this
as a standing idiom for reviewing colleagues' PRs: *"dispatch a frontier code-reviewer for this
PR, once done a fact-checker for it."* Three separate worktrees, same verbatim instruction.

### 1.5 Escalation behavior is working — workers correctly refuse to invent

**Evidence (A):** A merge-worker dispatched onto an empty diff "correctly refused to fabricate
results and escalated." In step-09, a worker hit a genuine validator-ownership conflict between
PR #78's `validate-bundled` and the new `gym-capabilities check-invariant` and **refused to pick
a resolution**, escalating to the coordinator, which ruled. The "escalate rather than guess"
contract in executor/SKILL.md is being followed and is load-bearing.

### 1.6 Self-imposed independent verification by the orchestrator catches worker self-report gaps

**Evidence (B):** In coordinator mode, after every epoch the coordinator **re-ran the test
suites itself** rather than trusting the worker's report — explicitly noting on T0 "the worker
never reported any — gap on its side," and independently verifying and writing T0's report when
the worker process died mid-write after 8 retries. This is the single behavior that kept epoch
mode honest, and it is currently **not written down anywhere in the skills**. It's an emergent
practice, not a contract.

### 1.7 A gate that exists mechanically will fire, even months later

**Evidence (A):** After the branch was rebased twice onto a moving `origin/main`, newly-merged
sibling PRs added PDF tools that caused descriptor drift — and **the plan's own
`check_core_tools_provides_drift.py` gate self-detected it** and it was fixed cleanly. The
one automated, repo-resident gate the plan authored paid for itself long after the plan was
"done." This is the strongest argument in the whole evidence base for the gate-contract
redesign in §4.

---

## 2. What's failing — symptoms, and the root cause under each

### 2.1 Over-atomization produces unshippable commit tangles

**Symptom:** stem-inverse Phase A → PR #64 with **99 commits**, stacked on PR #44's 61 commits,
"mixing scope (oracle + grading + slimming + bundle format all interleaved)," with dead branches
inside it, such that a literal cherry-pick/rebase was not viable and a scout pass was needed just
to classify the commits by topic.

**Root cause — the plan's decomposition axis is *executability*, not *reviewability*.** The
current planner decomposes by "what can one worker safely do in one shot," and the wave map
optimizes for parallelism. Neither of those axes is the axis a human reviewer or a PR uses. When
you decompose by executability and then commit 1:1 per step across many sessions, the resulting
history is a projection of the *agent scheduling graph* onto git, not a projection of the change's
logical structure. Nothing in planner/SKILL.md ever asks "what will the PR look like?"

**Secondary root cause — no context-budget model.** ~10 `HANDOFF-*.md` documents in Phase A exist
purely because contexts kept running out mid-plan. Handoff authoring is pure overhead that scales
with step count, and the planner is unaware it exists.

### 2.2 Fine-grained plans do not prevent defect escape

**Symptom:** capability-registration — **2 P0 defects survived 15 steps, 33 BDD scenarios, 400+
unit tests, per-step reviewer gates on all 15 steps, and 4 competitive review rounds.** They were
caught only at step-15's live bake:
- P0 #1: an M1 layer-collapse pass merged Docker `RUN`s and left `/opt/gym/exposer` at `0755`
  instead of `0700` — a registry-opacity regression, caught only by the G4 `check_image` gate
  against a **live-baked image**.
- P0 #2: the platform-tools filter hid gym lifecycle tools (`setup_problem`/`grade_problem`) —
  i.e. it broke the gym's core loop — found only via **live image probing**.
- Plus a fail-open selector bypass and a flag×`STANDARD_TOOLS_ENABLED` boot-death interaction.

The coordinator's own tally: *"15 plan steps, 4 competitive review rounds, ~60 verified claims
with 0 REFUTED across the two final fact-checks, and 13 defects fixed — **6 of which no static
gate could have found.**"* Final `/gym-review` verdict: **REQUEST CHANGES**, never APPROVE. **No
PR was ever opened.**

**Root cause (revised — see correction below) — every gate in the plan ran only against the
default configuration/selector path.** 15 steps × N acceptance criteria, but the plan never
authored a gate that exercised a *non-default* profile, selector, or code path: the coordinator's
own root-cause statement is *"Both P0s live in non-default selectors: the profile filter and
child-spawn paths were only ever driven with the baked-in `full_v1`… 'Green' meant 'green on the
paths we happened to exercise.'"* The plan also had **no gate class for "the artifact runs"**
until step-15, i.e. until the very end — by design, because live bakes are slow — which is a
separate, compounding gap (missing G5, not just missing configuration coverage).

This is the deepest finding in the retro: *gate quantity was mistaken for gate coverage.* The
planner template has no notion of gate *class* or of *configuration/selector coverage*, so it
cannot notice that an entire class, or an entire non-default path, is missing.

**Correction (this section originally framed the root cause as "every gate was in the same
epistemic class" — i.e. a gate-*class*-diversity failure). That framing does not hold up:**
capability-registration's plan **did** span multiple gate classes (step-04 ran two real Docker
bakes, step-13 added a `check_image` image gate, step-12 ran 33 pytest-bdd scenarios, step-15 ran
a cold bake + 405-test regression), yet both P0s still escaped. Class diversity alone would not
have caught either one; what would have is a gate taxonomy that forces **configuration/selector
coverage** — booting every profile, exercising every non-default selector — as its own dimension,
independent of gate class. §4's gate-class table and §6's coverage-matrix requirement (per-row
profile/selector/flag coverage, not just per-class coverage) are written to close this specific
gap, not the class-diversity gap this section previously emphasized.

### 2.3 Verification theater: `--print`-only checks standing in for real builds

**Symptom (B):** Across coordinator-mode epochs T1 (image slimming) and T4/T4b (oracle layer,
Dockerfile), **every image claim was `docker buildx bake --print`-verified or shell-logic-verified
only — never an actual `docker build`.** The coordinator itself flagged this as the single
riskiest carried risk: *"The gap between 'tests pass' and 'image works' is now three epochs
wide... If something's wrong in the slim recipe, the cost of finding out compounds with every
epoch that lands on top."*

**Symptom (A):** The `/gym-review` blocking item was precisely a **missing gate**, not a code
defect: build a per-profile boot gate (boot every bundled profile + env-selector rank to first
`tools/list` on both taiga and sentinel), because **4 of 5 live-confirmed defects were
runtime-selection boot failures invisible to every existing gate.** The reviewer's verdict:
*"This is mergeable code. What is not mergeable is the gate posture."*

**Root cause — the skills permit a *proxy* for a gate to satisfy the gate, and nothing names
the substitution.** `docker buildx bake --print` validates that the *plan to build* is
well-formed. It cannot observe the filesystem mode bits of a built layer. Nothing in the planner
or executor skill distinguishes "gate that observes the real artifact" from "gate that observes a
description of the artifact," so a worker under time pressure (or an LLM optimizing for a green
checkmark) will substitute the cheap one and truthfully report the criterion as met. **The gate
text was satisfied; the gate's intent was not.** This is not dishonesty — it is an underspecified
contract.

**Corollary root cause — cost asymmetry is unmanaged.** Real bakes cost ~10 min incremental /
~26 min cold (A). Nothing in the pipeline says who pays that cost or when, so it drifts to the
end, where it is *maximally* expensive to act on (three epochs of stacked work in B; the final
integration step in A).

### 2.4 Gates get quietly narrowed or disabled to make the pipeline go faster

**Symptom (A):** step-06's gate initially ran the entire 405-test `mcp-tools` suite (10–25 min).
After the user asked *"any reason why this is going so slow?"*, it was **narrowed to the ~11-file
`profiles/tests` subset and the full suite deferred to step-15 only.** Reported result: "roughly
3× faster per step." Also: a 30-minute subagent timeout guillotined two workers mid-bake before
being raised to 60 min.

**Symptom (A):** CI path filters were themselves a plan step (step-14), and "CI path-filter gap"
appears in the final non-blocking follow-up list — i.e. the plan built its own CI narrowing and
then shipped with a known hole in it. Note also that **no CI ever ran on a PR** for this
workstream: every "CI" gate (`check_quality_gates.py`, `check_image`, path filters) was run
manually/locally. There was no independent enforcement surface at all.

**Root cause — scope-narrowing a gate is invisible and irreversible in the current design.** The
narrowing decision was *correct* for velocity, and the deferral to step-15 was *explicitly
chosen*. But there is no artifact that records "the full suite is now owed at step-15," no
mechanism that fails if that debt is never paid, and no distinction in the template between "this
gate runs per-step" and "this gate runs once at integration." A deferral and a deletion look
identical in a step file. In stem-inverse B, T5/T6/T7 (bundle checks, sample ports, profile env)
were deferred in exactly this way and, per the evidence available, **never dispatched.**

### 2.5 The executor's own pass/fail detection is string-matching and has produced false failures

**Symptom (A):** Two separate "chain stopped" incidents where the executor's gate logic
string-matched for a literal `VERDICT: PASS` in a *truncated* summary and **treated a passing
review as a failure**, requiring the coordinator to fix its own gate logic mid-run.

**Root cause — the verdict channel is prose.** Both the reviewer contract ("Report: PASS ... or
FAIL: ...") and the worker contract ("Step NN complete ✅" / "Step NN FAILED:") are free-text
conventions embedded in a summary that can be truncated. There is no structured, position-
independent, truncation-resistant verdict token.

### 2.6 Acceptance criteria are authored per-step in an ad-hoc way, with no floor

**Symptom (A):** Step-file sizes ranged 74–180 lines with acceptance criteria quality tracking
step size. The three multi-concern steps (04 at 180 lines / 4 Dockerfiles + descriptor + entrypoints;
08 bundling profile resolution + filter middleware + flags + boot invariant; 10 with an 11-row
call-site inventory) "required the most Reviewer/Fixer back-and-forth."

**Root cause — the planner template offers a *format* for acceptance criteria but no *checklist
of classes* and no *minimum*.** The current guidance is one strong sentence — *"`ruff check src/`
exits 0" is an acceptance criterion, "code is clean" is not"* — which is correct but only
constrains *form*. A planner can write four perfectly-formed static criteria and be fully
compliant with the skill while leaving "does it boot" unasked. There is no "every step must have
at least one gate of class X" rule anywhere.

### 2.7 Granularity is calibrated to the executor tier, but the calibration is implicit and stale

**Symptom (B, §3):** The installed defaults are `worker → claude-sonnet-5`,
`reviewer → claude-sonnet-5`, `scout → claude-haiku-4-5`. Coordinator mode's entire mechanism
was *"same `worker` subagent type, tier bumped from the pipeline's normal sonnet-5 to opus-5, and
dispatched with whole-subsystem-sized briefs instead of single-acceptance-criterion briefs."*

**Root cause — the Model Guide in planner/SKILL.md assigns tiers to *planning roles* (planners:
deep; unifier: frontier; simple mode: frontier) and says nothing at all about the executor tier
or its relationship to step size.** The skill therefore mandates expensive reasoning to produce
a decomposition sized for a cheaper executor that the skill never names. The step size is a free
variable determined by an unstated assumption. When the user overrides the executor to opus-5,
the plan does not change shape, so the stronger model is spent re-reading 6 files of context to
make a 40-line edit.

**This is the actual answer to "are the defaults too conservative":** the defaults are not
*wrong*, they are *unparameterized*. There is one step size for all executor tiers.

### 2.8 Wave-map parallelism is planned optimistically and then abandoned

**Symptom (A):** `step-02∥step-03` and `step-07∥step-08` were planned as parallel, but the
fact-check (P4 finding) caught that each pair writes overlapping files
(`packages/mcp_compose/pyproject.toml`, shared test dirs) — so all 15 steps were executed
**essentially sequentially**. Worktree isolation was additionally rejected twice ("requires a
clean git working tree") over an untracked `.pi` symlink.

**Root cause — the wave map is authored from the step *descriptions*, not from a declared
file-ownership set.** The planner is asked to produce a Dependency Table with a `File(s)` column
but is never required to make it exhaustive or to derive the wave map mechanically from it.
So parallelism is asserted, then disproven downstream. The cost of the fiction is a full plan
re-read plus executor override logic.

---

## 3. Model-tier → chunk-size calibration

### 3.1 Why stronger models absorb more scope per step

Three mechanisms, all visible in the evidence:

1. **Cross-file coherence.** A step touching 40 files requires holding an invariant across all of
   them. T4 (oracle: 8 commits, 72 files, +9452) landed coherently on opus-5; the same scope on
   sonnet-5 in Phase A was spread across step-04/05/06 and still required handoff documents.
2. **Judgment under ambiguity without escalation thrash.** Bigger steps contain more unstated
   micro-decisions. Weaker models either guess (silent defect) or escalate (coordination cost).
   Evidence from A: the three multi-concern steps (04, 08, 10) on sonnet-5 were exactly the ones
   with the most reviewer/fixer back-and-forth.
3. **Self-verification depth.** A stronger model is more likely to notice its own gate is a proxy.
   Though note the limit: opus-5 in B *did not* notice `--print` was insufficient for three
   consecutive epochs. **Model strength raises the ceiling on scope; it does not substitute for a
   named gate.**

And the counter-evidence bounding the claim: T2 (grading engine) on opus-5 landed, then needed a
**full rewrite** — the worker's `grader_metadata` shape-sniffing design contradicted PR #54's
spec-stated dispatch mechanism. T0 on opus-5 **misattributed** a pre-existing main-branch bug in
the HCL chain-walker to its own work. So: **1 of 6 opus-5 epochs required full rework, and a
second produced a false defect attribution.** Bigger chunks on stronger models have a real, ~17%
observed rework rate per epoch — acceptable when each epoch is 6× faster, but not zero.

### 3.2 The proposed mapping

The table below is a **default**, overridable per step. The dimensions are chosen because they
are the ones that actually predicted trouble in the evidence: file count, *distinct concerns*
(the strongest predictor — steps 04/08/10 in A), LOC, and whether architectural decisions are
in-scope.

| Executor tier | Files touched | Distinct concerns | Net LOC (indicative) | Architectural decisions | Gate authoring |
|---|---|---|---|---|---|
| **fast** (deepseek-flash class) | 1–3 | **1**, fully specified | ≤150 | **None.** Every decision pre-made in the step file, including names, signatures, and file paths. | Gates must be 100% mechanical (exact command + exact expected string). No gate requiring judgment. |
| **standard** (sonnet-5 class) | 3–8 | 1–2, closely related | ≤400 | **None.** May choose local implementation details (loop vs. comprehension, helper extraction) but not interfaces, schemas, or module boundaries. | Gates mechanical; may add its own supplementary tests but may not weaken planner gates. |
| **deep** (opus-5 class) | 8–40 | 2–4 within **one subsystem** | ≤2500 | **Bounded.** May choose internal structure of the subsystem it owns. May NOT change any interface consumed outside that subsystem, nor any persisted data shape. | May author *additional* gates; must run all planner gates verbatim; must state explicitly when it substituted a cheaper proxy. |
| **frontier** (fable class) | 40+ | A whole subsystem/epoch | 2500+ | **Bounded, same rule as deep**, plus: may propose (not enact) cross-subsystem changes, escalating them as an Open Decision. | Same as deep, plus responsible for flagging missing gate classes back to the planner. |

Calibration anchors from evidence: T1 = 30 files / +2502 (deep, comfortable). T4 = 72 files /
+9452 (deep, at or past the ceiling — it was the epoch that needed an extra owner decision
mid-run). `workbench-v0`'s 56 files / +28,266 single commit (D) is *above* even frontier's
recommended ceiling and is exploratory-spike work, not plan-executed work — that commit's
reviewability is exactly the property the table is trying to protect.

### 3.3 Hard limits that apply at every tier

These are **not** scaled by model strength. Each is grounded in an observed failure.

1. **Never merge "implement X" with "redesign the data model / change a schema / change a
   persisted format" in one step.** Persisted-shape changes get their own step at every tier,
   because their blast radius is not bounded by the diff and rollback is not `git revert`.
   *(Grounding: T2's rework was precisely a dispatch-mechanism/data-shape design deviation
   discovered after landing.)*
2. **Never merge a refactor with a behavior change in one step.** A diff that both moves code and
   changes it destroys the reviewer's only cheap signal. *(Grounding: PR #64's 99-commit tangle;
   the M1 layer-collapse pass in A that silently changed `0700`→`0755` was a "pure refactor" that
   wasn't.)*
3. **Never merge a security/permissions boundary change with anything else.** *(Grounding: P0 #1
   — a permission mode change hidden inside a Docker layer-merge optimization.)*
4. **Never merge "add capability" with "change who can see/select it."** *(Grounding: P0 #2 — the
   platform-tools filter hiding `setup_problem`/`grade_problem`.)*
5. **Any step whose rollback is not a clean `git revert` is atomic by definition**, regardless of
   tier: migrations, external API calls, anything touching production data.
6. **Cross-repo / cross-submodule changes split at the repo boundary**, always. *(Grounding: D —
   the `core_gym` submodule plan was inherited identically into 8 carbon-dashboard worktrees;
   ownership of a change must be unambiguous.)*

### 3.4 Changing the default

Current de-facto default: atomic steps sized for a standard-tier executor, always.

**Proposed default:** the planner is told the executor tier up front, and sizes to that tier.
When the tier is unspecified, default to **deep**, not standard — because the evidence shows
deep-tier epoch execution (6.3h, clean branches) beat standard-tier atomic execution (9–10 days,
99-commit tangle) on the same feature by an order of magnitude, and because the marginal cost
of deep-tier tokens is now small relative to the wall-clock and human-review cost of the tangle.

**Also propose lowering the planning threshold.** GYM-891 (10 PRs, direct dispatch, no plan,
~5 hours, all green) is the counterexample to the current "3+ behavior-changing steps → plan"
rule. Proposed replacement rule in §6.

---

## 4. Success-gate / step-contract redesign

### 4.1 Design principles

1. **Gates are classified, not enumerated.** The unit of coverage is the *class*, not the count.
2. **Every step declares a verdict for every class** — including `N/A` with a one-line reason.
   Forcing an explicit `N/A` is what makes a missing class visible. This is the single highest-
   value change in this document.
3. **A gate names the artifact it observes.** "Observes the real built image" vs. "observes the
   build plan." A proxy is allowed *only* when explicitly declared as a proxy, with the real gate
   named and scheduled.
4. **The planner authors the gates. The worker runs them and may only add, never weaken.**
5. **Deferral is a first-class, tracked object**, not an edit. A deferred gate creates a debt row
   that the integration bake must discharge.
6. **Verdicts are machine-parsable and truncation-resistant.**

### 4.2 The seven gate classes

| # | Class | Question | Typical command | Cost |
|---|---|---|---|---|
| **G0** | **Builds / imports** | Does the thing compile, import, and boot without error? | `cargo build`, `python -c "import pkg"`, `tsc --noEmit`, container `--help` | seconds |
| **G1** | **Static quality** | Lint, typecheck, format, no dead/unused imports *from this diff* | `ruff check`, `mypy`, `eslint`, `cargo clippy` | seconds |
| **G2** | **Direct test** | Does the new/changed unit have at least one test that *fails without the change*? | scoped `pytest path::test`, `cargo nextest run -E 'test(x)'` | seconds–minutes |
| **G3** | **Behavior present (smoke)** | Does the actual new behavior actually happen, observed end-to-end at the smallest viable scale? | `curl` the new endpoint; run the CLI; boot the profile and `tools/list`; apply+rollback the migration | minutes |
| **G4** | **No regression** | Does the surrounding scope still work? | scoped suite for the touched package | minutes |
| **G5** | **Artifact-real** | Does the *deliverable artifact* (image, binary, wheel, bundle) actually build and exhibit the property? | real `docker build`/`bake` (**not `--print`**), then probe inside it | ~10–26 min |
| **G6** | **Integration / cross-cutting** | Full suite, cross-subsystem invariants, cold bake, measurements | full suite; cold bake; boot every profile | 30+ min |

Mapping to the escapes: P0 #1 (`0755` vs `0700`) is a **G5**. P0 #2 (hidden lifecycle tools) is a
**G3 that requires a G5 artifact**. The `--print` substitution is a G5 that was satisfied by a G0-
strength proxy. `/gym-review`'s blocking item — per-profile boot gate — is literally "add a
standing G3-on-G5 gate."

### 4.3 Where each class runs

| Class | Worker, before reporting done | Reviewer subagent | Integration bake | Human |
|---|---|---|---|---|
| G0 | **Always** | re-run (cheap) | — | never |
| G1 | **Always** | re-run (cheap) | — | never |
| G2 | **Always** | re-run + verify the test actually *fails* without the change | — | never |
| G3 | **Always when cost < ~5 min** | **Always re-run** | re-run at full breadth | never |
| G4 | scoped subset | **Always re-run the scoped subset** | full suite | never |
| G5 | **At least once per plan, at the first step that touches the artifact** — not deferred to the end | verify the worker ran the real build, not a proxy | always | never |
| G6 | no | no | **Always** | reviews the report |
| — | — | — | — | **Human: only Open Decisions and tradeoff calls** |

**The single most important scheduling rule:** *the first step in a plan that touches a
build-artifact definition (Dockerfile, packaging, bundle spec) must run a real G5 in that step.*
Not at the end. This directly contradicts the observed behavior in both A (deferred to step-15)
and B (deferred past three epochs) and is exactly the failure the coordinator itself named:
"the gap between 'tests pass' and 'image works' is now three epochs wide."

Rationale for making the worker run G0–G3 inline rather than delegating to the reviewer: a
failure caught inside the worker's own turn is fixed with full context in-loop and costs one
iteration; the same failure caught by a reviewer costs a full dispatch round-trip; caught at
integration it costs a plan amendment. The reviewer's job is *independent confirmation and
proxy-detection*, not first discovery.

### 4.4 The standard smoke-block the planner must author

The planner — not the worker — writes these, because the planner is the only role that knows
what the step is *supposed* to make true, and because leaving it to the worker means the worker
grades its own homework with a rubric it wrote after seeing the answers.

Default checklist the planner walks for every step (emit the applicable ones, mark the rest
`N/A: <reason>`):

- [ ] **Boots/imports clean** — the module imports, the service starts, the CLI runs `--help`
- [ ] **New surface responds** — new endpoint returns expected status; new CLI subcommand runs;
      new tool appears in the tool list
- [ ] **New unit has a direct test** — named test, and it fails on the pre-change tree
- [ ] **Migration applies AND rolls back** — both directions, on a scratch DB
- [ ] **Lint/typecheck clean on changed files**
- [ ] **No dead imports / unused symbols introduced by this diff**
- [ ] **No debug residue** — no stray prints, no commented-out blocks, no `TODO(remove)`
- [ ] **Config/flag defaults unchanged unless the step says otherwise** — and if changed, the
      new default is asserted
- [ ] **Permissions/ownership/mode bits unchanged unless the step says otherwise** — assert the
      expected mode explicitly *(added specifically because of P0 #1)*
- [ ] **Visibility unchanged** — anything that was listable/discoverable before still is
      *(added specifically because of P0 #2)*
- [ ] **Artifact really builds** (if the step touches artifact definitions) — real build, then
      probe inside the artifact

The last three exist because they are the exact shapes of the escapes in the evidence. They are
cheap, mechanical, and would have caught both P0s.

### 4.5 Verdict protocol

Replace prose verdicts with a fenced, greppable block emitted as the **last thing** in the
worker/reviewer report (position-stable under head-truncation is impossible, so: require it last
*and* require the single-line summary token first):

```
STEP-VERDICT: step-07 PASS
```
```gate-report
{
  "step": "step-07",
  "verdict": "PASS",
  "gates": [
    {"id": "G0", "cmd": "uv run python -c 'import mcp_compose'", "result": "pass"},
    {"id": "G1", "cmd": "ruff check packages/mcp_compose", "result": "pass"},
    {"id": "G2", "cmd": "uv run pytest packages/mcp_compose/tests/test_codegen.py -q", "result": "pass", "note": "3 passed"},
    {"id": "G3", "cmd": "uv run gym-capabilities report --json | jq -e '.provides|length==101'", "result": "pass"},
    {"id": "G4", "cmd": "uv run pytest packages/mcp_compose -q", "result": "pass", "note": "41 passed"},
    {"id": "G5", "result": "deferred", "owed_at": "step-15", "reason": "no artifact definition touched"},
    {"id": "G6", "result": "n/a"}
  ],
  "proxies_used": [],
  "commit": "abc1234"
}
```

`verdict` ∈ `PASS | FAIL | BLOCKED`. Any gate with `result: "proxy"` **must** populate
`proxies_used` with the real gate and where it is owed. A step whose report contains a `proxy`
entry may not be marked complete in PROGRESS.md without a matching row in the Gate Debt Ledger.

### 4.6 Gate Debt Ledger (new PROGRESS.md section)

```markdown
## Gate Debt Ledger

| Gate | Class | Owed by | Reason deferred | Discharged |
|------|-------|---------|-----------------|------------|
| full mcp-tools suite (405 tests) | G4→G6 | step-15 | 10–25 min per step; scoped to profiles/tests per-step | [ ] |
| real cold bake of taiga image | G5 | step-04 | — | [ ] |
| boot every bundled profile → tools/list | G3-on-G5 | step-11 | needs sentinel image from step-04 | [ ] |
```

**Rule: the plan is not complete while any ledger row is undischarged.** This is the mechanism
that would have converted "T5/T6/T7 deferred" (B) and "CI path-filter gap" (A) from silent drift
into a blocking, visible condition.

---

## 5. Responsibility boundaries

Condensed statement of who authors and who checks, so gates are neither skipped nor duplicated.

| Role | Authors gates? | Runs gates? | Owns |
|---|---|---|---|
| **Specifier** | No — authors *falsifiable invariants* (already does, as "Verifiable Conditions"). Must **not** write commands. | No | The MUST/MUST NOT set that gates must ultimately be traceable to. Spec Open Questions block planning. |
| **Planner** | **Yes — sole author.** Writes G0–G6 per step with exact commands, marks `N/A` with reasons, authors the smoke block, declares the executor tier and sizes steps to it, creates the Gate Debt Ledger, and schedules the first G5. | No (validates that commands are syntactically plausible and match repo conventions) | Gate *coverage*. If a class is missing and a defect escapes through that class, that is a planner failure. |
| **Fact-checker (on the plan)** | No | Selectively — verifies that gate **commands exist and are runnable** and that cited facts are real | Catching invented gates (it already caught an "invented mandatory-checks config"). Add: verify each referenced test path/command actually exists. |
| **Worker (executor child)** | **May only ADD gates, never weaken, narrow, or delete one.** Narrowing requires escalation. | **Runs G0–G4 inline before reporting**, plus G5 when the step owns an artifact. Emits the gate-report block. | Honest reporting, including declaring any proxy used. A step is FAIL if any planner-authored gate did not run. |
| **Reviewer subagent** | No | **Re-runs G0–G4 verbatim, independently.** Additionally: verifies G2 tests actually fail on the pre-change tree; verifies no proxy was silently substituted for a G5; verifies the diff contains nothing outside the step's declared scope | Independent confirmation + **proxy detection**. This is the new explicit duty. |
| **Executor (orchestrator)** | No | Does **not** re-run gates itself; parses verdict blocks, enforces the Gate Debt Ledger, refuses to mark a step complete with an outstanding undeclared proxy | Ledger enforcement, wave advancement, escalation. Fixes its own gate-parsing bugs by using the structured block instead of string-matching prose. |
| **Coordinator** | No | **Yes — independently re-runs the epoch's headline gates** (this is the emergent behavior from B that should become contract) | Between-epoch verification, human gating, epoch boundaries == branch boundaries. |
| **Code-reviewer (competitive, post-hoc)** | No | No (reads diff) | Finds what gates structurally cannot: design flaws, missing gate classes, security reasoning. Should be asked explicitly: *"which gate class is missing here?"* |
| **Human** | Approves the gate set at plan time | Only Open Decisions | Tradeoff calls, spec conflicts, anything the pipeline flags as requiring judgment |

**Anti-duplication rule:** the worker runs G0–G4 for *speed of feedback*; the reviewer re-runs
G0–G4 for *independence*. This duplication is deliberate and was measured at roughly 2× wall
clock in A — and it caught a real P0, so it is worth it. Do **not** additionally have the
executor re-run them; that third pass adds no independence.

---

## 6. Concrete proposed edits (DRAFT — for user review, not applied)

### 6.1 `skills/planner/SKILL.md` — replace the "When to Plan vs. Implement Directly" section

```markdown
## When to Plan vs. Implement Directly

**Plan when any of these are true:**
- The work has genuine ordering constraints (step B cannot start until step A's output exists)
- Changes span repos, services, or persisted data shapes
- Execution will span multiple sessions or needs a durable record for a human reviewer
- Risk of regression is high (production system, complex state)
- User explicitly asks for a plan

**Dispatch directly, no plan, when:**
- The work is a set of *independent, similar units* (N PRs to rebase, N modules to harden,
  N lanes of the same refactor) — dispatch one strong worker per unit and skip the plan entirely
- 1-2 simple changes, well-understood
- User says "just do it" or "quick fix"
- Trivially reversible

**The planning threshold is about *ordering* complexity, not code complexity or unit count.**
Ten independent PR rebases need zero plan and ten dispatches. One three-stage migration with a
data backfill in the middle needs a plan even though it is three steps.

**Observed:** a 10-PR rebase-and-fix stack dispatched as one deep-tier worker per PR completed
in ~5 hours, all green, with no plan artifact. The same work under the plan-first rule would
have produced 10 step files that no one needed.
```

### 6.2 `skills/planner/SKILL.md` — new section, insert before "Step File Anatomy"

```markdown
## Executor Tier and Step Sizing

**Before writing any steps, establish the executor tier.** Ask the user if unstated; default to
**deep**. The tier determines step scope. Sizing a plan for a standard-tier executor and then
running it on a deep-tier executor wastes the stronger model on context re-reading; the reverse
produces silent defects.

| Executor tier | Files | Distinct concerns | Net LOC (indicative) | Architectural latitude |
|---|---|---|---|---|
| fast | 1–3 | 1, fully specified | ≤150 | none — every name, signature, and path pre-decided in the step file |
| standard | 3–8 | 1–2, closely related | ≤400 | local implementation details only; no interfaces, schemas, or module boundaries |
| deep | 8–40 | 2–4 within one subsystem | ≤2500 | internal structure of the owned subsystem; no externally-consumed interface changes |
| frontier | 40+ | one whole subsystem/epoch | 2500+ | as deep, plus may *propose* cross-subsystem changes as Open Decisions |

These are defaults. Deviate when the work demands it, and say why in the step file.

**Distinct concerns is the strongest predictor of trouble** — more so than file count or LOC.
A step that edits 30 files to rename one symbol is one concern. A step that edits 4 files but
changes a schema, a validator, and a CLI flag is three, and will churn on review.

### Hard splits — atomic at every tier, regardless of model strength

Never combine these with anything else, and never with each other:

1. **Data-model / schema / persisted-format change.** Blast radius is not bounded by the diff.
2. **Refactor and behavior change in the same step.** Destroys the reviewer's cheapest signal.
3. **Security, permissions, ownership, or file-mode change.**
4. **Visibility/selection change** (who can see or select a capability) vs. adding the capability.
5. **Anything whose rollback is not a clean `git revert`** — migrations, external API calls,
   production data.
6. **Cross-repo or cross-submodule work** — split at the repo boundary, always.

**Observed:** a Docker `RUN`-merge "pure refactor" silently changed a directory from 0700 to 0755
— a real security regression that survived 15 steps, 33 BDD scenarios, 400+ unit tests, and four
competitive review rounds, because it was bundled into an optimization pass and no gate observed
the real built image.

### Reviewability sizing check

After decomposing, ask: **"what does the PR look like?"** If the steps do not project onto
topic-coherent commits that a human can review in sequence, re-cut them along topic boundaries
even at the cost of larger steps. A plan that executes cleanly but produces a 99-commit
scope-interleaved branch has failed.
```

### 6.3 `skills/planner/SKILL.md` — replace "Acceptance Criteria" in the Step File Anatomy with the following, and add "Reviewer Instructions" changes

````markdown
## Success Gates

Every step declares a verdict for **every** gate class. `N/A` is a valid answer and requires a
one-line reason. An omitted class is a planning defect — the explicit `N/A` is what makes a
missing gate visible.

| Class | Meaning |
|---|---|
| G0 build/import | compiles, imports, boots without error |
| G1 static | lint, typecheck, format, no dead imports from this diff |
| G2 direct test | the new/changed unit has a named test that fails on the pre-change tree |
| G3 behavior smoke | the new behavior is observed end-to-end at the smallest viable scale |
| G4 no regression | scoped suite for the touched package still passes |
| G5 artifact-real | the real deliverable artifact builds and exhibits the property |
| G6 integration | full suite / cold bake / cross-subsystem invariants |

```markdown
### G0 — Build / import
- [ ] `uv run python -c "import mcp_compose"` exits 0

### G1 — Static quality
- [ ] `ruff check packages/mcp_compose` exits 0
- [ ] `mypy packages/mcp_compose` exits 0
- [ ] No unused imports introduced: `ruff check --select F401 $(git diff --name-only HEAD)` exits 0

### G2 — Direct test
- [ ] `uv run pytest packages/mcp_compose/tests/test_loader.py::test_rejects_unknown_version -q` passes
- [ ] This test FAILS on the pre-change tree (worker must verify: `git stash && <cmd>; git stash pop`)

### G3 — Behavior smoke
- [ ] `uv run gym-capabilities validate samples/descriptor.json` exits 0 and prints `OK`
- [ ] `uv run gym-capabilities report --json | jq -e '.provides | length == 101'` exits 0

### G4 — No regression
- [ ] `uv run pytest packages/mcp_compose -q` exits 0

### G5 — Artifact-real
- N/A: this step touches no artifact definition (no Dockerfile, packaging, or bundle spec).
  <!-- If the step DOES touch one, a real build is REQUIRED IN THIS STEP. `--print`,
       `--dry-run`, and shell-logic inspection are PROXIES, not G5. See Proxy Rule below. -->

### G6 — Integration
- Deferred to step-15 (full 405-test suite + cold bake). Recorded in the Gate Debt Ledger.
```

### Standard smoke checklist

Walk this list for every step. Emit the applicable items as G0–G5 gates above; mark the rest
`N/A` with a reason. Do not leave these for the worker to invent.

- [ ] Boots/imports clean
- [ ] New endpoint / CLI subcommand / tool actually responds
- [ ] New unit has a direct test that fails without the change
- [ ] Migration applies AND rolls back on a scratch DB
- [ ] Lint + typecheck clean on changed files
- [ ] No dead imports or unused symbols introduced by this diff
- [ ] No debug residue (stray prints, commented-out blocks, `TODO(remove)`)
- [ ] Config/flag defaults unchanged unless the step says otherwise — assert the new default if changed
- [ ] Permissions / ownership / file-mode bits unchanged unless the step says otherwise — assert explicitly
- [ ] Visibility unchanged: anything listable/discoverable before is still listable/discoverable
- [ ] Artifact really builds, and the property is probed *inside* the built artifact

### Proxy Rule (non-negotiable)

A gate that observes a *description* of the artifact is not a gate on the artifact.

| Proxy (not sufficient) | Real gate |
|---|---|
| `docker buildx bake --print` | `docker buildx bake` then `docker run` and probe inside |
| `terraform plan` | `terraform apply` in a scratch workspace |
| reading a migration file | applying it, then rolling it back |
| `--dry-run` of anything | the non-dry run |
| grepping for a symbol | importing/calling it |

If a proxy is used, the step file must say **PROXY** explicitly, name the real gate, and add a
row to the Gate Debt Ledger. **The first step in the plan that touches an artifact definition
must run a real G5 in that step** — do not defer the first real build to the end of the plan.

**Observed:** three consecutive epochs of Dockerfile work were verified by `bake --print` only.
The coordinator's own note: *"The gap between 'tests pass' and 'image works' is now three epochs
wide."* Separately, in a 15-step plan, the first real bake ran at step 15 and immediately
surfaced two P0 defects that no earlier gate could see.
````

### 6.4 `skills/planner/SKILL.md` — add to PROGRESS.md Structure

```markdown
## Executor Tier
<fast | standard | deep | frontier> — steps in this plan are sized for this tier.

## Gate Debt Ledger

Any gate deferred out of a step is recorded here. **The plan is not complete while any row is
undischarged.**

| Gate | Class | Owed by | Reason deferred | Discharged |
|------|-------|---------|-----------------|------------|
| full test suite (405 tests) | G6 | step-15 | 10–25 min/step; scoped subset runs per-step | [ ] |
| real cold bake of taiga image | G5 | step-04 | — | [ ] |
```

And amend the Subagent Contract block:

```markdown
## Subagent Contract
- Workers: Read step file fully before acting. Implement only what the step specifies.
- Workers: Run ALL G0–G4 gates (and G5 when the step owns an artifact) BEFORE reporting.
- Workers: You may ADD gates. You may NOT weaken, narrow, skip, or delete a gate. Narrowing a
  gate's scope requires escalation, not a unilateral edit.
- Workers: Commit changes with message "step-NN: <name>"
- Workers: End your report with `STEP-VERDICT: step-NN PASS|FAIL|BLOCKED` on its own line,
  followed by a ```gate-report fenced JSON block (schema below).
- Reviewers: Re-run G0–G4 verbatim and independently. Verify G2 tests fail on the pre-change
  tree. Verify no proxy was substituted for a declared real gate. Pass or fail with specifics.
```

### 6.5 `skills/planner/SKILL.md` — amend Step 3 (Validate Output)

```markdown
**3d. Verify gate coverage (mandatory)**

For every step file, confirm:
- All seven classes G0–G6 appear, each with either gates or an explicit `N/A: <reason>`
- Every gate is an exact, runnable command — not a description of a check
- No step uses a proxy without the word PROXY and a matching Gate Debt Ledger row
- At least one step runs a real G5, and it is the FIRST step touching an artifact definition
- Every G2 gate names a specific test, not a suite

If any step fails these checks, amend it before reporting the plan ready. A plan with a missing
gate class is not ready, even if every other section is perfect.
```

### 6.6 `skills/planner/SKILL.md` — amend the Model Guide

```markdown
| Role | Tier | Rationale |
|------|------|-----------|
| Scouts (pre-investigation) | default (no override) | Fast, cheap, code reading |
| Planners | deep, medium thinking | Complex reasoning, architectural tradeoffs |
| Unifier | frontier | Synthesis of conflicting plans |
| Simple mode | frontier | Single-pass synthesis |
| **Executor (the workers this plan will be run by)** | **declared by the user; default deep** | **Determines step scope — see "Executor Tier and Step Sizing". This is an INPUT to planning, not an execution detail.** |
```

### 6.7 `skills/executor/SKILL.md` — replace the "Acceptance criteria" portion of Worker Task Anatomy

```markdown
**Success gates (you must run ALL of these before reporting complete):**
The step file declares gates G0–G6. Run every gate that is not marked N/A, in order.

Rules:
- You may ADD gates. You may NOT weaken, narrow, skip, or delete one. If a gate is wrong or
  unrunnable, STOP and report BLOCKED with the exact error — do not substitute a cheaper check.
- If a gate is marked PROXY, run the proxy AND say so explicitly in your report.
- For every G2 gate, verify the test actually fails on the pre-change tree.
- If the step touches a Dockerfile, packaging manifest, or bundle spec, you must run a REAL
  build (not `--print`, not `--dry-run`) and probe the built artifact.

**Report back:**
End your report with these two blocks, in this order, as the last content in your message:

STEP-VERDICT: step-NN PASS|FAIL|BLOCKED

```gate-report
{"step":"step-NN","verdict":"PASS","commit":"<hash>",
 "gates":[{"id":"G0","cmd":"<exact cmd>","result":"pass|fail|proxy|deferred|n/a","note":"<optional>"}],
 "proxies_used":[{"gate":"G5","proxy_cmd":"<what you ran>","real_gate":"<what is still owed>"}]}
```

Do not report partial completion. Either every non-N/A gate passed, or the verdict is FAIL.
```

### 6.8 `skills/executor/SKILL.md` — replace the "Acceptance criteria to verify" portion of Reviewer Task Anatomy

```markdown
**Gates to verify (run each verbatim, independently — do not trust the worker's report):**
1. Re-run every G0–G4 gate from the step file.
2. For each G2 gate: verify the named test FAILS on the pre-change tree
   (`git stash && <cmd>; git stash pop`). A test that passes before the change tests nothing.
3. **Proxy audit:** read the worker's `gate-report` block. For every gate marked `proxy`,
   confirm the step file authorized that proxy and that a Gate Debt Ledger row exists. An
   undeclared proxy is an automatic FAIL.
4. **Scope audit:** `git show <hash> --stat`. Anything outside the step's declared files is a
   finding — report it even if it looks harmless. Silent scope creep is how permission and
   visibility regressions enter a diff.
5. **Diff hygiene:** no dead imports, no debug residue, no commented-out code introduced.

**Report format:**
End with `STEP-VERDICT: step-NN PASS|FAIL` on its own line as the last line of your message,
preceded by per-gate confirmations:
  ✅ G0 `<cmd>` exited 0
  ✅ G2 `<cmd>` passed, and failed on pre-change tree as required
  ❌ G5 worker ran `bake --print` — step file requires a real build. No ledger row exists.
```

### 6.9 `skills/executor/SKILL.md` — new section after "Execute → Test → Review → Verify Loop"

```markdown
## Verdict Parsing

Do **not** string-match prose for pass/fail. Parse the `STEP-VERDICT:` line, which workers and
reviewers must emit as the last line of their report. If it is absent or the report is
truncated, treat the step as **UNKNOWN**, not as a failure — re-query the child for its verdict
block before taking any action.

**Observed:** an executor that string-matched for a literal `VERDICT: PASS` inside a truncated
summary twice treated passing reviews as failures and halted the chain, requiring mid-run repair
of its own gate logic.

## Gate Debt Ledger Enforcement

Before reporting the plan complete:
1. Read the Gate Debt Ledger in PROGRESS.md.
2. For every undischarged row, either run the owed gate now or escalate to the user.
3. **Never report a plan complete with an undischarged ledger row.** Say explicitly:
   "Plan complete except N owed gates: <list>. These were deferred at steps X, Y."

A deferred gate and a deleted gate must never look the same. The ledger is the difference.

## First-Artifact Rule

Scan the plan for the first step that touches a Dockerfile, packaging manifest, lockfile, or
bundle spec. That step's worker MUST run a real build. If the step file does not require one,
amend the step file before dispatching — this is a local fix, not an escalation.

**Observed:** deferring the first real image build to the final step of a 15-step plan let two
P0 defects (a 0700→0755 permission regression, and a tool filter that hid the product's core
lifecycle tools) survive every earlier gate and the entire review pipeline.
```

---

## 7. Migration risk / what NOT to change

### 7.1 Keep atomic, regardless of model strength

- The six **hard splits** in §3.3. These are not conservatism about model capability; they are
  about blast radius and reviewability, which do not improve as models improve.
- **Migrations and anything non-`git revert`-able.** Always its own step, always with an
  apply+rollback gate.
- **Anything touching production data or external systems.** The existing "Severe derailment"
  escalation in executor/SKILL.md should stay exactly as-is.

### 7.2 Keep, do not "optimize away"

- **Worker runs gates AND reviewer re-runs gates.** It roughly doubles per-step wall clock (A
  measured this explicitly) and it caught a real P0. Do not collapse it to one pass.
- **Plan fact-check before execution.** It caught an invented config and a naming collision.
  It gets *more* valuable as steps get bigger.
- **Competitive review + fact-check-the-review.** The measured hallucination rate of review
  findings was non-zero in round 1 and zero in round 2 — the fact-check is what established that.
- **Escalate-don't-guess.** Worker refusals to fabricate (empty merge, validator-ownership
  conflict) are correct behavior and directly preserved correctness.
- **Coordinator's independent re-verification between epochs.** Currently emergent; this proposal
  makes it contract. Do not drop it in favor of trusting worker reports.

### 7.3 Risks introduced by these changes

1. **Gate bloat.** Seven classes × every step is a lot of markdown, and cost per step rises. If
   plans become gate-authoring exercises the planner will produce shallower implementation
   guidance. *Mitigation:* `N/A: <reason>` must be cheap and normal; most steps should have 3–4
   real gates and 3–4 N/As.
2. **Bigger steps + a reviewer that re-runs everything = long reviewer turns.** A 40-file deep
   step's G4 may be a large suite. May need per-tier gate scoping rules not drafted here.
3. **Bigger steps concentrate rework.** 1 of 6 opus-5 epochs needed a *full rewrite* (T2). At
   atomic granularity, a bad step wastes one step; at epoch granularity it wastes an epoch. The
   6× speedup absorbs this, but the variance is higher. Human-gating between epochs (as the user
   did in B) is what makes it tolerable — do not remove the between-epoch human checkpoint.
4. **The gate-report JSON block is a new failure surface.** Models will occasionally emit
   malformed JSON. The `STEP-VERDICT:` line is the resilient fallback; the JSON is for audit.
5. **`git stash`-based "does the test fail without the change" verification is unsafe with
   concurrent workers or dirty trees.** Needs a safer formulation (e.g. `git worktree add` on the
   parent commit) before this instruction goes into the skill verbatim. **Flagged as a defect in
   the draft text of §6.3/§6.8.**
6. **Real G5 gates cost 10–26 minutes.** Moving the first one from step-15 to step-04 does not
   reduce total cost — it front-loads it. Plans will *appear* slower at the start. This is the
   intended trade.

### 7.4 Open questions requiring the user's judgment

1. **Default executor tier.** This proposal recommends defaulting to **deep** rather than
   standard. That is a cost decision, not a technical one. Confirm or override.
2. **Should the planner be forbidden from producing >8 steps without justification?** A soft cap
   would structurally prevent the 15-step/99-commit outcomes, but could be wrong for genuinely
   long dependency chains. Cap, warn, or neither?
3. **Should coordinator mode be promoted from "a skill the user invokes" to "the default for
   multi-subsystem work," with the atomic planner reserved for high-ordering-constraint work?**
   The evidence supports it (6.3h vs 9–10 days, clean branches vs 99-commit tangle) but the
   sample is one feature.
4. **Where does the Gate Debt Ledger live when there is no plan** (direct-dispatch mode, as in
   GYM-891)? Currently undefined. Options: skip it, or require a minimal per-dispatch gate report.
5. **Is `STEP-VERDICT:` + JSON the right protocol**, or should this be a harness-level structured
   return (the acceptance-report mechanism already used by delegated agents)? A harness primitive
   would be strictly better than a text convention, if one exists.
6. **CI**: in the capability-registration workstream no CI ever ran, because no PR was opened —
   every gate was local. Should the pipeline require a pushed branch with CI green as a G6
   terminal gate, or is that out of scope for these skills?
7. **How much of this should live in the skills vs. in repo `AGENTS.md`?** Gate *commands* are
   repo-specific; gate *classes* are universal. The split proposed here puts classes in the skill
   and commands in the step files, but a repo-level "standard gate commands" convention file
   might be better.
8. **E-bundle-studio evidence is missing** from this analysis. If it contains counter-evidence
   about step sizing, §3 should be revisited before adopting.

---

## Appendix: evidence index for each claim

| Claim | Source |
|---|---|
| 99-commit unshippable tangle from atomic mode, 9–10 days | B §1, §4 |
| 6 epochs / 41 commits / 6.3h on opus-5 | B §1, §2, §4 |
| 1 of 6 epochs fully reworked (T2 spec deviation) | B §5 |
| T0 worker misattributed a pre-existing bug | B §5 |
| `bake --print` only, never a real build, 3 epochs wide | B §5 |
| 2 P0s escaped 15 steps / 33 scenarios / 400+ tests / 4 review rounds | A §3, §6 |
| P0 #1 = 0755 vs 0700 permission regression from a layer-merge refactor | A §3 |
| P0 #2 = platform-tools filter hid `setup_problem`/`grade_problem` | A §3 |
| "6 of which no static gate could have found" | A §3 |
| Gate narrowed for speed (405-test suite → 11-file subset) | A §4 |
| Two false "chain stopped" from prose string-matching | A §3 |
| Plan fact-check: 51 claims, 8 REFUTED, invented config, naming collision | A §3 |
| Review fact-check round 2: 26 CONFIRMED, 0 REFUTED | A §3 |
| No PR ever opened; `/gym-review` = REQUEST CHANGES; blocking item is a missing gate | A §6 |
| `check_core_tools_provides_drift.py` self-detected drift after rebase | A §3 |
| GYM-891: 10 PRs, opus-5 per PR, no planner, ~5h, all green | C B2 |
| Installed defaults: worker/reviewer = sonnet-5, scout = haiku | B §3 |
| User's explicit ask: "simpler planner with big chunks as tasks for a stronger agent" | D §4 |
| llm-cache-proxy: opus-5 investigate → fable-5.1 spec → fc-deep → fable-5.1 plan, 2–4 large steps | D §4 |
| Wave parallelism planned then abandoned due to file overlap | A §2 |
| `workbench-v0` 56 files / +28,266 in one commit (spike work, above frontier ceiling) | D §2 |
| Reviewer/fact-checker peer-PR idiom used verbatim across 3 worktrees | C B3 |
