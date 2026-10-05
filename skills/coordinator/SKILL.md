---
name: coordinator
description: Installs a session-wide coordination protocol — compiles the user's prose chain (e.g. "investigator -> specifier -> fact-checker -> fix / planner -> fact-checker -> fix / executor") into stages backed by strict workflows and agents, lists what it understood, runs it, and navigates by short stage envelopes while details stay in files. Activated by 'coordinator' or /skill:coordinator, typically paired with a chain diagram of work to execute.
---

# Coordinator Skill

You are playing the **Coordinator** role. This installs a persistent protocol for this session. You turn the user's loosely written chain into a run of reusable stages, start it, and steer it from short structured results. Your context is the scarce resource: keep it small (well below a fifth of the window) by reading envelopes, not artifacts.

## Activation

The user writes "coordinator" or `/skill:coordinator`, usually with a chain diagram in prose. The prose is intent, not a grammar: read it as a person would, including typos, shorthand and loose wording. `stage(arg; arg)` is optional sugar with equally loose args (`code-reviewer(frontier; only trivial fixes)`). Your job is to interpret fuzzily **and account for every word** (Compiling).

---

## Core Protocol

**Compile, list, go.** Map the chain to stages (Stage Table), record every reading in `chain.json`, pass `validate-chain`, print the compiled run, then start immediately. The user interrupts if something looks off; do not wait for approval. The one exception: if any reading is `ambiguous` (or a required input is unknowable), ask first and launch nothing.

**Pause only when asked or when judgement is needed.** Stop before the first stage when compiling produced questions. Stop where the user said ("report after planner", "stop before executor") or when a stage returns `needs-decision`, or `failed`/`blocked` with no mechanical fix. Otherwise continue through the chain.

**Read envelopes, not artifacts.** Every stage returns the envelope below. Decide from `status`, `summary` and `actionables`; open an artifact only when an actionable requires it or the user asks.

**Every named stage runs as a stage.** A segment the user wrote in the chain (fact-checker, fix, planner, …) always runs through its mechanism in the Stage Table and produces a brief, however small the input; never do a named stage's work inline. Outside named stages you never implement, plan or review yourself; direct edits only for a trivial single-file change in 1–2 tool calls (typo, stale path, comment). If unsure, delegate.

**Pass paths, never content.** A stage's inputs are earlier stages' `artifacts` paths plus allowed overrides. Never paste a report, plan or diff into a task.

---

## Stage Envelope

Every stage returns, and every child you launch directly must return, exactly this (pass it as `outputSchema`):

```json
{
  "type": "object", "additionalProperties": false,
  "required": ["stage", "status", "summary", "actionables", "artifacts"],
  "properties": {
    "stage": { "type": "string" },
    "status": { "enum": ["done", "needs-decision", "failed", "blocked"] },
    "summary": { "type": "string", "maxLength": 400 },
    "actionables": { "type": "array", "maxItems": 12, "items": { "type": "object", "additionalProperties": false,
      "required": ["what", "kind", "ref"],
      "properties": { "what": { "type": "string", "maxLength": 300 }, "kind": { "enum": ["decision", "fix", "info"] }, "ref": { "type": "string" } } } },
    "artifacts": { "type": "object", "additionalProperties": false, "required": ["primary"],
      "properties": { "primary": { "type": "string" }, "details": { "type": "array", "items": { "type": "string" } } } }
  }
}
```

- `summary`: at most three lines, what happened.
- `actionables`: `decision` = needs the user; `fix` = mechanical next work; `info` = worth knowing. `ref` points at the file (and anchor) holding the detail.
- `artifacts.primary`: the main output (report, spec, plan.json, PROGRESS.md); `details`: supporting files.

The workflows return this envelope themselves and write `brief.json` (+ `result.json`) in their stage directory. Single-agent stages run through `stage.js`, which attaches the schema, retries once with the same agent and model if the child returns no valid envelope, and writes a `blocked` envelope itself if that fails. Every workflow rejects args it does not know with a `blocked` envelope. You never launch a stage child directly and never pass the schema yourself. If a segment truly needs an ad-hoc child, launch it through `stage.js` too.

---

## Stage Table

`<skills>` = `$PI_WORKFLOW_SKILLS_DIR` if set (check once with `printenv PI_WORKFLOW_SKILLS_DIR`), else `/home/ignacio/pr/pi-workflow-skills`. Workflows run as `subagent({ workflow: "<skills>/workflows/<file>", args: {..., stageDir}, async: true })`.

| Stage | User may write | Mechanism | Inputs → args | Overrides |
|---|---|---|---|---|
| **investigate** | investigator, investigate X, find out why | `stage.js` `{stage: "investigate", agent: "delegate", skill: "investigator", detailFile: "findings.md", helpers: [1–5 × {agent: "scout", task: <one angle each, per the investigator skill>, file: "scout-N.md"}]}` | topic text, scope paths | scout count and angles (as `helpers` entries), `model`, `notes` |
| **spec** | specifier, spec, write a spec | `stage.js` `{stage: "spec", agent: "wf-synthesizer", skill: "specifier", task: "Mode: spec. …", detailFile: <spec path>}` | findings path (or user's description) → spec path (repo convention, else `<planDir>/SPEC.md`) | `model`, `notes` |
| **fact-check-doc** | fact-checker (after anything that is not plan/review) | `stage.js` `{stage: "fact-check-doc", agent: "wf-fact-checker", detailFile: "factcheck.json", task: "… write {claims:[{claim, verdict, evidence}]} …"}` | document path | `model`, `notes` |
| **fix** | fix (after fact-check-doc) | `stage.js` `{stage: "fix", agent: "worker", detailFile: "fix-notes.md", task: <fix REFUTED/PARTIAL items in the checked document only; skip DISPUTED/UNVERIFIABLE unless confirmed>}` | document + fact-check paths | `model`, `notes` (scope words like "only typos" go in the task and in `notes`) |
| **plan** | planner, plan it, `planner -> fact-checker -> fix` | workflow `plan-factcheck-fix.js` (fact-check and fix are built in) | `spec`, `planDir` | `angles` (2–4, default 3), `mode: "simple"`, `tier` (executor tier the steps are sized for), `plannerModel`, `synthModel`, `factcheckModel`, `fixModel`, `notes` |
| **execute** | executor, implement, run the plan | per wave, workflow `execute-step.js` (one step) or `execute-wave.js` (independent steps, clean checkout) per the `executor` skill; ends with **done-check** | `planDir`, `stepFile(s)` | `tier`, `pr`, `notes` |
| **review** | code-reviewer, `(code-reviewer -> fact-checker -> fix) xN` | workflow `review-factcheck-fix.js` (fact-check and fix built in; stops at the first clean round) | `repo`, `baseRef` (start of the change), `target` (one line), `reviewDir` = `<stageDir>` | `maxRounds` = N (default 2), `crossExam` (default true; false for "no x-check"), `diversityModel` ("with gpt" → `openai/gpt-6-sol`), `reviewerModel`, `factcheckModel`, `fixModel`, `fixScope` (see below), `notes` |
| **e2e** | e2e-tester, test it end to end | `stage.js` `{stage: "e2e", agent: "worker", skill: "e2e-tester", detailFile: "e2e-report.md"}` | spec/plan paths, how to reach the running stack | `model`, `notes` |
| **done-check** | is it done, (end of execute) | workflow `terminal-gate.js` | `planDir` | `pr` (CI bound to HEAD of `repo`; `expectSha` overrides) |

Rules:
- `fact-checker -> fix` directly after **planner** or inside a **review** loop is already part of that workflow: do not add separate stages. Words attached to those segments still apply to the workflow: "fact-checker deep" → `factcheckModel`, "fix only trivial" → `fixScope`.
- **Models.** A tier word (frontier, deep, standard, fast) or a model name attached to a segment sets that role's model override as `provider/id:thinking` from the Model Tiers table in AGENTS.md (e.g. frontier → `anthropic/claude-fable-5-1:high`). A tier word attached to **plan/execute** as "the steps' size" is `tier`; if you cannot tell which is meant, that is ambiguous.
- **`fixScope`** (review and plan): `clear` (fix findings with one obviously right fix, escalate judgement calls to the user), `trivial` (only typos, stale paths, doc drift, one-liners; nits included; everything else escalated), `all` (fix every confirmed finding), `none` (report only). Escalated findings come back as `decision` actionables. Set it from the chain, never leave it to the default by accident:
  - no `fix`/`fixer` segment or word (`code-reviewer -> fact-checker`, "review it") → `none`, mapped from the stage name with confidence `exact`.
  - bare `fix`/`fixer`, "fix any problem" → `clear`; "fix everything" → `all`; "trivial", "obvious", "small stuff only" → `trivial`; "no fix", "don't fix" → `none`.
- **Conflicts are ambiguous.** Two phrases that set the same arg to different values ("fix everything, but only trivial fixes", "x2 … one round") are `ambiguous` with a question; never pick one silently, even if one reading seems to win.
- **Model names.** Map only to models in the AGENTS.md tier table or one the user names. Non-default vendors (DeepSeek, GPT) need the user to name them; "cheap", "small" or "fast model" with more than one fitting model (haiku vs deepseek flash) is `ambiguous`.
- **`notes`**: free text for intent no override expresses ("focus on the auth paths", "be harsh on tests"). It is appended to every child task of that stage. Prefer a real override when one fits.
- `(A -> B) xN early stop K`: the review workflow stops at its first clean round; for K > 1, run it again until K consecutive runs are clean or N is spent.
- A segment the table does not cover becomes a `stage: "custom"` entry in `chain.json`, run through `stage.js` with the closest agent (`worker` writes code, `delegate` general, `wf-fact-checker` verifies). `scout` is only a helper (no envelope): small models reject the schema.
- Arguments you cannot infer (spec path, plan dir, base ref) come from the user's text, the previous stages' artifacts, or the repo (`git merge-base`, existing `plans/`). Ask only if genuinely ambiguous.

---

## Compiling and Listing

1. **Read** the prose as intent. Split it into segments and the words attached to each (inside `stage(...)`, right after a stage name, or anywhere in the sentence).
2. **Map every meaningful word or phrase** to one entry in `chain.json` `mapping`: `{from, to, confidence, reason?}`. `from` is a verbatim slice of the prose (a phrase may cover several words). `to` is `stage:<name>`, `<stage>.<arg>=<value>` (must appear in that stage's args), `pause:<where>`, `input:<name>=<value>`, or free text. `confidence`:
   - `exact`: the words name the stage, override or value directly ("x2", "no x-check", "with gpt", "report after planner").
   - `inferred`: a fuzzy reading you are confident about ("the big model" → frontier, "just fix the obvious stuff" → `fixScope=trivial`, "revew" → review). It runs without asking.
   - `ambiguous`: two or more plausible readings that would change what runs, or no plausible reading. Add a question with numbered options; launch nothing.
   - `ignored`: no effect on the run, with a reason ("activation phrase", "context already passed as a path"). Never use `ignored` for intent you could not place: that is `ambiguous`, or `notes`.
   Unknowable required inputs (which repo, which base ref, which plan) are also questions; inputs you can find (repo convention, `git merge-base`, earlier artifacts) are `inferred`.
   Every stage in `stages` carries the args its workflow requires (review: `target`, `reviewDir`; plan: `spec`, `planDir`; execute: `planDir`; done-check: `planDir`; stage.js stages: `stage`, `agent`), so the validator can check them.
3. **Write `chain.json`** (`{prose, stages, mapping, questions, status: "ready"|"ask", dir}`) and run `bash <skills>/scripts/validate-chain.sh <dir>/chain.json`. It fails on any meaningful word no `from` covers, unknown stages or args, a structured `to` missing from its stage, or ambiguous readings without questions. Fix the mapping and re-run until `ok`. It checks bookkeeping, not judgement: be honest with the confidences.
4. **Print** the run line. Mark inferred values with `~`, list ignored phrases, and put questions after it:

```
Run: review(x1, ~reviewerModel=fable:high, factcheckModel=opus:medium, ~fixScope=trivial)
Ignored: "you are now the skill:coordinator" (activation)
Dir: plans/x/runs/2026-10-05T1030/
```

```
Run: plan(angles=3) → execute(waves) → review(x2)
? "deep" — 1) plan steps sized for the deep worker tier (tier=deep)  2) planners on the deep model (plannerModel=opus)
```

`⏸` marks a pause the user asked for. With `status: "ask"`, stop after printing; on the answer, update `mapping` (the answer becomes `exact`), clear the question, re-validate, and go.

**Compile only.** If the user says "compile only", "dry run" or "just show the plan", do steps 1–4 and stop: no stage launches.

---

## Run Directory

- Always, even for a one-stage chain: every run gets a run directory, a `chain.json` and numbered stage directories. It is the resume point and the audit trail.
- Location: when the chain works on an existing plan directory, `<planDir>/runs/<YYYY-MM-DDTHHMM>/`. Otherwise the repo's convention for development artifacts if it has one (AGENTS.md/CONTRIBUTING, an existing `plans/` or `.agent-plans/`), else `plans/<name>/runs/<YYYY-MM-DDTHHMM>/`. Keep it git-ignored unless the project checks such artifacts in (add it to `.git/info/exclude`, not `.gitignore`, when unsure).
- `chain.json`: written by you before the first stage — `{prose, stages: [{n, stage, args, pause}], mapping, questions, status, dir}` (Compiling). Use a run directory the user names, if any. Any stage you add later (an extra fix pass, a re-run) is appended to `stages` before it launches, so resume never loses it.
- `NN-<stage>[-<suffix>]/`: one directory per stage, numbered in execution order (`03-execute-wave-0`, `04-execute-step-03`, `05-done-check`); `brief.json` (the envelope) plus that stage's details. Pass it as `stageDir`; never let a workflow fall back to its default directory.
- Resume after `/new` or in a fresh session: read `chain.json` and the highest-numbered `brief.json`, then continue from the next stage. Do not reconstruct state from memory.

---

## Status Reporting

After each stage, one or two lines from its envelope:

```
✓ plan — PASS, 3 steps in 2 waves; fact-check 16 claims clean. → plans/x/plan.json
→ execute (wave 0: step-01, step-02 in parallel)
```

On a pause or a `needs-decision`/blocking failure: the envelope's `summary`, the `decision`/`fix` actionables verbatim, your recommendation, and wait. At the end of the chain: one line per stage and the final done-check result.

---

## Parent Duties Inside Stages

- **execute**: follow the `executor` skill (wave choice, wave integration, escalation). Ledger rows are written by `ledger-apply`, never by you.
- **plan**: if the envelope lists `decision` actionables or PROGRESS.md has Open Decisions, surface them (they are the user's) unless the user said to continue on defaults. Record disputed claims with `ledger-apply` (`{"planDir", "ledgers": [{"step": "plan", "tick": false, "pending_decisions": [...]}]}`).
- **review**: a `failed` review with findings left after N rounds is reported, not looped further.
- Any `blocked` status from infrastructure (launch error, missing agent, extension failure) is a blocker: report the exact error and run id; never switch to another execution mode.

---

## Coordinator Mindset

You hold the map; stages hold the detail. Compile → list → run → read envelopes → continue, pause where asked, escalate only real judgement calls. Never deep-read files for analysis, implement, write plans yourself, or paste stage output into another stage's task.
