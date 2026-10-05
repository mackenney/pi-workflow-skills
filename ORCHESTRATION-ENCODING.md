# Orchestration Encoding: moving the pipeline from prose to primitives

Status: design proposal, **revision 2** (2026-09-24), nothing applied. Inputs: `/tmp/pi_analysis/RECOMMENDATIONS-v2.md` (targets), `/tmp/pi_analysis/FACTCHECK.md`, `/tmp/pi_analysis/FACTCHECK-DIRECTION.md` (fact-check of revision 1; authoritative where the two disagree), `retro-orchestration-analysis.md` §4–§6 (gate/ledger draft; its §6 R2 rationale is superseded by FACTCHECK C7), pi core docs 0.87.x, pi-subagents 0.71.0 docs + source. Portability to other harnesses is documented separately in `PORTABILITY.md` (rationale only, no automation).

Citation convention: `sa:agents.md § Prompt assembly` = `~/.pi/agent/npm/node_modules/pi-subagents/docs/agents.md`, section heading. `pi:packages.md` = `.../pi-coding-agent/docs/packages.md`. `src:` = pi-subagents compiled source under `.../pi-subagents/src/`. `fc:A1` = `FACTCHECK-DIRECTION.md` section A1. Each claim is tagged **[doc]** (stated in docs), **[src]** (confirmed by reading source), **[observed]** (live runtime observation, time-sensitive) or **[assumed]** (neither; needs a probe).

---

## 0. Summary of the proposal

### 0.1 Decisions closed this round

These seven decisions are final for this revision. They are recorded here so nobody has to reconstruct them from §6 or the fact-check.

1. **Tier table home = `~/.pi/agent/AGENTS.md`; role→tier = `tier:` frontmatter in the package agents; binding = a generator script.** AGENTS.md keeps only the tier→model table (`frontier`, `deep`, `standard`, `fast` — verbose names, never `mt-N`) and loses its "Role mapping" line (fc:A7 confirmed leak). Each package agent declares `tier: <name>` in frontmatter, which pi-subagents preserves as inert `extraFields` (fc:E1). `scripts/generate-tier-overrides.mjs` joins the two and **merges** a `{model, thinking}` patch into `settings.json → subagents.agentOverrides`, dry-run by default, never silently overwriting a hand edit (§3.2.1). Profiles / `/subagents-load-profile` are **not** used: they replace the whole `agentOverrides` map (fc:C12).
2. **Oracle stays disabled** (`"oracle": {"disabled": true}`). fc:E4's "enable it" recommendation is not adopted; no part of the active pipeline dispatches `oracle`/`advisor`, and no "significance judgment" is delegated to it.
3. **`PROGRESS.md` (or the plan directory's existing ledger file) is the authoritative ledger.** Mission `state` is an optional, best-effort mirror and receipt store. The parent session writes the ledger from the `ledger` object each workflow returns; the terminal gate reads the file, not mission state.
4. **Deferred gates block by default.** A plan or step is not complete while any deferred gate row is `open`; the only exits are discharging the gate (`discharged <commit>`) or a human-recorded `waived by …` row. No planner-time `blocking:` flag, no model-judged significance.
5. **Fast tier = `openrouter/deepseek/deepseek-v4.1-flash`, re-verified routable on 2026-09-24** (`pi --model openrouter/deepseek/deepseek-v4.1-flash --print` returned `provider: openrouter, model: deepseek/deepseek-v4.1-flash`, no substitution, no provider `order` needed). This supersedes FACTCHECK R9's "unroutable"; routability is account-side and can regress, so the design must not hard-fail if it does (§3.2.1 `--override-tier`). DeepSeek **as implementer** remains an explicit, measured, opt-in trial lane: `wf-flash-worker` ships `disabled: true` (RECOMMENDATIONS-v2 R9).
6. **Cross-vendor (GPT) reviewer is an explicit opt-in lane**, not deleted, not default: `review-factcheck-fix.js` takes `args.diversityModel`; `modelScope.agents["wf-code-reviewer"].allow` is the only place `openai/gpt-6-sol` is permitted. Default competitive review runs one model (fc:E7).
7. **Portability scope is pi-only.** No sync command, renderer or drift-warning extension writes to `~/.claude/agents` or `~/.codex/agents`. `PORTABILITY.md` explains, once, what ports as prose and what does not (fc:D1–D3, E2).

Also applied from the fact-check: deep tier = `anthropic/claude-opus-5-5` (canonical; `fc-deep`'s `opus-5` pin retires, and the retro's Phase B / GYM-891 baseline was measured on `opus-5`, so the metrics plan notes the baseline break — fc:A5, E7); fast tier = `deepseek-v4.1-flash` (canonical; supersedes the older `deepseek-v4-flash` still listed in `enabledModels`); typed `gate` and `outputSchema` are mutually exclusive on one child (fc:C9, E8); the new-agent list shrinks to 7 model-backed agents + 1 command runner (fc:E3, §3.3); deep-tier default executor is a **trial default** (fc:E7).

### 0.2 Layer summary

| Layer | Owns | Today | Proposed |
|---|---|---|---|
| `~/.pi/agent/AGENTS.md` → "Model Tiers" table | **Tier → model + thinking** (4 rows: frontier, deep, standard, fast). Human-edited, read by the generator. | table + a "Role mapping" line that leaks package vocabulary | table only; Role mapping line removed |
| Package agents (`pi-workflow-skills/agents/*.md`) | **Who** does each pipeline role: system prompt, tools, skills, acceptance role, timeouts, and **`tier:`** (declarative). No `model:`/`thinking:`. | 3 empty-body thin agents + 1 real one in `~/.pi/agent/agents` | 7 model-backed agents + 1 command runner (§3.3) + `agents/builtin-tiers.json` for the reused builtins |
| `scripts/generate-tier-overrides.mjs` | **Binding**: frontmatter `tier:` × AGENTS.md table → `subagents.agentOverrides` patch, merged into `settings.json`. Dry-run default, drift-aware. | nothing; three sources disagree | one command; `--check` in the migration verify column |
| `~/.pi/agent/settings.json` → `subagents.agentOverrides` (+`modelScope`) | **Runtime binding** pi-subagents actually reads. `model`/`thinking` keys for managed agents are generator-owned; every other key (`tools`, `disabled`, `defaultContext`, `machine`, …) is hand-owned and preserved. | pins builtins; two dead entries | generated `{model, thinking}` + hand-owned rest; `modelScope` guardrail |
| Skills (`pi-workflow-skills/skills/*`) | **Knowledge and parent-side procedure**: step-file format, gate taxonomy, ledger format, coverage matrix, chain notation, coordinator discipline. No dispatch syntax, no tiers, no models. | dispatch mechanics + knowledge + tier prose mixed | shrink executor/planner/fact-checker/code-reviewer; add `step-contract` skill (shared vocabulary) |
| Workflow scripts (`pi-workflow-skills/workflows/*.js`, run via `subagent({ workflow: "<script path>" })`) | **Repeatable sequences**: `plan-factcheck-fix.js`, `execute-step.js`, `execute-wave.js`, `review-factcheck-fix.js`, `stack-ci-gate.js`, `terminal-gate.js`. | none; parent improvises `subagent(...)` calls | scripts with typed gates, `acceptance.verify`, `outputSchema`, worktree flags |
| Mechanical gates | Planner-authored gate commands executed **by the runtime**; CI read via `gh … --json` inside a command-runner step; STEP-VERDICT as `structured_output`, never parsed from prose | prose string-matching (false halts, a false green) | `acceptance.verify[]` + `outputSchema` + typed gate/step |
| Prompt templates (`~/.pi/agent/prompts/*.md` for `/prompt-workflow`; `pi-workflow-skills/prompts/*.md` for plain `/name`) | **User entry points** | none | `/plan`, `/execute-step`, `/review-wf`, `/investigate` |
| `PROGRESS.md` in the plan directory | **Authoritative ledger**: Decisions taken · Pending decisions (human) · Tech debt / deferred gates · Disabled/softened checks · Gate ledger. Written by the parent from returned `ledger` objects; read by the terminal gate. | ad-hoc `decisions-log.md`, README TODOs | skill-defined sections; `scripts/terminal-gate.sh` fails closed on `open` rows |
| Missions (`missionId` + `state`) | Optional mirror of the ledger and PR/CI receipts. Never authoritative. | unused | `state.set("ledger.<step>", …)` best-effort in scripts |

Mechanics carried over from revision 1 (each argued below): (a) package agents ship via `package.json → pi.subagents.agents` **[src]**; (b) STEP-VERDICT becomes a harness `outputSchema`, and planner gates become runtime-executed `acceptance.verify` commands — the one change that makes "green" non-negotiable; (c) `execute-step.js` runs **one structural step** per invocation so the human checkpoint is the natural boundary; (d) CI status is read by a command-runner agent (`runner.type: external-cli`) wrapping `gh pr checks --json`, because raw workflow scripts cannot call `runs.host`.

---

## 1. Primitive inventory

### 1.1 pi core

| Primitive | What it does | Citation | Pipeline part it could own |
|---|---|---|---|
| **Skills** (`SKILL.md` dirs) | Name+description advertised in the system prompt; body loaded on demand or via `/skill:name [args]`. `disable-model-invocation: true` hides from auto-routing. Can bundle `scripts/`, `references/`, `assets/`. | `pi:skills.md § Understand how skills load`, `§ Write portable frontmatter` | Knowledge: step-file format, gate taxonomy, ledger format, chain notation; parent-session coordination procedure. **Not** dispatch mechanics. |
| **Prompt templates** (`prompts/*.md`) | Markdown → `/command` with `$1`, `$@`, `${1:-default}` substitution; text is expanded into the parent's turn. Discovered from `~/.pi/agent/prompts`, project `.pi/prompts`, and **packages**. | `pi:prompt-templates.md § Use a template`, `§ Add it to Pi`; `pi:packages.md § Create a package` | User entry points that load a skill and point at a workflow file with args. |
| **Packages** (`package.json` `pi` manifest) | Ship `extensions`, `skills`, `prompts`, `themes` from npm/git/local path; local paths are loaded in place (edits visible live). | `pi:packages.md § Create a package`, `§ Select package resources` | `pi-workflow-skills` already is one (`pi.skills`). Add `pi.prompts` and (pi-subagents-specific) `pi.subagents.agents`. |
| **Settings** | `packages`, `skills`, `prompts`, `enabledModels`, `defaultModel`, `defaultThinkingLevel`. `enabledModels` only affects startup selection and `Ctrl+P` cycling, not what subagents may resolve (fc:A2). | `pi:settings.md § Model and thinking`, `§ Resources` | Hosts the `subagents.*` block (below). |
| **Context files** (`AGENTS.md`) | Loaded into the parent prompt; children only see it via `inheritProjectContext` (+`inheritGlobalContext` for `~/.pi/agent/AGENTS.md`). | `sa:agents.md § Prompt assembly` | **Source of the tier→model table** — read by the generator script as data, and by humans. Not a runtime binding mechanism. |
| **Sessions** | Tree-structured; `/fork`, `/tree`; compaction; `--session-dir`. | `pi:sessions.md` | Handoff skill boundary; pi-subagents `context: fork` reuses this. |
| **Extensions** | `pi.registerTool`, `pi.on(...)` lifecycle hooks, `pi.registerCommand`. | `pi:extensions.md § Choose an integration point` | Not required for this design; noted as escape hatch. No drift-warning extension is built (decision 7). |

### 1.2 pi-subagents 0.71.0

| Primitive | What it does | Citation | Pipeline part it could own |
|---|---|---|---|
| **Agent file** (frontmatter + body) | Defines a child: `tools` allowlist, `model`, `thinking`, `systemPromptMode` (default **replace**), `inheritProjectContext` (default false for custom agents), `inheritSkills`, `skills`, `skillPath`, `acceptanceRole`, `acceptance`, `output`, `defaultReads`, `defaultContext`, `async`, `timeoutMs`, `toolTimeoutMs`, `aliases`, `advertise`, `memory`. Body = system prompt. | `sa:agents.md § Frontmatter reference`, `§ Prompt assembly`; defaults in `src:agents/agents.js:27-35` | One agent per distinct tool/acceptance/context contract. |
| **Unknown frontmatter keys** (`tier:`) | Parsed into `extraFields`, preserved by the serializer on round-trip, **never consulted at runtime**. | `src:agents/agents.js:1944-1947, 2025`; `src:agents/agent-serializer.js:176-180` **[src]** | `tier:` as declarative authoring data for the generator. Inert unless rendered. |
| **Agent locations / precedence** | builtin < **installed package** (`package.json` `pi-subagents.agents` or `pi.subagents.agents`) < `~/.pi/agent/agents/**` < project `.pi/agents/**`. Local-path packages in `settings.packages` are resolved relative to `~/.pi/agent`. | `sa:agents.md § Where agents live`; `src:agents/agents.js:163-190, 234-262, 300-330` **[src]** | `pi-workflow-skills/agents/` ships the role agents. |
| **`agentOverrides`** | Per-agent settings override of `model`, `thinking`, `tools`, `skills`, `systemPrompt`, `systemPromptMode`, `inherit*`, `defaultContext`, `acceptanceRole`, `disabled`, `description`, `machine`, … Applies to builtin, package, user, project agents; project beats user. `disabled` applies to package agents too. | `sa:agents.md § Overriding builtins and custom agents`:223; `src:agents/agents.js:1212-1213, 2464, 2510` **[src]** | **Runtime binding site** for model/thinking, written by the generator. Hand-owned keys stay hand-owned. |
| **Model precedence** | per-run `model` → `agentOverridesByProvider` → `agentOverrides.<name>.model` → frontmatter → `subagents.defaultModel` → parent model. No fallback across models. | `sa:models.md` intro | Overrides beat frontmatter, so agent files omit `model`. "No fallback" is why routability regressions need a manual regenerate, not a runtime fallback. |
| **`modelScope`** | Glob allow-lists globally and per agent; `enforce`+`strict` rejects out-of-scope models including per-run overrides. Policy only; never selects. | `sa:models.md § Model scope enforcement` | Guardrail; also the *only* place the GPT reviewer lane is permitted (decision 6). |
| **`defaultThinking` / `maxThinking`** | Shared thinking default; hard ceiling for every native child. | `sa:models.md § Thinking level defaults`, `§ Thinking ceiling` | Ceiling `high`; "never sonnet-5 above medium" is encoded per agent by the generated `thinking`. |
| **`/subagents-models [agent]`**, `subagent({action:"models"})` | Shows the live resolved mapping. | `sa:models.md § Inspecting the live mapping` | Verification step after each generator apply. |
| **Profiles** (`~/.pi/agent/profiles/pi-subagents/*.json`, `/subagents-load-profile`) | Saved `{subagents:{agentOverrides:{…}}}` sets. Loading **replaces** the whole `agentOverrides` map; only `machine` pins and sibling `subagents.*` keys survive. | `src:profiles/profiles.js:38-67, 355-379` **[src]** (fc:C12) | **Not used.** Would drop `scout.tools`, `oracle.disabled`, `worker.defaultContext`. |
| **`modelResponseAliases`** | Accepted *response* model IDs for verifying a proxy route. **Not** a tier alias. | `sa:configuration.md § modelResponseAliases` | Only relevant because all providers route through `127.0.0.1:9001` (`~/.pi/agent/models.json`). |
| **Refinement overlays** (`/subagents-refine <agent>`) | Project-local guidance appended to one agent's prompt; stored in `.pi/subagents/refinements/<agent>.md`; base file untouched. | `sa:agents.md § Refinement overlays` | Per-repo gate-command idioms for `wf-structural-worker` without editing the package agent. |
| **Skills for children** (`skills:`, `skillPath:`, `inheritSkills`; per-run `skill`) | Child gets the `<available_skills>` block for selected skills; `read` auto-added; package skills resolve via `package.json → pi.skills`. Per-run override on a launch item: `skill: "a, b"` in `runs.run` (`skill: false` disables). | `sa:docs/agents.md:502-504`; source `sa:src/extension/schemas.js:146,176,204,358`, `sa:src/api/preflight.js:174` **[src]** | Attach `step-contract` to package agents in frontmatter and to the builtin `worker` per run. |
| **`workflowScript` / `workflowScriptPath` + `args`** (0.74.0: replaced by `workflow: true` for an inline ```` ```js workflow ```` block and `workflow: "<path containing />"` for a file; the old fields now fail with an error) | JS statement body in a sandbox: `runs.run`, `runs.all`, `runs.lanes`, `runs.steer`, `emit`, `state` (with mission). No FS, no shell, no `runs.host` for raw scripts. `args` frozen JSON, persisted in evidence. `action:"validate"` checks statically. | `sa:workflows.md § Scripted workflows`; `sa:tool-reference.md § Execution examples` | **The repeatable pipelines.** |
| **`runs.lanes`** | N independent lanes × ordered stages; `structuredOutput.verdict === "blocked"` skips later stages. | `sa:workflows.md § Parallel sequential lanes` | Parallel atomic waves (worker → reviewer per step). |
| **`gate`** (string) | One host-run command after the child; memoized per tree state; runs inside the child's managed worktree when `worktree:true`. | `sa:tool-reference.md § One-command gates` | Single-command mechanical check. |
| **Typed gate** (`gate:{command,output:"json",schema,timeoutMs}`) | Runs after the child's `output` file is saved, in the child's cwd; stdout JSON (≤12 000 chars) becomes `result.structuredOutput`; never memoized; **cannot coexist with `outputSchema`** on the same item. | `sa:tool-reference.md § Typed gates`:133, 413-429 (fc:C9) | Plan-structure validation after the synthesizer; fact-check report classification; review synthesis classification. Never on the worker or step-reviewer (they use `outputSchema`). |
| **`acceptance`** (`level`, `criteria`, `evidence[]`, `verify[]`, `review`, `report`) | Runtime-enforced evidence gates. `verify[]` entries `{id, command, timeoutMs, cwd, env, allowFailure}` are **executed by the host with `shell:true`**; "Child-reported command success does not count." Default per-command timeout **120 s**. | `sa:tool-reference.md § Acceptance gates`; `src:runs/shared/acceptance.js:1190` **[src]** | **Planner-authored gates become `verify[]`.** Long gates must set `timeoutMs`. |
| **`acceptanceRole: writer`** | Inference: writer → `checked` + required reviewer for async/dynamic writers; read-only → none; omitted → attested. | `sa:tool-reference.md § Levels and inference` | Set on the worker agents. |
| **`outputSchema`** (launch param; also frontmatter, JSON string) | Child receives a `structured_output` tool; the value lands in `result.structuredOutput`; `acceptance.report:"on"` folds the acceptance report into the same call. | `sa:workflows.md § Advanced rolling child runs`; `sa:tool-reference.md § The acceptance report` **[doc]**; frontmatter support `src:agents/agents.js:1965-1969` **[src]** | **STEP-VERDICT** and REVIEW-VERDICT as typed data. |
| **Command-runner agent (typed step)** | `runner: {type: external-cli, command, args, promptDelivery: stdin}`; prompt on stdin, stdout = child output; async-only; no structured output, no model, no tools. | `sa:agents.md § Command-runner agents as typed steps`:63 | **`wf-host-command`**: one runner dispatching to allow-listed scripts under `pi-workflow-skills/scripts/` (`step-loader`, `ci-gate`, `terminal-gate`). |
| **Named resources `run-ci` / `review`, `runs.host`** | Only package-owned resources may call `runs.host`; `run-ci` supports only `npm test` / `npm run typecheck`. | `sa:workflows.md § Named workflow resources`, `§ Host command steps` | **Not usable** for `gh` or `uv run pytest`. Hence the command runner. |
| **`worktree: true` / `baseRef` / `isolation`** | Managed worktree per writing child from a clean HEAD; patch + handoff manifest; setup hook configured (`~/.pi/agent/scripts/setup-worktree.mjs`); gate runs inside the worktree. | `sa:workflows.md § Worktree isolation`; `sa:configuration.md § worktreeBaseDir` | Parallel atomic waves; replaces the retro's `git stash` idea. |
| **Retained children / `resume`** | `runs.run(key, {resume: runId, task})` continues a finished child with its stored contract; `gate` rejected on resume. | `sa:tool-reference.md § Retained children` | Fix loops on the same worker. |
| **`runs.steer`** | Deliver guidance to a live keyed child. | `sa:workflows.md § Steering a workflow child` | Rare. |
| **Supervisor channel** (`contact_supervisor` ↔ `subagent_supervisor`) | Child asks parent for `need_decision` / `interview_request` / `progress_update`; async workflow stays `paused` until the child exits. | `sa:workflows.md § Supervisor coordination` | Worker escalation → parent → human. **Pending decisions (human)** ledger rows originate here. |
| **Missions** (`missionId`, `mission`, `state.get/set`, receipts, decisions) | Durable record per workflow; `state.json` (≤256 KiB); `mission.update` records decisions and PR/CI receipts. Subject to retention cleanup. | `sa:missions.md § Missions`, `§ Managing missions` | **Optional mirror** of the PROGRESS.md ledger; PR/CI receipts. Never the source of truth (decision 3). |
| **Budgets / deadlines** | `timeoutMs`, `toolTimeoutMs`, `checkpointBeforeDeadlineMs`, `toolBudget`, `usageBudget`. | `sa:tool-reference.md § Parameter reference`; `sa:configuration.md § timeoutMs` | Kill the 30-min default that killed step-06 (FACTCHECK C6) via agent `timeoutMs`. |
| **`/prompt-workflow`** | Prompt files with `subagent:`, `model:`, `skill:`, `chain: a -> b` compiled to a linear `workflowScript`. Discovers only pi-subagents' own `prompts/`, `~/.pi/agent/prompts`, project `.pi/prompts`. | `sa:workflows.md § Prompt-template integration`; `src:slash/prompt-workflows.js:70-99` **[src]** | One-child entry points only. |
| **`oracle`/`advisor` builtin** | `read, grep, find, ls, bash`; `thinking: high`; `defaultContext: fork`; no `write`. | `sa:agents/oracle.md:1-10` (fc:C8) | **Disabled; not used** (decision 2). |
| **Schedules, Herdr machines, external CLIs, Orca** | Out of scope. | — | — |

---

## 2. Diagnosis of the current setup

### 2.1 Prose doing mechanical work

| Behaviour | Where it is encoded today | Failure it produced (FACTCHECK) | Primitive that should own it |
|---|---|---|---|
| Pass/fail of a step | executor skill: parent string-matches `VERDICT: PASS` in a child's summary | C6/R5: two false "chain stopped" halts on truncated summaries | `outputSchema` → `result.structuredOutput.verdict` |
| Running acceptance commands | worker/reviewer prompt text: "run these commands verbatim" | C7: "'Green' meant green on the paths we happened to exercise"; C3: `--print` proxies stood in for builds | `acceptance.verify[]` executed by the host; proxy rule enforced by planner-authored command list |
| CI status | none; parent ran `gh pr checks \| tail -5` | C8: false green for ~90 min across 7 PRs | command-runner step wrapping `gh pr checks --json name,state,bucket` |
| Model selection | skills say "tier"; AGENTS.md maps tier→model **and** role→tier; settings pin builtins; ad-hoc agents pin models in frontmatter | three sources disagree (§2.2); sessions created `fc-deep`, `rev-fable`, `rev-sol` on the fly to get a model | AGENTS.md table (tier→model) × frontmatter `tier:` (role→tier) → generator → `agentOverrides`; `modelScope` guardrail |
| Wave/lane ordering, retries, fix loops | executor skill prose, re-derived by the parent every session | wave parallelism "planned then abandoned" (retro §2.8); improvised `explore` agent typo | `workflow: "<path>"` files with stable keys, `runs.all`, `resume` |
| Worker/reviewer role definitions | `worker-reviewer` skill loaded by the parent and pasted into task strings | ~400 lines re-serialised per dispatch; drift between skill text and what the child received | agent system prompts + one shared `step-contract` skill |
| Ledger / deferred gates | none (ad-hoc `decisions-log.md`, README TODOs) | C11: disabled CI job still disabled a month later | PROGRESS.md sections (skill-defined format), `scripts/terminal-gate.sh` fails closed |
| Timeouts for long gates | none | C6: step-06 killed at the 30-minute subagent cap | agent `timeoutMs`; `verify[].timeoutMs` (default is only 120 s **[src]**) |

### 2.2 Tier definitions conflict (verified 2026-09-23; values corrected per fc:A5)

| Tier | `~/.pi/agent/AGENTS.md` table | `settings.json → subagents.agentOverrides` | Ad-hoc agents in `~/.pi/agent/agents` | Resolution in this revision |
|---|---|---|---|---|
| frontier | `anthropic/claude-fable-5-1`, high | — (no frontier-bound agent) | `rev-fable` → `claude-fable-5-1` high | fable-5-1, high |
| deep | `anthropic/claude-opus-5-5`, medium | `planner` → `claude-opus-5-5` medium (**`planner` is not a builtin in 0.71.0** — dead override **[src]** `builtin-names.js`) | `fc-deep` → **`claude-opus-5`** (older model) | **opus-5-5 canonical**; opus-5 retired. Metrics note: Phase B / GYM-891 evidence was on opus-5, so the first structural-mode plans re-baseline. |
| standard | `anthropic/claude-sonnet-5`, medium | worker/reviewer/delegate/researcher → sonnet-5 | — | sonnet-5, medium |
| fast | `openrouter/deepseek/deepseek-v4.1-flash`, low; same file says "All-Anthropic by default; DeepSeek only when explicitly requested" | `scout`, `context-builder` (**not a builtin**, dead) → `claude-haiku-4-5` | — | **deepseek-v4.1-flash canonical** (supersedes `deepseek-v4-flash`, still in `enabledModels`). Routable as of 2026-09-24 **[observed]**; FACTCHECK R9's "unroutable" does not reproduce. Implementer use stays opt-in (`wf-flash-worker` disabled). |
| GPT alternative | `openai/gpt-6-sol` (standard-tier substitute, explicit request only) | — | `rev-sol` → **`openai/gpt-5.6-sol`** (exists in `models-store.json`; `enabledModels` lists `gpt-6-sol`) | Not a tier. Opt-in reviewer lane via `modelScope.agents["wf-code-reviewer"].allow` (decision 6). |

Also: `oracle` and `oracle-executor` are disabled (`oracle-executor` is not a builtin either). AGENTS.md:141 maps package roles to tiers ("specifier → frontier, planner → deep, worker/reviewer → standard, scout/context-builder → fast, fact-checker tiebreaker → frontier") — package vocabulary in harness-wide instructions, one name dead (fc:A7). Nothing binds any of those role names to an agent.

Net: the fast tier was defined three different ways, the deep tier pointed at two opus versions, two of nine overrides target agents that do not exist, and the role→tier line lives in the wrong file.

### 2.3 The thin agents run with (almost) no role prompt

`fc-deep.md`, `rev-fable.md`, `rev-sol.md` have frontmatter only and `systemPromptMode: replace`. Confirmed from source **[src]**:

- `src:agents/agents.js:1822, 2005` — the file body becomes `systemPrompt`; an empty body gives `""`.
- `src:runs/shared/effective-system-prompt.js:14-22` — prompt = `"".trim()` + skills block (none) + memory (none) + refinement overlay (none) + output-path instruction (only if `output` set).
- `src:runs/shared/child-launch.js:212-216` — `replace` sends `systemPrompt: "<active_agent name=\"fc-deep\"/>\n\n"`, which **replaces Pi's base prompt**.
- `src:runs/shared/subagent-prompt-runtime.js:28, 540-561` — the runtime still appends the child-boundary block and, for attested acceptance, the acceptance-report request. Per fc:A1 the live child prompt also carries the Intercom bridge block (`src:intercom/intercom-bridge.js:15`), the `## Acceptance Contract` (`src:runs/shared/acceptance.js:506-530`), `STRUCTURED_OUTPUT_INSTRUCTIONS` when `outputSchema` is set, and ambient host-extension text (e.g. `## Edit Hooks`) for runner children.

So each of those children ran on: an XML tag, the boundary/intercom/acceptance blocks, and whatever the parent pasted into `task`. No role, no evidence standards, no output format, no escalation rules. They "worked" only because the parent pasted the whole fact-checker/code-reviewer skill into the task string each time. `sql-worker.md` is a proper agent and stays.

### 2.4 Stale items

- `~/.pi/agent/SUBAGENTS-CONFIG-README.md` documents a git pin (`git:github.com/nicobailon/pi-subagents@d9864f82`) that `settings.packages` no longer uses (`npm:pi-subagents`, now 0.71.0). The trigger (`pi-hashline-edit`) is no longer in `packages`.
- Orphan checkout `~/.pi/agent/git/github.com/nicobailon/pi-subagents` (179 MB, detached at `d9864f82`). Inert **[src]** `agents.js:300-330`, but confusing.
- `agentOverrides.planner`, `.context-builder`, `.oracle-executor` target non-existent agents (silent no-op, fc:A3).
- `rev-sol` pins `gpt-5.6-sol`; `fc-deep` pins `claude-opus-5`.
- `enabledModels` lists both `deepseek-v4-flash` and `deepseek-v4.1-flash`.
- `retro-orchestration-analysis.md` §6 R2 rationale (class diversity) is contradicted by FACTCHECK C7; the file is untracked in the repo.
- `PENDING_DUEL.md` untracked (out of scope).

---

## 3. Proposed encoding

### 3.1 Responsibility split

```
~/.pi/agent/AGENTS.md ── "Model Tiers" table (tier → model, thinking) ──┐
agents/*.md frontmatter `tier:`  +  agents/builtin-tiers.json ───────────┤
                                                                         ▼
                            scripts/generate-tier-overrides.mjs  (dry-run → patch → --apply)
                                                                         │ merges {model, thinking} per agent
                                                                         ▼
                                   ~/.pi/agent/settings.json → subagents.agentOverrides (+ modelScope)
                                                                         │ read by pi-subagents at launch
user ──/plan, /execute-step, /review-wf──▶ parent session (skills: coordinator, executor, planner, …)
                                              │  picks workflow file + args; talks to the human; writes PROGRESS.md
                                              ▼
                                   subagent({ workflow: "<path>", args, missionId })
                                              │
                    ┌─────────────────────────┼──────────────────────────────┐
                    ▼                         ▼                              ▼
          role agents (wf-*, worker, scout)   acceptance.verify / typed gate / outputSchema     wf-host-command (typed step)
          model from generated override       host-run commands, typed verdicts                 scripts/{step-loader,ci-gate,terminal-gate}.sh
          skills: step-contract, …
```

Rules:

1. **Skills never name a model or a tier.** They name **role agents** (`wf-structural-worker`) or leave the choice to the workflow file's `args.tier` → agent map.
2. **Package agent files declare `tier:` and never `model:` or `thinking:`.** `tier:` is declarative-only (pi-subagents ignores it, `extraFields` **[src]**); it becomes binding only when `scripts/generate-tier-overrides.mjs` renders it into `settings.json`. The generator refuses to run if a package agent's frontmatter contains `model:` or `thinking:` (second source of truth).
3. **Every planner-authored gate is a command the runtime executes** (`acceptance.verify`). The worker also runs them for fast feedback, but its report is not what decides.
4. **Every verdict is `structuredOutput`** (`outputSchema`) **or** a typed gate's stdout — one source per child, never both (fc:C9). Prose is for humans.
5. **One structural step per `execute-step.js` invocation.** The human checkpoint is between invocations; the parent (skill) does the reporting and the PROGRESS.md update.
6. **PROGRESS.md is the ledger.** Scripts return a `ledger` object; the parent writes it into the plan's PROGRESS.md (or the ledger file the plan directory already uses); mission `state` is written best-effort and never read as authority.

### 3.2 Tier matrix: AGENTS.md table × frontmatter `tier:` → generated overrides

**Decision (closed): tier→model lives in `~/.pi/agent/AGENTS.md`'s "Model Tiers" table; role→tier lives in each package agent's `tier:` frontmatter (plus `agents/builtin-tiers.json` for reused builtins); the generator script renders both into `settings.json → subagents.agentOverrides`, which is what pi-subagents reads. `subagents.modelScope` is the guardrail.**

Why this split:
- pi-subagents has **no tier concept** **[doc+src]** (fc:E1 table): frontmatter `model:`/`thinking:` are the only runtime-read per-agent binding in the file, and they express role→model with no indirection; `tier:` is preserved but inert. So a role→tier mapping is always data that *something else* renders. The generator is that something; it is ~150 lines of dependency-free Node and runs on demand.
- AGENTS.md is the right home for tier→model because it is already the user's personal policy document (thinking caveats, opt-in rules), it is one table, and it is harness-agnostic prose. It is the wrong home for role→tier because those roles are package vocabulary (fc:A7).
- `settings.json` is the right *binding* site (overrides beat frontmatter **[doc]** `sa:models.md`), but the wrong *authoring* site: it is user-global JSON with hand-owned keys (`scout.tools`, `oracle.disabled`, `worker.defaultContext`) that a wholesale rewrite would destroy.
- **Profiles are not used.** `/subagents-load-profile` replaces the entire `agentOverrides` map **[src]** `profiles.js:355-379` (fc:C12). A merge script is strictly safer.
- `agentOverridesByProvider` layers on the *parent's* provider; irrelevant to tiers.

#### The three inputs

`~/.pi/agent/AGENTS.md` after migration (the "Role mapping" line is deleted; the table and the surrounding personal-policy paragraphs — thinking caveat, DeepSeek/OpenAI opt-in, OpenRouter fallback — are unchanged and are **not** parsed):

```markdown
## Model Tiers

| Tier | Default | Thinking | Notes |
|---|---|---|---|
| frontier | `anthropic/claude-fable-5-1` | high | … |
| deep | `anthropic/claude-opus-5-5` | medium | … |
| standard | `anthropic/claude-sonnet-5` | medium | … |
| fast | `openrouter/deepseek/deepseek-v4.1-flash` | low | … |
```

Package agent frontmatter (example; full drafts in §3.3):

```yaml
---
name: wf-structural-worker
tier: deep            # declarative; rendered by scripts/generate-tier-overrides.mjs; ignored by pi-subagents
tools: read, grep, find, ls, bash, edit, write, contact_supervisor
acceptanceRole: writer
…
---
```

`agents/builtin-tiers.json` — tiers for the builtins the pipeline reuses (they have no package frontmatter to carry `tier:`):

```json
{ "scout": "fast", "worker": "standard", "reviewer": "standard", "delegate": "standard", "researcher": "standard" }
```

`wf-flash-worker` additionally declares `lane: trial` in frontmatter; the generator emits `disabled: true` for it **on first install only** (§3.2.1).

#### The generated result

Target state after migration steps 1–2 (§5): `defaultModel`, `defaultThinking`, `maxThinking` and `modelScope` do not exist yet in the live `settings.json` (only `agentOverrides` does today) — step 2 hand-writes them once, alongside the first generator `--apply`. After that, this is what `settings.json → subagents` looks like; lines marked `# generated` are the only ones the script ever writes on later runs, and only inside `agentOverrides`. Everything else (including `modelScope`, `defaultModel`, etc.) is hand-owned and preserved byte-for-byte in meaning (key order kept, unknown keys untouched):

```jsonc
"subagents": {
  "defaultModel": "anthropic/claude-sonnet-5",        // hand-owned: standard tier is the floor for anything unlisted
  "defaultThinking": "medium",                        // hand-owned
  "maxThinking": "high",                              // hand-owned: no xhigh/max anywhere without editing settings
  "agentOverrides": {
    // ---- frontier ----
    "wf-synthesizer":       { "model": "anthropic/claude-fable-5-1", "thinking": "high" },                       // generated
    // ---- deep ----
    "wf-planner":           { "model": "anthropic/claude-opus-5-5", "thinking": "medium" },                      // generated
    "wf-fact-checker":      { "model": "anthropic/claude-opus-5-5", "thinking": "medium" },                      // generated
    "wf-structural-worker": { "model": "anthropic/claude-opus-5-5", "thinking": "medium" },                      // generated
    "wf-code-reviewer":     { "model": "anthropic/claude-opus-5-5", "thinking": "medium" },                      // generated
    // ---- standard ----
    "wf-step-reviewer":     { "model": "anthropic/claude-sonnet-5", "thinking": "medium" },                      // generated
    "worker":    { "model": "anthropic/claude-sonnet-5", "thinking": "medium", "defaultContext": "fresh", "tools": [/* hand-owned */] },
    "reviewer":  { "model": "anthropic/claude-sonnet-5", "thinking": "medium", "tools": [/* hand-owned */] },
    "delegate":  { "model": "anthropic/claude-sonnet-5", "thinking": "medium", "tools": [/* hand-owned */] },
    "researcher":{ "model": "anthropic/claude-sonnet-5", "thinking": "medium", "tools": [/* hand-owned */] },
    // ---- fast (managed only for the disabled-by-default trial lane; scout stays hand-pinned below, Q10) ----
    "wf-flash-worker":      { "model": "openrouter/deepseek/deepseek-v4.1-flash", "thinking": "low", "disabled": true },  // generated; see §3.2.1 "first install" semantics
    // ---- hand-owned, not managed ----
    "scout":                { "model": "anthropic/claude-haiku-4-5", "thinking": "low", "tools": [/* hand-owned */] },  // off builtin-tiers.json by design: AGENTS.md's "All-Anthropic by default" (Q10)
    "oracle":               { "disabled": true }                                                                  // decision 2: stays
    // "planner", "context-builder", "oracle-executor": dead (fc:A3) — reported by the generator, removed with --prune <name>
  },
  "modelScope": {                                                                                                   // hand-owned; written once by hand in migration step 2 (does not exist live today)
    "enforce": true, "strict": false,                 // enforce from the start; flip strict after one clean week (step 11)
    // Global allow must cover every model any managed agent can resolve to — a per-agent allow list can only
    // narrow the global list, never widen it (sa:docs/models.md § Model scope enforcement), and an *explicit*
    // per-run model (e.g. args.diversityModel) is hard-rejected outside the global list regardless of `strict`.
    "allow": [
      "inherit", "anthropic/claude-*", "openrouter/anthropic/claude-*",
      "openrouter/deepseek/deepseek-v4.1-flash",   // widen: wf-flash-worker's trial lane (disabled by default)
      "openai/gpt-6-sol"                            // widen: the opt-in GPT reviewer lane
    ],
    "agents": {
      "wf-flash-worker":      { "allow": ["openrouter/deepseek/deepseek-v4.1-flash"] },      // narrow: only this agent may resolve to deepseek
      "wf-structural-worker": { "allow": ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1"] },
      "worker":               { "allow": ["anthropic/claude-sonnet-5", "anthropic/claude-opus-5-5"] },
      "wf-code-reviewer":     { "allow": ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-1", "openai/gpt-6-sol"] }   // decision 6: the only GPT entry point
    }
  }
}
```

Notes: the `worker` builtin defaults to `thinking: high` **[src]** `sa:agents/worker.md:5`; the generated `medium` enforces AGENTS.md's "never sonnet-5 above medium". `scout` stays hand-pinned to `claude-haiku-4-5` and off `builtin-tiers.json` (Q10, resolved: all-Anthropic scouting, consistent with AGENTS.md's own "DeepSeek only when explicitly requested" — see §3.3 "Builtins reused"). The current `tools:` arrays on builtin overrides are hand-owned; drop them by hand once `/subagents-doctor` confirms the pi-hashline-edit issue is gone. `modelScope.agents.<name>` accepts package and builtin agent names alike **[doc+src]** `sa:docs/models.md:211`, `model-scope.js:114`.

#### 3.2.1 `scripts/generate-tier-overrides.mjs` — concrete design

Node ≥ 20, no dependencies, ESM. Invoked from the package root or via an npm script (`"tiers": "node scripts/generate-tier-overrides.mjs"`). It is the only code in this package that writes outside the repo, and it writes exactly one file: `~/.pi/agent/settings.json` (plus its own backup and state files beside it).

**Inputs**

| Input | Path (overridable) | Parsing |
|---|---|---|
| Tier table | `~/.pi/agent/AGENTS.md` (`--agents-md <path>`) | Find the `## Model Tiers` heading; take the first markdown table after it whose header row contains `Tier`, `Default`, `Thinking`. Each body row → `{ tier: cell[0].trim(), model: strip backticks(cell[1]), thinking: cell[2].trim() }`. Everything else in the file is ignored. |
| Role→tier (package agents) | `<pkg>/agents/*.md` | Frontmatter between the first two `---` lines, parsed as flat `key: value` YAML (the same subset pi-subagents accepts). Required: `name`, `tier`. Optional: `lane: trial`. **Error** if `model:` or `thinking:` present. Files with `runner:` (command runners) are skipped — they have no model. Unlike pi-subagents' own frontmatter parser, which keeps a trailing `# comment` as part of the value (`sa:src/agents/frontmatter.js`), the generator strips anything from the first unescaped ` #` onward in the `tier`/`lane` values it reads specifically — generator-side parsing only, harmless to what pi-subagents itself stores. |
| Role→tier (builtins) | `<pkg>/agents/builtin-tiers.json` | `{ "<builtin name>": "<tier>" }`. |
| Current binding | `~/.pi/agent/settings.json` (`--settings <path>`) | JSON. Missing `subagents` or `agentOverrides` → treated as `{}`. |
| Last applied | `~/.pi/agent/tier-overrides.state.json` | `{ appliedAt, applied: { "<agent>": { model, thinking[, disabled] } }, overrides: { "<tier>": { model, thinking, setAt } } }`. Absent on first run. `applied` holds every managed agent's values as of the last apply, not only the ones changed that run (Gap D). `overrides` persists `--override-tier` substitutions until cleared (Gap B). |

**Validation (all modes; any failure → exit 1, nothing written)**

- Every `tier:` value (frontmatter or builtin-tiers.json) exists in the table; every table row has a non-empty model and a `thinking` in pi's set (`off|minimal|low|medium|high|xhigh`).
- Tier names must be one of the four verbose names; the script prints a hint if it sees `mt-N`/`model-tier-N`.
- Duplicate agent names across package files / builtin-tiers.json → error.
- Warnings (non-fatal): a desired model not matched by `subagents.modelScope.allow` or the agent's per-agent `allow` (would be rejected at launch under `strict`); a desired model absent from `enabledModels` (cosmetic, fc:A2); `agentOverrides` keys that are neither managed nor builtin names nor files in `~/.pi/agent/agents/` (candidate dead overrides — `planner`, `context-builder`, `oracle-executor` today).

**Desired state** = for each managed agent: `{ model: table[tier].model, thinking: table[tier].thinking }` (or the tier's active `--override-tier` value, if any — see the `override-active` class below), plus, for `lane: trial` agents, `disabled: true` *only on the agent's first-ever apply* — defined as: **the agent has no entry in `tier-overrides.state.json` yet**. Once an agent has been applied at least once (an entry exists, regardless of what `disabled` currently is), the generator never writes `disabled` again, in either direction. "First install" is keyed off the state file rather than off `agentOverrides[name].disabled` being undefined, because `subagent({action:"enable"})` **deletes** that key (`sa:src/agents/agent-management.js:1441`) — deriving "first install" from the key's absence would silently re-disable an agent the user just turned on (Gap A).

**Owned keys**: exactly `model` and `thinking` for managed agents (and `disabled` on first install of a trial-lane agent, per above). The script never touches any other key of any override, never removes an override, never reorders keys, never touches `defaultModel`, `modelScope`, `machines`, or anything outside `subagents.agentOverrides`. `defaultModel`, `defaultThinking`, `maxThinking` and `modelScope` are written once by hand in migration step 2, not by this script, and the script never touches them afterward.

**Drift classification** (per managed agent, per owned key):

| Current value | vs desired | vs last-applied | Class | `--apply` behaviour |
|---|---|---|---|---|
| absent | — | — | `new` | write |
| equal | — | — | `ok` | no-op |
| differs | equals last-applied | `upstream-change` (table or frontmatter changed since last apply) | write |
| differs | differs (or no state-file entry for this agent) | **`drift`** (hand-edited, or first run over pre-existing values) | **refuse**; print `current → desired`; require `--force` (all) or `--accept <agent>` (per agent) |
| — | an active persisted `--override-tier` exists for this agent's tier | — | **`override-active`** | write the override's value; never classified as `drift`, even though it differs from the AGENTS.md table (Gap B) |

**Modes** (mutually exclusive except `--override-tier`/`--clear-override`, which compose with any of them; default is dry-run):

- *(default)* **dry-run**: print a table `agent | key | current | desired | class` and a one-line summary (`N new, N ok, N upstream-change, N override-active, N drift, N warnings`). Exit 0 if nothing would change, **2** if changes are pending (so `--check` semantics come for free in CI/pre-commit), 1 on validation error.
- `--write-patch [path]` (default `~/.pi/agent/tier-overrides.patch.json`): also write `{ generatedAt, sources: { agentsMd, packageDir, settings }, agentOverrides: { <agent>: {model, thinking[, disabled]} }, drift: [ {agent, key, current, desired} ], overrides: [ {tier, model, thinking, setAt} ], warnings: [] }` for review. Nothing else changes.
- `--apply`: (1) copy `settings.json` → `settings.json.bak-<ISO timestamp>`; (2) read-modify-write in memory; (3) write to `settings.json.tmp` and `rename` over the original (atomic on the same filesystem); (4) write `tier-overrides.state.json` recording, for **every** managed agent (not only the ones touched this run), its now-applied `{model, thinking[, disabled]}`, plus any active `overrides` entries; (5) print the same table plus "restart or `/reload` pi, then `/subagents-models`". Refuses with exit 3 if any `drift` row exists and neither `--force` nor a matching `--accept` was given. JSON is re-serialised with the file's existing indentation (detect 2 vs 4 spaces; default 2) and a trailing newline.
- `--prune <agent>` (repeatable, only with `--apply`): delete that `agentOverrides` key entirely, and its entry from the state file. Explicit by name; there is no `--prune-all-dead`.
- `--override-tier <tier>=<model>[:<thinking>]` (repeatable, any mode): substitute a table row **persistently, for every future run, not just this one** — without editing AGENTS.md. This is the routability escape hatch (decision 5): if `deepseek-v4.1-flash` stops routing, `--override-tier fast=anthropic/claude-haiku-4-5:low --apply` rebinds `wf-flash-worker` (the only agent generator-managed on the `fast` tier — `scout` is hand-pinned, unmanaged) and **persists** the substitution in `tier-overrides.state.json` under `overrides`. Every subsequent run — with or without `--override-tier` repeated — keeps resolving that tier to the overridden model (class `override-active`, never `drift`, no `--force` needed) until explicitly cleared. Without this persistence, the very next plain `--apply` would reclassify the row as `upstream-change` and silently revert to the table model that just stopped routing — the escape hatch would undo itself (Gap B). No `--force` is needed for the escape hatch itself (Gap C); `--force`/`--accept` are only for genuine hand-edit conflicts on unrelated agents.
- `--clear-override <tier>` (only with `--apply`): remove the tier's persisted override; the next apply falls back to the AGENTS.md table row for that tier (classified as `upstream-change` or `drift`, per the table above).

**What it does not do**: write agent files, write AGENTS.md, write profiles, call `/subagents-load-profile`, touch `~/.claude` or `~/.codex`, run at pi startup, or install a hook. It is run by the user (migration steps 1–2, and whenever AGENTS.md or a `tier:` changes) and in `--check` mode by the package's own test/pre-commit if one is added later.

**Verification after `--apply`**: `/reload`, then `/subagents-models` (or `subagent({action:"models"})`) must show every managed agent on its tier model; `subagent({action:"list", capabilities:true})` must show `wf-flash-worker` absent (disabled) and no `planner`/`context-builder`/`oracle-executor` rows after pruning.

### 3.3 Role agents

**Where they live: in the `pi-workflow-skills` package.** Confirmed **[src]** (`agents.js:234-262`): pi-subagents reads `package.json → "pi": {"subagents": {"agents": ["./agents"]}}` from every package root in `settings.packages`, and local relative sources like `../../pr/pi-workflow-skills` resolve from `~/.pi/agent` (`agents.js:163-190`). Package agents load above builtins and below `~/.pi/agent/agents` **[doc]** `sa:agents.md § Where agents live`, and `agentOverrides` — including `disabled` — apply to them **[src]** `agents.js:2464, 1212-1213`. `~/.pi/agent/agents/` keeps only machine-local agents (`sql-worker`).

Proposed `package.json`:

```json
{
  "name": "pi-workflow-skills",
  "version": "0.2.0",
  "keywords": ["pi-package"],
  "pi": {
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "subagents": { "agents": ["./agents"] }
  },
  "scripts": { "tiers": "node scripts/generate-tier-overrides.mjs" }
}
```

#### Sizing rule

One package agent per **distinct tool / acceptance / context contract**, not per model. A role that differs from another only by model does not get its own file unless the tier binding itself is the point (the trial lane). A role that a builtin already covers gets a `tier` (via `builtin-tiers.json`) and, where needed, a per-run `skill:` — not a fork. Revision 1 had 11 model-backed agents + 2 runners; this revision has **7 + 1**.

#### Package agents (new files)

| Agent | `tier:` | Tools | Skills | Acceptance role | Replaces | Notes |
|---|---|---|---|---|---|---|
| `wf-planner` | deep | read, grep, find, ls, write | `step-contract`, `planner` | read-only | `worker` with model override | one angle per run; `output` = scratch plan file |
| `wf-synthesizer` (aliases: `wf-plan-unifier`, `wf-specifier`) | frontier | read, grep, find, ls, bash (read-only repo-convention checks), write, contact_supervisor | `specifier`, `planner`, `step-contract` | read-only (writes only its `output` file) | rev-1 `wf-specifier` + `wf-plan-unifier`; ad-hoc fable dispatch | **Two modes, one contract**: *spec mode* (investigation + intent → spec with RFC 2119 invariants and Open Questions) and *plan mode* (angle plans → unified structural plan, or simple single-pass plan; must emit `step-NN.gates.json` sidecars). The task names the mode; skills are per-run narrowed (`skill: "specifier"` or `skill: "planner, step-contract"`). Same tier, tools, acceptance and context in both modes → one file. |
| `wf-structural-worker` | deep | read, grep, find, ls, bash, edit, write, contact_supervisor | `step-contract` | **writer** | `worker` + pasted worker-reviewer skill | `defaultContext: fresh`, `async: true`, `timeoutMs: 5400000`; worktree-capable. The deep-tier executor is a **trial default** (RECOMMENDATIONS-v2 R1; fc:E7). |
| `wf-flash-worker` | fast, `lane: trial` | same as structural | `step-contract` | writer | — | **Disabled by default** (generator emits `disabled: true` on first install). Body is ~15 lines: role line + "atomic steps with strong gates only" + pointer to `step-contract`. Enabled by hand for one measured plan (§5 step 12). |
| `wf-step-reviewer` | standard | read, grep, find, ls, **bash**, contact_supervisor (no edit/write) | `step-contract` | read-only | builtin `reviewer` (no bash → cannot re-run gates, fc:E3) | audits proxies, scope, coverage matrix, G2-fails-before via `git worktree add` |
| `wf-code-reviewer` | deep | read, grep, find, ls, bash, write | `code-reviewer` (reviewer section only) | read-only | `rev-fable`, `rev-sol`, rev-1 `wf-arbiter` | competitive reviewer angle **and** synthesis mode (reads N findings files, writes the synthesis); `output` = findings file. GPT lane: per-run `model: args.diversityModel`, permitted only by `modelScope` (decision 6). |
| `wf-fact-checker` | deep | read, grep, find, ls, bash, write, web_search, fetch_content, get_search_content, source_check | `fact-checker` | read-only | `fc-deep`; rev-1 `wf-arbiter` tiebreak | needs pi-web-access in the child → `async: true` only **[doc]** `sa:agents.md § Web research prerequisites`. Builtin `evidence-auditor` is **not** a substitute (no grep/bash/write; different verdict vocabulary — fc:E3). Disputed claims after a second fresh run become a **Pending decisions (human)** ledger row; no frontier arbiter. |
| `wf-host-command` | — (command runner, no model) | — | — | — | rev-1 `wf-step-loader` + `wf-ci-gate` | `runner.type: external-cli`, `command: <pkg>/scripts/host-command.sh`. Stdin is **not** raw JSON — `external-cli` runners always receive the combined `<System instructions>\n...\n\n<Task>\n{task}` prompt (`sa:src/runs/shared/external-cli-runner.js:19-21`); the JSON task (`{"script": "step-loader"|"ci-gate"|"terminal-gate", …}`) is everything after the `<Task>\n` marker, and the dispatcher must strip the prefix before parsing. Allow-lists scripts under `<pkg>/scripts/` and rejects anything else. stdout = JSON (kept well under the runner's 64 KiB stdout cap, `sa:docs/tool-reference.md:509`). |

Dropped from revision 1: `wf-scout` (builtin `scout` + tier), `wf-atomic-worker` (builtin `worker` + tier + per-run `skill: "step-contract"`), `wf-specifier`/`wf-plan-unifier` (merged into `wf-synthesizer`), `wf-arbiter` (synthesis → `wf-code-reviewer`; tiebreak → second `wf-fact-checker` run then human), `wf-step-loader`/`wf-ci-gate` (merged into `wf-host-command`).

#### Builtins reused (tier via `agents/builtin-tiers.json`, hand-owned keys untouched)

| Builtin | Shipped contract (fc:E3) | Pipeline role | Tier | Why reuse |
|---|---|---|---|---|
| `scout` | `read, grep, find, ls, bash, write, contact_supervisor`; `thinking: low`; `output: context.md`; `inheritProjectContext: true` | investigator's recon child | **hand-pinned `claude-haiku-4-5`, not managed** | Body is exactly "fast recon → compressed handoff"; nothing to add. **Resolved (Q10):** `scout` stays off `builtin-tiers.json` — AGENTS.md's "All-Anthropic by default; DeepSeek/OpenAI only when explicitly requested" reads as a per-session opt-in, not "every routine scout dispatch, forever". To put scout on the fast tier's DeepSeek model instead, add `"scout": "fast"` to `builtin-tiers.json`; the generator then binds and scopes it like any other managed agent. |
| `worker` | `read, grep, find, ls, bash, edit, write, contact_supervisor`; `thinking: high`; `acceptanceRole: writer`; `defaultContext: fresh`; `defaultReads: context.md, plan.md` | **atomic-step implementer** and fixer for fact-check/review fix passes | standard | Body is already "single writer, approved direction is the contract, escalate unapproved decisions". It lacks the gate vocabulary, so `execute-step.js`/`execute-wave.js` pass `skill: "step-contract"` per run **[doc]** `sa:agents.md § Skills`. Generated `thinking: medium` overrides the shipped `high`. |
| `reviewer` | `read, grep, find, ls, watchdog_diff, contact_supervisor`; no bash, no write | ad-hoc review only | standard | **Not** the step reviewer (cannot re-run gates). Stays bound for ad-hoc use (Q8, resolved). |
| `researcher` | `read, write, web_search, fetch_content, get_search_content, source_check`; no grep/find/ls/bash | web-only research (investigator, spec research) | standard | Good fit for web questions only; never for codebase-touching roles. |
| `delegate` | general | ad-hoc | standard | Unchanged. |
| `evidence-auditor` | `read` + web tools; no grep/bash/write | — | not managed | Not used (wrong tools and verdict vocabulary for code fact-checking). |
| `oracle` / `advisor` | `read, grep, find, ls, bash`; fork context; no write | — | not managed | **Stays `disabled: true`** (decision 2). |

#### Draft `agents/wf-structural-worker.md`

```markdown
---
name: wf-structural-worker
description: Deep-tier implementer for one structural plan step (a subsystem, boundary or seam). Runs every planner-authored gate before reporting, never weakens a gate, escalates unapproved decisions.
aliases: structural-worker
tier: deep
tools: read, grep, find, ls, bash, edit, write, contact_supervisor
acceptanceRole: writer
systemPromptMode: replace
inheritProjectContext: true
inheritGlobalContext: false
inheritSkills: false
skills: step-contract
defaultContext: fresh
async: true
timeoutMs: 5400000
---

You are `wf-structural-worker`: the single writer for exactly one plan step. The step file is the contract; the parent session and the user are the decision authority.

Read first, in this order: the repo instruction files already in your context, the step file named in your task, its `*.gates.json` sidecar, every file under "Files to Read Before Starting", and the `step-contract` skill (gate classes, Proxy Rule, First-Artifact Rule, verdict schema, ledger sections).

Implement the whole step, not a slice. A structural step owns one subsystem; you may restructure inside it, you may not change an externally consumed interface, schema, permission, ownership, file mode, or visibility/selection path unless the step file says so. Anything in the "hard splits" list of `step-contract` that the step did not declare is out of scope: stop and escalate.

Gates:
- Run every gate in the sidecar that is not `n/a`, with the exact command, before you report. The runtime re-runs them independently; your report does not decide the verdict.
- You may add gates. You may not weaken, narrow, skip or replace one. If a gate is wrong or unrunnable, the verdict is `BLOCKED` with the exact error; do not substitute a cheaper check.
- A `--print`, `--dry-run`, plan or grep is a proxy. Use one only where the sidecar marks `proxy: true`, and record it in `proxies_used`. If this step touches a Dockerfile, packaging manifest, lockfile or bundle spec, run the real build and probe the built artifact.
- For every direct-test gate (G2), prove the test fails without your change: `git worktree add /tmp/pre-<step> <base-commit>` and run the test there. Never `git stash`.
- Exercise every row of the step's coverage matrix (profiles, selectors, flags, non-default paths). "Green on the paths I happened to run" is a `FAIL`.
- A gate you cannot run in this step is `deferred`: name it, who owes it, and why. It becomes an `open` row in the ledger and blocks plan completion until discharged or a human waives it. You cannot waive.

Commit with `step-NN: <name>` (imperative, ≤72 chars, non-interactive git, guard with a timeout). Do not leave staged, uncommitted work. Do not edit PROGRESS.md; report ledger rows in your verdict.

Decisions: if implementation requires a product, architecture or scope decision the step did not approve, call `contact_supervisor` with `reason: "need_decision"` and wait. Do not end with a question. Do not send routine completion updates.

Final output: call `structured_output` with the STEP-VERDICT object from `step-contract` (`verdict`, `step`, `commit`, `gates[]`, `coverage[]`, `proxies_used[]`, `deferred[]`, `decisions_taken[]`, `pending_decisions[]`, `residual_risks[]`). If no `structured_output` tool is present, end with the `STEP-VERDICT:` line followed by the fenced `gate-report` block, as the last content of your message.
```

`agents/wf-flash-worker.md` is the same frontmatter with `name: wf-flash-worker`, `tier: fast`, `lane: trial`, `timeoutMs: 3600000`, and a body of one paragraph: fast-tier implementer for **atomic** steps with strong, fully mechanical gates and no open decisions; every rule above applies verbatim via `step-contract`; if the step turns out to need a decision, `BLOCKED` immediately rather than guessing.

#### Draft `agents/wf-step-reviewer.md`

```markdown
---
name: wf-step-reviewer
description: Independent step reviewer. Re-runs the planner-authored gates, audits for proxy substitution, scope creep and coverage-matrix gaps, and returns a typed verdict. Never edits.
tier: standard
tools: read, grep, find, ls, bash, contact_supervisor
systemPromptMode: replace
inheritProjectContext: true
inheritGlobalContext: false
inheritSkills: false
skills: step-contract
async: true
timeoutMs: 3600000
---

You are `wf-step-reviewer`. You verify one completed plan step. You do not implement, fix, or reformat anything; `bash` is for running gates and read-only git inspection only. If review-only conflicts with any progress-writing instruction, review-only wins.

Inputs in your task: step file, its `*.gates.json` sidecar, the worker's commit, the worker's STEP-VERDICT JSON, and the ledger path (PROGRESS.md). Read all of them, then read `step-contract`.

Checks, in order; each produces a row in your verdict:
1. Gates: re-run every non-`n/a` gate verbatim. Compare with the worker's claimed result. A mismatch is a finding even if both pass now.
2. G2 fails-before: for each direct-test gate, run the named test in a throwaway worktree at the step's base commit (`git worktree add`, never `stash`). A test that passes before the change tests nothing.
3. Proxy audit: every `proxy` in the worker's report must be authorised by the sidecar and have a ledger row under "Tech debt / deferred gates". An undeclared proxy is `FAIL`.
4. Coverage matrix: every profile/selector/flag row in the step must be exercised by at least one gate that ran. A row with no gate is `FAIL`.
5. Scope: `git show --stat <commit>`; any file outside the step's declared files, and any change to permissions, ownership, modes, defaults or visibility that the step did not declare, is a finding (P0 if security-relevant).
6. Ledger: decisions the worker took must appear in `decisions_taken`; every `deferred` gate must be in `deferred[]` with an owner; disabled or softened checks must be reported for "Disabled/softened checks". Missing rows are findings. You do not write the ledger; you report `ledger_gaps`.
7. Truncation: never conclude from `tail`, `head`, or a truncated tool result. Re-run with full output or write it to a file and read it.

Do not invent issues; every finding cites a command, path and line. If everything holds, say so.

Final output: call `structured_output` with the REVIEW-VERDICT object from `step-contract` (`verdict: PASS|FAIL`, `step`, `commit`, `gates[]`, `findings[] {severity, class, location, evidence, smallest_fix}`, `ledger_gaps[]`). Fall back to `STEP-VERDICT:` + fenced block only if the tool is absent.
```

Other agents follow the same shape; the synthesizer, fact-checker and code-reviewer bodies are the current skill "role" sections trimmed of dispatch mechanics and tier text.

#### Command-runner agent (typed step)

```markdown
---
name: wf-host-command
description: Runs one allow-listed pi-workflow-skills host script (step-loader, ci-gate, terminal-gate). Extracts the JSON task from the combined system/task stdin prompt and returns JSON on stdout. No model. Callers must keep stdout compact; captured output is capped at the last 64 KiB.
runner:
  type: external-cli
  command: /home/ignacio/pr/pi-workflow-skills/scripts/host-command.sh
  promptDelivery: stdin
async: true
systemPromptMode: replace
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
---
```

`scripts/host-command.sh`: read all of stdin; discard everything up to and including the first `<Task>\n` line (the envelope every `external-cli` runner sends, `sa:src/runs/shared/external-cli-runner.js:19-21`, doc `sa:docs/tool-reference.md:498`); then extract only the **leading JSON object** from the remainder by brace/string-balanced scanning, not a whole-remainder `JSON.parse` — confirmed live (2026-09-24) that a command-runner agent without an explicit `acceptanceRole` gets an ambient `## Acceptance Contract` footer appended by the runtime after the task text (default acceptance level is `attested`), so a naive whole-string `JSON.parse` throws on the trailing prose. `script` must be one of `step-loader`, `ci-gate`, `terminal-gate` (anything else → `{"error":"unknown script"}`, exit 1); `exec "$(dirname "$0")/<script>.sh"` with the extracted JSON on its stdin. The three scripts:

- `step-loader.sh`: `{"stepFile": "/abs/step-07.md"}` → `cat` the `.gates.json` sidecar (error JSON if missing/invalid).
- `ci-gate.sh`: `{"pr": 123}` or `{"branch": "…"}`, optional `waitSeconds` → loop `gh pr checks <pr> --json name,state,bucket,link` until no `pending` or timeout → `{"state":"green|red|pending","failing":[…],"checkCount":N}` (only failing/pending checks are listed in full; a large all-green `checks[]` is summarized to a count so stdout stays under the 64 KiB cap).
- `terminal-gate.sh`: `{"planDir": "/abs/plans/x", "pr"?: 123}` → parse the ledger file (`PROGRESS.md` by default; `ledgerFile` overrides for repos with another convention), fail closed on any deferred-gate or disabled-check row whose status is not `discharged …` or `waived by …` (§3.6), then optionally run `ci-gate` → `{"ok": bool, "openDeferred": [...], "openDisabled": [...], "ci": {...}}`.

Absolute `command` paths are accepted for `external-cli` **[src]** `sa:src/runs/shared/external-cli-preflight.js:11-15` (`resolveBinary`: `path.isAbsolute(command)` → `accessSync(X_OK)`), doc example `sa:docs/workflows.md:231`. These agents are async-only and receive no tools/model/skills **[src]** `sa:src/agents/agents.js:1763-1769`.

### 3.4 Skills reduced to knowledge and parent procedure

| Skill | Keep | Remove / move |
|---|---|---|
| **`step-contract`** (new, `disable-model-invocation: true`) | Gate taxonomy (G-build, G-static, G-unit, G-integ, G-e2e/smoke, G-regress; the retro's G0–G6 renamed to RECOMMENDATIONS names, with `real: true|proxy` as an attribute), coverage matrix format, Proxy Rule, First-Artifact Rule, hard-splits list, tier→scope table, `step-NN.gates.json` schema, STEP-VERDICT and REVIEW-VERDICT JSON schemas, **PROGRESS.md ledger sections and row grammar** (Decisions taken · Pending decisions (human) · Tech debt / deferred gates · Disabled/softened checks · Gate ledger; status grammar `open` / `discharged <commit>` / `waived by <human> <date>: <reason>`). Shared by planner, synthesizer, workers, step-reviewer, fact-checker. | — |
| `planner` | Structural vs atomic mode, executor tier as input (deep is the **trial** default), angles, planner/synthesizer task anatomy, PROGRESS.md + step-file templates (referencing `step-contract`), plan-level e2e gate, validation rules (executed by `scripts/validate-plan.sh` as a typed gate; the skill only explains what the script checks). | Model Guide table (replaced by "planners run as `wf-planner`, unification as `wf-synthesizer` in plan mode"), `subagent(...)` pseudo-syntax, "Subagent Mechanism" paragraph. |
| `executor` | Pre-flight, wave/stack decision (independent → `runs.lanes`; dependent stack → sequential with stack gate), human-checkpoint protocol, **ledger update duty: apply each returned `ledger` object to PROGRESS.md before the next step**, terminal gate (`terminal-gate.js` must return `ok: true`; waivers are human-written rows), failure triage, escalation thresholds, what to report. Points at `workflows/execute-step.js`, `execute-wave.js`, `terminal-gate.js`. | Worker/Reviewer task anatomy, verdict parsing prose, reviewer tier text, `git stash` idea, any "significance" judgment of deferred gates. |
| `worker-reviewer` | **Delete**; content becomes the two agent bodies + `step-contract`. | everything |
| `fact-checker` | Evidence tiers, clustering, verdict vocabulary, `source_check` notes, report format; "verify each gate command exists and runs" duty on plans; dispute protocol (second fresh run → human row). | Dispatch text; tiebreaker model text. |
| `code-reviewer` | Reviewer angles, cross-examination, synthesis (now a `wf-code-reviewer` synthesis run), posting to GitHub, added audits (coverage matrix, ledger, truncated evidence); "second-vendor reviewer only via `args.diversityModel`, off by default". | Model tier bullets; `subagent(tasks:[…])` syntax. |
| `specifier` | As is: RFC 2119 invariants, Open Questions block planning, spec template. Now the body knowledge of `wf-synthesizer` spec mode and still parent-readable. | tier/model sentences |
| `investigator`, `e2e-tester`, `handoff`, `coordinator` | As is, minus tier/model sentences; `coordinator` gains the chain-notation → workflow-file mapping table. | tier/model sentences |

Skill text that says "dispatch N planners in parallel" becomes "run `workflows/plan-factcheck-fix.js` with `args.angles`"; the mechanics live in the file.

### 3.5 Workflow files

All under `pi-workflow-skills/workflows/`, invoked as `subagent({ workflow: "<abs path>", args, cwd, missionId, async: true })` (pi-subagents ≥0.74.0; `workflowScriptPath` was removed). Constraints from docs: top-level `await` only, no nested `async function`, no filesystem, `args` frozen, results are plain JSON, `runs.all` returns an array. Validate each with `subagent({action:"validate", workflow: "<abs path>"})` before first use (`node --check` always fails on top-level `await`).

Rules learned in end-to-end runs (2026-09-25 → 2026-10-02) that every script follows:
- **One output path per child.** The runtime rejects a second child of the same workflow whose `output` resolves to a path an earlier child already claimed (`Workflow children 'a' and 'b' resolve output to the same path`). Fix rounds therefore rewrite a file in place without re-binding `output` (`plan.json` is bound only in synth round 0), or write a per-round file (`factcheck-0.json`, `factcheck-1.json`; cross-exam writes `angle-N-xexam.md` beside `angle-N.md`).
- **Script paths.** Typed-gate commands and the `wf-host-command` runner resolve the package as `${PI_WORKFLOW_SKILLS_DIR:-/home/ignacio/pr/pi-workflow-skills}` (expanded by the host shell). An isolated install (a worktree under test, `tests/e2e/env.sh`) sets the variable; the default keeps the live install unchanged. Prompts tell the parent to resolve it the same way.
- **Workers commit.** Every worker task says to commit its step and report the sha in `STEP-VERDICT.commit`; without it the builtin `worker` left changes uncommitted ("the parent controls commits") and burned a fix round.

| File | Sequence | Mechanical checks |
|---|---|---|
| `plan-factcheck-fix.js` | `runs.all` of `wf-planner` per angle (skipped in simple mode) → **loop ≤3 rounds, each a fresh `wf-synthesizer` launch** (plan mode, `skill: "planner, step-contract"`, `output: "plan.json"` on round 0 only) with typed gate `scripts/validate-plan.sh` — a gate is rejected on `resume` (`sa:src/workflows/scripted-workflow.js:661,2492`), so re-validation after a failed round needs a fresh launch, not `resume`; round 1's task carries the angle plans, later rounds carry the prior plan output plus the gate's `errors[]`; stop at the first round with `structuredOutput.ok === true` → `wf-fact-checker` on the plan (`output: "factcheck-0.json"`; typed gate `scripts/classify-factcheck.sh` reads that file → `{refuted, partial, disputed}`) → if `refuted+partial > 0`: builtin `worker` fix pass (`skill: "step-contract"`, task names the report path) → second fact-check round (`factcheck-1.json`; the return's `factcheckPath` is the last report) → any `disputed` left → returned as `pending_decisions` for the ledger | plan structure; every class has a verdict; each sidecar exists and its `gates`/`coverage` equal plan.json's; each step file names every gate id the sidecar runs; PROGRESS.md has both ledger tables (no placeholder rows) and a `## Steps` item per step; First-Artifact Rule; gate commands exist and fail-before (fact-checker duty); coverage-matrix adequacy is judged by the fact-checker and reviewer, not the script; `validate-plan.sh` always exits 0 and reports `{ok, errors[]}` in its JSON — a non-zero exit fails the gate itself before any `structuredOutput` exists, so the retry branch must not depend on process exit code |
| `execute-step.js` | `wf-host-command`(step-loader) → worker (agent by tier) with `acceptance.verify` = gates, `outputSchema` = STEP-VERDICT → `wf-step-reviewer` with `outputSchema` = REVIEW-VERDICT → optional fix `resume` (≤2) → optional `wf-host-command`(ci-gate) when `args.pr` set → return a `ledger` object | gates executed by runtime; verdicts typed; CI from `--json` |
| `execute-wave.js` | `wf-host-command`(step-loader) per step → `runs.all` of workers, one per independent atomic step (`worktree: true`, `acceptance.verify` = gates, STEP-VERDICT) → `runs.all` of `wf-step-reviewer` for PASS lanes; the reviewer re-runs gates in a throwaway `git worktree add --detach` of the lane commit → returns a board of `ledger` objects. **No fix rounds** (a FAIL lane is re-run by the parent through `execute-step.js`). **Integration is the parent's**: committed lanes are retained on branches `pi-subagents/<key>-…`, recorded at `<lane.asyncDir>/handoff.json` → `groups[0].children[0].patch.branch`; the parent merges them in step order, re-runs every merged step's gates on the integrated tree, applies the ledgers, then removes each lane worktree before its branch (executor skill, Wave Integration). Step files must say "at the repo root", never an absolute repo path, or a worktree child writes into the main checkout. | per-lane gates inside the worktree; integrated re-gate by the parent |
| `review-factcheck-fix.js` | `runs.all` of N `wf-code-reviewer` angles (file outputs; if `args.diversityModel` is set, the last angle gets per-run `model: args.diversityModel`) → optional cross-exam via `resume` (`args.crossExam`; writes `angle-N-xexam.md`) → `wf-code-reviewer` synthesis run (reads the N files) with typed gate `scripts/classify-review.sh` → `wf-fact-checker` on the synthesis → builtin `worker` fix pass → loop ≤ N with early stop on clean round. `args.baseRef` pins the reviewed range (`<baseRef>..HEAD`) so a fix commit cannot drift it. The synthesis puts P0 in `blockers`, P1 in `important`, and P2/nits in an optional `nits` array that never blocks early stop | typed gate on the synthesis file: `{blockers, important, refuted}`; `modelScope` rejects any `diversityModel` not allow-listed for `wf-code-reviewer` |
| `stack-ci-gate.js` | for each PR in `args.prs` (downstream order): `wf-host-command`(ci-gate); return first red | R8 stack-level gate after any rebase |
| `terminal-gate.js` | `wf-host-command`(terminal-gate) with `{planDir, pr?}` → return its JSON verbatim; also `mission.update` a receipt when a mission is present | fails closed on: a missing ledger file; a missing `## Tech debt / deferred gates`, `## Disabled/softened checks` or `## Steps` section; a `## Steps` section with no checklist items or any unchecked `- [ ]` item (`openSteps`); any table row whose Status is not `discharged <7–40 hex>` or `waived by <name> <YYYY-MM-DD>: <reason>` (placeholder rows count as open); non-green CI when `pr` is given |

#### Skeleton `workflows/execute-step.js`

```js
// args: { stepFile: "/abs/plans/x/step-07-name.md", planDir: "/abs/plans/x", baseCommit: "abc123",
//         tier?: "deep"|"standard"|"fast", worker?: "<agent name>", pr?: 123, maxFixRounds?: 2, ledgerFile?: "PROGRESS.md" }
// Sandbox rules: top-level await only, no nested async fns, no fs. Everything file-based goes through children.
// Ledger authority: the parent session applies the returned `ledger` to <planDir>/<ledgerFile>. Mission state is a mirror.

// Tier → agent. Models are NOT named here; each agent's model comes from the generated agentOverrides (§3.2).
// "standard" is the builtin worker with step-contract attached per run; "fast" is the disabled-by-default trial lane.
const WORKER_BY_TIER = {
  deep:     { agent: "wf-structural-worker" },
  standard: { agent: "worker", skill: "step-contract" },   // per-run skill override, documented for runs.run
  fast:     { agent: "wf-flash-worker" }
};

const STEP_VERDICT = {
  type: "object", additionalProperties: false,
  required: ["verdict", "step", "gates", "coverage", "proxies_used", "deferred", "decisions_taken", "pending_decisions", "residual_risks"],
  properties: {
    verdict: { enum: ["PASS", "FAIL", "BLOCKED"] },
    step: { type: "string" }, commit: { type: "string" },
    gates: { type: "array", items: { type: "object", required: ["id", "class", "result"], properties: {
      id: { type: "string" }, class: { enum: ["build", "static", "unit", "integ", "e2e-smoke", "regress"] },
      cmd: { type: "string" }, result: { enum: ["pass", "fail", "proxy", "deferred", "n/a"] }, note: { type: "string" } } } },
    coverage: { type: "array", items: { type: "object", required: ["row", "gate"], properties: { row: { type: "string" }, gate: { type: "string" } } } },
    proxies_used: { type: "array", items: { type: "object", required: ["gate", "proxy_cmd", "real_gate"] } },
    deferred: { type: "array", items: { type: "object", required: ["gate", "owed_by", "reason"] } },   // each becomes an `open` ledger row
    decisions_taken: { type: "array", items: { type: "string" } },
    pending_decisions: { type: "array", items: { type: "string" } },
    residual_risks: { type: "array", items: { type: "string" } }
  }
};
const REVIEW_VERDICT = {
  type: "object", additionalProperties: false, required: ["verdict", "step", "gates", "findings", "ledger_gaps"],
  properties: {
    verdict: { enum: ["PASS", "FAIL"] }, step: { type: "string" }, commit: { type: "string" },
    gates: STEP_VERDICT.properties.gates,
    findings: { type: "array", items: { type: "object", required: ["severity", "class", "location", "evidence", "smallest_fix"] } },
    ledger_gaps: { type: "array", items: { type: "string" } }
  }
};

const ledgerPath = args.planDir + "/" + (args.ledgerFile ?? "PROGRESS.md");
const sidecar = args.stepFile.replace(/\.md$/, ".gates.json");

// 1. Load the planner-authored gate sidecar mechanically (typed step; no LLM transcription).
const loaded = await runs.run("gates", { agent: "wf-host-command", label: "Load step gates", task: JSON.stringify({ script: "step-loader", stepFile: args.stepFile }) });
if (!loaded.ok) return { state: "BLOCKED", reason: "gate sidecar unreadable", error: loaded.error };
const contract = JSON.parse(loaded.output);   // { step, tier, base_commit?, gates:[{id,class,cmd,timeoutMs,proxy?,expect?}], coverage:[...], hard_splits_declared:[...] }

const tier = args.tier ?? contract.tier ?? "deep";   // deep is the trial default (RECOMMENDATIONS-v2 R1)
const lane = WORKER_BY_TIER[tier];
if (!lane) return { state: "BLOCKED", reason: "unknown tier " + tier };
const workerAgent = args.worker ?? lane.agent;
const verify = contract.gates
  .filter((g) => g.cmd && g.result !== "n/a")
  .map((g) => ({ id: g.id, command: g.cmd, timeoutMs: g.timeoutMs ?? 900000 }));   // default verify timeout is 120 s; builds need more

const workerTask = [
  "Implement plan step " + contract.step + ".",
  "Step file: " + args.stepFile,
  "Gate sidecar: " + sidecar,
  "Ledger (read-only for you): " + ledgerPath + " — report ledger rows in your verdict; the parent writes the file.",
  "Base commit for fails-before checks: " + (args.baseCommit ?? contract.base_commit ?? "HEAD"),
  "Executor tier: " + tier + ". Follow the step-contract skill exactly."
].join("\n");

// 2. Worker. The runtime executes every gate command itself (acceptance.verify); the model's claims are evidence, not verdict.
//    If the fast lane is still disabled, this launch fails with an unknown-agent error: enable wf-flash-worker for a measured plan first.
let impl = await runs.run("implement", {
  agent: workerAgent, label: "Implement " + contract.step, task: workerTask,
  ...(lane.skill ? { skill: lane.skill } : {}),
  outputSchema: STEP_VERDICT,
  acceptance: {
    level: "verified",
    criteria: ["Every non-n/a gate in the sidecar passes", "Every coverage-matrix row is exercised by a ran gate", "No undeclared proxy; no scope outside the step"],
    evidence: ["changed-files", "commands-run", "residual-risks", "no-staged-files", "diff-summary"],
    verify,
    report: "on"
  }
});
let verdict = impl.structuredOutput;
if (!impl.ok || !verdict || verdict.verdict !== "PASS") {
  return { state: verdict?.verdict ?? "FAIL", stage: "implement", runId: impl.runId, verdict, error: impl.error, acceptance: impl.acceptance };
}

// 3. Independent review with typed verdict, then bounded fix rounds on the retained worker.
const maxFix = args.maxFixRounds ?? 2;
let review; let round = 0;
while (true) {
  review = await runs.run("review-" + round, {
    agent: "wf-step-reviewer", label: "Review " + contract.step,
    task: [
      "Review plan step " + contract.step + ", commit " + verdict.commit + ".",
      "Step file: " + args.stepFile, "Gate sidecar: " + sidecar,
      "Ledger: " + ledgerPath, "Base commit: " + (args.baseCommit ?? contract.base_commit ?? "HEAD"),
      "Worker STEP-VERDICT JSON:", JSON.stringify(verdict)
    ].join("\n"),
    outputSchema: REVIEW_VERDICT
  });
  const rv = review.structuredOutput;
  if (review.ok && rv && rv.verdict === "PASS") break;
  if (round >= maxFix || !impl.runId) {
    return { state: "FAIL", stage: "review", round, review: rv, error: review.error, workerRunId: impl.runId };
  }
  round += 1;
  impl = await runs.run("fix-" + round, {
    resume: impl.runId, label: "Fix " + contract.step + " round " + round,
    task: "Reviewer findings (verbatim JSON). Address each, re-run all gates, emit a new STEP-VERDICT:\n" + JSON.stringify(rv ?? review.error)
  });
  verdict = impl.structuredOutput;
  if (!impl.ok || !verdict || verdict.verdict !== "PASS") {
    return { state: verdict?.verdict ?? "FAIL", stage: "fix", round, runId: impl.runId, verdict, error: impl.error };
  }
}

// 4. Optional CI gate from structured gh output (never tail/truncated text).
let ci = null;
if (args.pr !== undefined) {
  const ciRun = await runs.run("ci", { agent: "wf-host-command", label: "Read CI for PR " + args.pr, task: JSON.stringify({ script: "ci-gate", pr: args.pr, waitSeconds: 1800 }) });
  ci = ciRun.ok ? JSON.parse(ciRun.output) : { state: "unknown", error: ciRun.error };
}

// 5. Ledger delta. AUTHORITATIVE write: the parent session applies this object to <ledgerPath> (step-contract row grammar)
//    before dispatching the next step. Every `deferred` entry becomes an `open` row that blocks the terminal gate until a
//    human writes `discharged <commit>` or `waived by <name> <date>: <reason>`.
const ledger = {
  step: contract.step, commit: verdict.commit, ledgerPath, gates: verdict.gates,
  deferred: verdict.deferred, proxies_used: verdict.proxies_used,
  decisions_taken: verdict.decisions_taken, pending_decisions: verdict.pending_decisions,
  residual_risks: verdict.residual_risks, review: review.structuredOutput, ci
};
// Optional, best-effort mirror only (mission state is subject to retention cleanup and is never read as authority).
if (typeof state !== "undefined") { try { await state.set("ledger." + contract.step, ledger); } catch (_) { /* mirror failure is not a step failure */ } }
return { state: ci && ci.state === "red" ? "FAIL" : "PASS", ledger, workerRunId: impl.runId, reviewRunId: review.runId };
```

Notes on what is confirmed vs assumed in this skeleton:
- `outputSchema` + `acceptance.verify` on the same child: allowed **[doc]** (only `gate.output:"json"` is exclusive with `outputSchema`, `sa:tool-reference.md § Typed gates`). No typed `gate` is attached to the worker or reviewer for that reason (fc:C9/E8).
- Per-run `skill` on a `runs.run` item **[doc]** `sa:agents.md § Skills`; a disabled agent is an unknown launch target **[src]** `agents.js:2510` (filtered before resolution).
- `acceptance.report: "on"` folds the acceptance report into the `structured_output` call **[doc]** `§ The acceptance report`.
- `resume` keeps the retained child's model/tool contract; `gate` is rejected on resume; `acceptance`/`outputSchema` on resume **[assumed]** to be inherited from the retained contract. If not, the fix round should be a fresh worker run with `context: "fresh"` and the findings pasted.
- `state` global exists only when the outer request has a mission **[doc]** `sa:missions.md`; whether `state.set` can throw inside the sandbox is **[assumed]**, hence the `try`.
- `while (true)` with `await` inside is ordinary top-level control flow; docs forbid only nested async helpers **[doc]**.

### 3.6 Mechanical gates, in one place

| Target behaviour (RECOMMENDATIONS-v2) | Primitive | Guarantee level |
|---|---|---|
| Planner-authored gates run, exactly | `acceptance.verify[]` from the `.gates.json` sidecar; host runs them with `shell:true` in the child cwd/worktree; "child-reported command success does not count" | **[doc+src]** |
| Long gates (real builds) do not time out | `verify[].timeoutMs` (default 120 s **[src]**); agent `timeoutMs`; `checkpointBeforeDeadlineMs` | **[doc+src]**; agent-frontmatter `timeoutMs` on workflow children **[assumed]** |
| STEP-VERDICT typed | `outputSchema` on the worker; `result.structuredOutput` | **[doc]** |
| No proxy gates | sidecar schema requires `proxy: true` + `real_gate` to be explicit; `validate-plan.sh` typed gate rejects a Dockerfile/packaging-touching step without a `build`-class real command (First-Artifact Rule); reviewer audits `proxies_used` | prose→script; script is the user's own code |
| Coverage matrix exercised | sidecar `coverage[]` rows each name a gate id; `validate-plan.sh` requires the array and its equality with the sidecar (it cannot judge whether an empty matrix is legitimate); fact-checker and reviewer check 4 judge adequacy | same |
| CI from structured output | `wf-host-command`(ci-gate) over `gh pr checks --json name,state,bucket`: `bucket` `fail`/`cancel` → red, `pending` → pending, `skipping` ignored, `pass` → counts toward green; zero checks → state `none`, never green; `gh` exit 8 means pending and still prints the JSON | **[observed]** 2026-09-25: `gh pr checks --help`; green on mutmut-fork #580 (matches `statusCheckRollup`), red on pi-mono #10040, `none` on edoplanner #106 |
| Stack-level gate | `stack-ci-gate.js` iterates PRs downstream-first | script |
| Human checkpoint between big steps | one step per `execute-step.js`; `contact_supervisor` pauses the workflow for in-step decisions | **[doc]** `sa:workflows.md § Supervisor coordination` |
| Living ledger | **PROGRESS.md (or the plan dir's ledger file) is authoritative**; sections and row grammar in `step-contract`; written by the parent from each returned `ledger` object; mission `state.ledger.<step>` and PR/CI receipts are a best-effort mirror | PROGRESS.md: prose format enforced by `terminal-gate.sh` parsing; mission: **[doc]** |
| **Plan not complete while deferred gates open** | `terminal-gate.sh` parses "Tech debt / deferred gates", "Disabled/softened checks" and the `## Steps` checklist; any row whose status is not `discharged <commit>` or `waived by <human> <YYYY-MM-DD>: <reason>`, any unchecked step, or any missing section → `ok: false`, listed. A waiver is a row the human writes (or the parent writes verbatim at the human's explicit instruction, quoting it). No model classifies significance; no `blocking:` flag exists. | script (fail-closed regex); the executor skill forbids reporting completion without `ok: true` |
| Tier never hardcoded in skills or scripts | skills and scripts name agents; the generator binds agents to models; `modelScope` warns/rejects stray per-run models | **[doc]** + generator |
| Second-vendor reviewer only on request | `args.diversityModel` + `modelScope.agents["wf-code-reviewer"].allow` | **[doc]** (`modelScope` rejects per-run overrides out of scope) |

### 3.7 Prompt templates as entry points

Two kinds, because of the discovery split confirmed in source:

1. **Plain pi templates** shipped in `pi-workflow-skills/prompts/` (discovered by pi from packages **[doc]** `pi:packages.md`): they expand text into the parent's turn and *tell the parent which skill and workflow file to use*. Example `prompts/plan.md`:

   ```markdown
   ---
   description: Plan from a spec/investigation via plan-factcheck-fix.js (multi-angle or simple)
   argument-hint: "<spec-or-findings-path> <plan-dir> [angles|simple]"
   ---
   `<skills>` is `$PI_WORKFLOW_SKILLS_DIR` when set (check with `printenv PI_WORKFLOW_SKILLS_DIR`), else `/home/ignacio/pr/pi-workflow-skills`. Load the `planner` and `step-contract` skills. Then run `<skills>/workflows/plan-factcheck-fix.js` via `subagent({ workflow: "<that path>", args, async: true })`:
   - `spec`: absolute path of `$1`
   - `planDir`: absolute path of `$2`
   - `${3:-3}` = `simple` → `mode: "simple"`; a number → `angles: <number>`

   When it returns, write any `pendingDecisions` into PROGRESS.md "Pending decisions (human)" and report `state`, `planPath`, `factcheckClass`.
   ```
   Similar: `/execute-step <plan-dir> <step-file> [pr]`, `/execute-wave <plan-dir> <step-file>...`, `/review-wf [rounds] [diversityModel]`, `/terminal-gate <plan> [pr]`, `/investigate <topic>`.

2. **`/prompt-workflow` templates** in `~/.pi/agent/prompts/` (pi-subagents reads only its own, user and project prompt dirs **[src]** `prompt-resources.js`): for one-child shortcuts such as `/prompt-workflow fact-check <path>` → `subagent: wf-fact-checker`, `fresh: true`. Their `chain:` form is linear with `{previous}` only, no gates — not suitable for the pipelines.

### 3.8 Guarantees vs assumptions (consolidated)

| Item | Status | How to confirm |
|---|---|---|
| Package can ship agents via `pi.subagents.agents`, local-path package resolved from `~/.pi/agent` | **[src]** `agents.js:163-262` | after adding the manifest: `subagent({action:"list", capabilities:true})` shows `wf-*` with source `package` |
| Overrides (incl. `disabled`) apply to package agents and beat frontmatter | **[src]** `agents.js:1212-1213, 2464, 2510`; **[doc]** `sa:models.md` | `/subagents-models wf-structural-worker`; `wf-flash-worker` absent from `list` |
| Frontmatter `tier:` preserved as `extraFields`, never read at runtime | **[src]** `agents.js:1944-1947, 2025`; `agent-serializer.js:176-180` | `subagent({action:"get", agent:"wf-planner"})` shows no model until the override exists |
| Profiles replace `agentOverrides` wholesale | **[src]** `profiles.js:355-379` | — (design avoids them) |
| Empty body + `replace` ⇒ no role prompt | **[src]** §2.3 | `subagent({action:"get", agent:"fc-deep"})` shows empty prompt |
| `acceptance.verify` executed by host, 120 s default | **[src]** `acceptance.js:1190` | run a worker with `verify:[{id:"x",command:"false"}]` → run fails |
| `outputSchema` + `acceptance.verify` coexist; `outputSchema` + typed `gate` do not | **[doc]** `tool-reference.md`:133, 429 | validate + one dry run |
| Per-run `skill` on a `runs.run` item | **[src]** confirmed: `sa:docs/agents.md:502-504`, `sa:src/extension/schemas.js:146,176,204,358`, `sa:src/api/preflight.js:174`. (The `tool-reference.md:235` `skills:` key is a different thing — an `action:"create"` agent-definition field, not a launch-item key.) | `execute-step.js` with `tier: "standard"`: worker prompt shows `step-contract` in `<available_skills>` |
| Frontmatter `outputSchema` (JSON string) | **[src]** `agents.js:1965`, undocumented | prefer launch-param form in scripts; optional |
| `runs.host` unavailable to raw scripts; `run-ci` only npm | **[doc]** | — (design avoids it) |
| `external-cli` agent with `command` + `args`, stdin prompt | **[observed]**: `wf-host-command` runs as `bash -c 'exec "${PI_WORKFLOW_SKILLS_DIR:-…}/scripts/host-command.sh"'` (bare commands resolve on PATH, `exec` keeps stdin); the prompt arrives as a `<System instructions>…<Task>` envelope with an acceptance footer appended, so `host-command.sh` extracts the leading brace-balanced JSON | `tests/scripts.test.sh` |
| `/prompt-workflow` ignores other packages' prompt dirs | **[src]** | — (design puts those in `~/.pi/agent/prompts`) |
| `openrouter/deepseek/deepseek-v4.1-flash` routes without provider `order` | **[observed]** 2026-09-24, `pi --model … --print`; account-side, can regress | re-run the same `--print` probe before enabling any fast-tier agent; `--override-tier fast=…` if it fails |
| Agent `timeoutMs` bounds workflow children | **[assumed]** | run a child with `timeoutMs: 60000` and a `sleep 90` task |
| `resume` re-captures `structuredOutput` | **[observed]** confirmed false 2026-09-24 (toy step-01-hello run): a bare `resume` fix round returned prose with no `structured_output` call, and the workflow correctly failed-safe rather than claim a false PASS. Fix, applied in `execute-step.js`: pass `outputSchema` explicitly on the resume launch item too — confirmed this makes the fix round re-capture structured output correctly. | already applied; re-probe if pi-subagents changes resume semantics |
| `modelScope.agents` accepts package agent names | **[doc+src]** confirmed: `sa:docs/models.md:211`, `sa:src/runs/shared/model-scope.js:114` | set and run `/subagents-models` |
| `gh pr checks --json name,state,bucket` fields | **[observed]** 2026-09-25 (see §3.6 CI row) | — |
| pi-hashline-edit host-tool bug fixed in 0.71.0 | **[assumed]** (hashline no longer installed) | `/subagents-doctor`; a `scout` run lists `read`/`grep` |

### 3.9 Portability (pointer only)

This design is pi-subagents-specific by construction: typed gates, `acceptance.verify`, `outputSchema`, scripted workflows, the supervisor channel, `modelScope` and missions have no equivalent in Claude Code or Codex (fc:D1–D3). Nothing in this package renders, syncs or checks agent files for those harnesses, and no code here writes under `~/.claude` or `~/.codex` (decision 7). `PORTABILITY.md` explains which parts of the pipeline are portable prose (role bodies, `step-contract` vocabulary, SKILL.md content) and which are not, with a short porting recipe. The existing `claude-install.sh` (skills-only symlinks) is unchanged and out of scope here.

---

## 4. What should stay a skill, and why

1. **`coordinator`** — session-wide behaviour of the *parent*: read minimally, delegate, navigate by summaries, interpret chain notation, decide when to stop. A child agent cannot own the parent's discipline; `sa:workflows.md § Recommended orchestration pattern` says orchestration is "parent-agent guidance, not a runtime workflow mode". Add a table mapping chain tokens → workflow files.
2. **`executor` (parent procedure)** — choosing between `execute-step.js`, `execute-wave.js` and direct dispatch (independent units, R8), **applying each `ledger` object to PROGRESS.md**, human checkpoints, escalation thresholds, running `terminal-gate.js` and refusing to report completion without `ok: true`. These are judgement calls with the human in the loop, and the human talks to the parent.
3. **`planner` (parent procedure + format)** — selecting angles, deciding structural vs atomic, spec-first and investigation-first protocols, reading Open Decisions back to the user. The templates (PROGRESS.md, step file) are knowledge the synthesizer *and* the human reviewer share.
4. **`step-contract`** — shared vocabulary. It must be identical for the planner who authors gates, the worker who runs them, the reviewer who audits them, the fact-checker who verifies commands exist, and the terminal-gate script that parses the ledger rows. A skill is the only primitive that four agents and the parent can all load by name (`skills:` in frontmatter, per-run `skill:` for the builtin worker, `/skill:` in the parent).
5. **`handoff`** — operates on the *parent's* session (before `/copy` + `/new`); no child can compact the parent.
6. **`fact-checker` / `code-reviewer` / `investigator` / `specifier` / `e2e-tester` knowledge** — evidence tiers, angles, RFC 2119 conventions, narrow-to-wide testing. They become the bodies (or `skills:`) of the corresponding agents *and* stay readable by the parent for synthesis and for the "fix" semantics.
7. **Repo-specific gate command idioms** — not a skill at all: repo `AGENTS.md`, read by workers via `inheritProjectContext` **only when the child's `cwd` matches the repo the parent is already in** (inheritance carries the parent's already-assembled context block, not a fresh read of the child's own `cwd` — fc:E8); a worker launched against a different `cwd` needs the idiom supplied via `defaultReads`/task text instead. Or a refinement overlay on `wf-structural-worker`.

What must **not** stay a skill: dispatch pseudo-syntax, tier→model text, role→tier text, verdict parsing rules, worker/reviewer task-string templates, `git stash` instructions, "is this deferred gate significant" heuristics.

---

## 5. Migration plan (ordered, each step reversible)

Each step: change → verify → commit (the repo) / back up (`settings.json` copy at `~/.pi/agent/settings.json.bak-<date>`; the generator does this itself on `--apply`).

| # | Step | Verify | Rollback |
|---|---|---|---|
| 0 | Snapshot: `cp settings.json settings.json.bak-<date>`; `git -C ~/pr/pi-workflow-skills add retro-orchestration-analysis.md ORCHESTRATION-ENCODING.md PORTABILITY.md`; revise §6 R2 rationale of the retro per RECOMMENDATIONS §7. | `git status` clean except `PENDING_DUEL.md` | — |
| 1 | **AGENTS.md**: delete the "Role mapping" line (`:141`); confirm the table reads `deep = anthropic/claude-opus-5-5`, `fast = openrouter/deepseek/deepseek-v4.1-flash`; leave the personal-policy paragraphs. | `grep -c "Role mapping" ~/.pi/agent/AGENTS.md` → 0 | restore line from git/backup |
| 2 | **Package manifest + generator + settings baseline**: add `pi.prompts`, `pi.subagents.agents`, `scripts.tiers`; create `agents/`, `workflows/`, `scripts/`, `prompts/`; add `scripts/generate-tier-overrides.mjs` and `agents/builtin-tiers.json` (`{"worker":"standard","reviewer":"standard","delegate":"standard","researcher":"standard"}` — `scout` deliberately absent, Q10). By hand, add `defaultModel`, `defaultThinking`, `maxThinking` (unchanged values) and the full `modelScope` block from §3.2 to `settings.json → subagents` (none of these exist live today — only `agentOverrides` does). Run `node scripts/generate-tier-overrides.mjs` (dry-run): expect `ok` for `worker`/`reviewer`/`delegate`/`researcher`'s current model, `new` for the `thinking` key on `delegate`/`researcher` (their live overrides have no `thinking`), and warnings naming the three dead overrides (`planner`, `context-builder`, `oracle-executor`). Re-verify DeepSeek routability (`pi --model openrouter/deepseek/deepseek-v4.1-flash --print 'ping'`). Then `--apply --prune planner --prune context-builder --prune oracle-executor`. | `/reload`; `/subagents-models` shows `worker`/`reviewer`/`delegate`/`researcher` unchanged, `scout` still on haiku (untouched, hand-owned); `subagent({action:"list"})` has no errors and no dead names; dry-run now exits 0 | `cp settings.json.bak-<date> settings.json` |
| 3 | Add **`step-contract` skill** (taxonomy, sidecar schema, verdict schemas, ledger sections + row grammar) with `disable-model-invocation: true`. | `/skill:step-contract` loads; pi startup shows no skill warning | delete dir |
| 4 | Add **`wf-structural-worker`, `wf-step-reviewer`, `wf-host-command`** + `scripts/host-command.sh`, `scripts/step-loader.sh`. Run the generator (`upstream-change`/`new` rows only) `--apply`. | `subagent({action:"get", agent:"wf-structural-worker"})` shows prompt + model from override; probe: toy repo step with one `true` gate and one `false` gate → second fails at runtime | remove files; generator dry-run shows nothing managed |
| 5 | Add **`workflows/execute-step.js`**; `subagent({action:"validate", workflow: "<path>"})`; run on one real, small atomic step of an existing plan with `tier: "standard"` (builtin `worker` + per-run `skill`). Parent applies the returned `ledger` to that plan's PROGRESS.md. | verdict typed; `acceptance` evidence shows host-run gates; PROGRESS.md has the new rows; `state.ledger.<step>` present in `mission.show` (mirror) | delete file |
| 6 | **Planner side**: `wf-planner`, `wf-synthesizer`, `scripts/validate-plan.sh`, `scripts/classify-factcheck.sh`, `workflows/plan-factcheck-fix.js`; rewrite `planner/SKILL.md` per §3.4. Generator `--apply`. | run on the next real feature; synthesizer output has `.gates.json` per step; validate-plan rejects a deliberately broken step | `git revert` |
| 7 | **Fact-check / review side**: `wf-fact-checker` (replaces `fc-deep`), `wf-code-reviewer`, `scripts/classify-review.sh`, `review-factcheck-fix.js`; trim `fact-checker` and `code-reviewer` skills. Generator `--apply` (the `modelScope.agents["wf-code-reviewer"]` entry and the global `openai/gpt-6-sol` allow already exist from step 2). | one plan fact-check run; one review loop with default single model; one with `args.diversityModel` set → GPT reviewer runs; one with an unlisted model → rejected by `modelScope` | `git revert` |
| 8 | **CI + terminal gate**: `scripts/ci-gate.sh`, `scripts/terminal-gate.sh`, `stack-ci-gate.js`, `terminal-gate.js`; executor skill terminal-gate section. | against an existing open PR (e.g. #67) → JSON state matches `gh pr view --json statusCheckRollup`; `terminal-gate.js` on a plan with one `open` deferred row → `ok: false`; add a `waived by …` row → `ok: true` | remove |
| 9 | Rewrite **`executor/SKILL.md`**; delete `worker-reviewer`; add `prompts/*.md` entry points; `~/.pi/agent/prompts/fact-check.md` for `/prompt-workflow`. | `/plan`, `/execute-step`, `/terminal-gate` appear in completion; `/prompt-workflow` lists `fact-check` | `git revert` |
| 10 | **Cleanup**: delete `~/.pi/agent/agents/{fc-deep,rev-fable,rev-sol}.md`; `rm -rf ~/.pi/agent/git/github.com/nicobailon/pi-subagents`; replace `SUBAGENTS-CONFIG-README.md` with a two-line note ("npm:pi-subagents ≥0.71.0; historical pin removed <date>; see ORCHESTRATION-ENCODING.md") or move it to `~/.pi/agent/notes/`; trim `enabledModels` to `deepseek-v4.1-flash` only. | `/subagents-doctor` clean; `subagent({action:"list"})` shows no `fc-deep`/`rev-*`; generator dry-run exits 0 | restore from backup |
| 11 | Flip **`modelScope.strict`** to `true` (the block has existed with `enforce:true, strict:false` since step 2). | no rejections in a normal session; generator dry-run still exits 0 | set `strict` back to `false` |
| 12 | **R9 flash trial lane (opt-in)**: re-run the routability probe; `subagent({action:"enable", agent:"wf-flash-worker"})` (or delete `disabled` by hand — the generator will not re-add it); run one measured plan of atomic steps with `tier: "fast"`; log cost/defects per RECOMMENDATIONS §6. | cost/defect log; `metrics.jsonl` rows tagged `tier: fast` | `subagent({action:"disable", agent:"wf-flash-worker"})` |

Measurement hook (RECOMMENDATIONS §6): every `execute-step.js` return already carries commit, gates, deferred and CI; the parent appends one row per step to `plans/<name>/metrics.jsonl` (cost from `mission.show` usage), tagged with the tier and model actually used. Note the baseline break: retro evidence was on `opus-5`; structural-mode plans run on `opus-5-5`. Move `fc_cost.py` to `~/.pi/agent/scripts/` in step 0.

---

## 6. Resolved decisions, open questions and risks

### 6.1 Resolved in this revision (formerly Q1–Q9)

| Was | Resolution | One-line rationale |
|---|---|---|
| Q1 Fast tier default | **`openrouter/deepseek/deepseek-v4.1-flash`, low** in the AGENTS.md table; only `wf-flash-worker` (implementer, disabled by default) is generator-managed on it — `scout` is hand-pinned to `claude-haiku-4-5` and stays off `builtin-tiers.json` (Q10, below). | Re-verified routable 2026-09-24 without provider `order`; the AGENTS.md row is the explicit opt-in for the *tier*; implementer use stays a measured trial (R9); scouting stays all-Anthropic per AGENTS.md's existing policy. Routability is account-side and can regress → `--override-tier` (now persistent), never a runtime hard-fail. |
| Q2 Deep tier model | **`anthropic/claude-opus-5-5`, medium**; `opus-5` retired. | fc:A5; metrics re-baseline noted in §5. |
| Q3 Competitive reviewer tier / GPT lane | `wf-code-reviewer` = deep for angles and synthesis; **GPT reviewer is an opt-in lane** via `args.diversityModel`, permitted only by `modelScope.agents["wf-code-reviewer"].allow`. Not deleted, not default. | fc:E7: one model by default for cost; keep the cross-vendor capability, since it is the point of "competitive". |
| Q4 Agents in package vs `~/.pi/agent/agents` | **Package.** | Versioned with the skills; `eject` remains for local experiments. |
| Q5 Ledger authority | **PROGRESS.md (or the plan dir's existing ledger file)**; mission `state` is a best-effort mirror. | Survives mission retention cleanup, reviewable in PRs, parseable by `terminal-gate.sh`. |
| Q6 Deferred gates | **Block by default**; only a human-written `waived by <name> <date>: <reason>` row unblocks. No `blocking:` flag, no model-judged significance, no oracle. | Planner-time significance prediction is the same classification error that produced the capability-registration escapes; a human waiver at close-out is stronger evidence (fc:E6). |
| Q8 `worker`/`reviewer` builtin overrides | **Keep, bound via `builtin-tiers.json`**; `worker` is the standard-tier implementer (with per-run `step-contract`); `reviewer` stays for ad-hoc use only. | fc:E3: builtin `worker` fits; builtin `reviewer` cannot re-run gates. |
| Q9 Executor default tier | **deep, as a trial default**; `args.tier ?? contract.tier ?? "deep"`. Re-evaluate after 3 structural-mode plans. | RECOMMENDATIONS-v2 R1 (n=2, confounded). |
| (new) Oracle | **Stays disabled.** | Decision 2. |
| (new) Portability | **pi-only; `PORTABILITY.md` is documentation.** | Decision 7; fc:E2 cost/benefit. |
| (new) Agent count | **7 model-backed + 1 command runner** (§3.3). | fc:E3 sizing rule: one agent per distinct tool/acceptance/context contract. |
| (new) Q10 `scout` tier | **Hand-pinned to `anthropic/claude-haiku-4-5`, unmanaged** (not in `builtin-tiers.json`). | AGENTS.md's "All-Anthropic by default; DeepSeek/OpenAI only when explicitly requested" reads as a per-session opt-in, not "every routine scout dispatch, forever". Reversible: add `scout` back to `builtin-tiers.json` to put it on the fast tier. |

### 6.2 Still open (user decision, not blocking the migration order)

- **Q7. Gate-class names.** RECOMMENDATIONS (`G-build, G-unit, G-integ, G-e2e/smoke, G-regress, G-static`) vs retro (`G0–G6` incl. `G5 artifact-real`). Proposal: RECOMMENDATIONS names + keep `artifact-real` as a required *attribute* (`real: true|proxy`) on build/e2e gates rather than a class. Affects the `STEP_VERDICT.gates[].class` enum in §3.5.

### 6.3 Risks / unconfirmed behaviour

- R-a. ~~`resume` + `outputSchema`~~ **Resolved** (§3.8): `resume` does not re-capture `outputSchema`; scripts pass it explicitly on every resume. A typed `gate` is rejected on `resume`, so gated re-runs are fresh launches.
- R-b. Agent-frontmatter `timeoutMs` on workflow children (§3.8). If ignored, pass `timeoutMs` per `runs.run` item in the scripts.
- R-c. `acceptance.verify` runs with the **runner's** environment (`effectiveVerifyEnv`, `acceptance.js:1141`): `uv`, `gh`, docker must be on PATH for the detached runner; the worktree setup hook already handles `.venv` symlinks. Probe in migration step 4.
- R-d. Gate memoization: string gates are memoized per tracked tree state; a gate that depends on external state (docker daemon, network) may be skipped on an unchanged tree. Use `acceptance.verify` (not `gate`) for those and keep typed gates (never memoized) for report classification. **[doc]**
- R-e. Package agent hot-reload: agent catalog refreshes at session start/reload and after management mutations; file edits and generator applies need `/reload` **[doc]**.
- R-f. `wf-fact-checker` needs pi-web-access tools in the child → background only; a foreground `async:false` launch fails **[doc]**. Scripts launch async by default, so this only bites direct `/run`.
- R-g. Sidecar drift: `.gates.json`, plan.json and the markdown step can disagree. `validate-plan.sh` requires sidecar `gates`/`coverage` to equal plan.json's and every executed gate id to appear in the step file. It does not compare command text against the markdown; the fact-checker does. The sidecar is what the runtime executes; the markdown is what humans read.
- R-h. `structured_output` size: acceptance report folded in with `report:"on"`; large `gates[]` plus report may hit provider tool-argument limits. Keep `note` fields short; logs go to files.
- R-i. `agentContract` is one sentence in the docs; not used here.
- R-j. `/prompt-workflow` `chain:` is linear and untyped; do not build the pipelines on it.
- R-k. This design adds 8 agent files, 6 workflow files, ~7 scripts, 1 skill, 1 generator. The parent must know the mapping; the `coordinator` skill table and the `/…` prompts are the only thing preventing improvised `subagent(...)` calls from returning. `modelScope` catches model drift; the generator's dry-run catches binding drift; nothing catches agent-name drift except the unknown-agent launch error.
- R-l. **Fast-tier routability regression.** pi-subagents has no cross-model fallback; if OpenRouter stops routing `deepseek-v4.1-flash` under the account's privacy setting, `wf-flash-worker` (already disabled by default) cannot be enabled until the user runs `--override-tier fast=… --apply` (now persists across runs, §3.2.1). `scout` is unaffected — it is hand-pinned to haiku, not on this tier. Mitigation: the routability probe is a listed verify step (§5 steps 2, 12) and a one-line `--print` command.
- R-m. **Generator state file.** Drift detection depends on `~/.pi/agent/tier-overrides.state.json`; if it is deleted, the next run classifies every differing value as `drift` and refuses `--apply` (safe direction, but noisy). If `settings.json` is edited by another tool (`subagent({action:"disable"})`, a future pi-subagents version, a profile load) the generator only ever sees its own two keys per agent, so collateral damage is bounded to `model`/`thinking`.
- R-n. **Merged `wf-synthesizer`.** One body serving spec mode and plan mode risks a diluted role prompt — the §2.3 failure in miniature. Mitigation: the mode-specific knowledge stays in the `specifier` and `planner` skills (loaded per run), and the body is a short frontier-synthesis contract; if quality suffers, split back into `wf-specifier` (+1 agent) — the aliases already exist.
- R-o. **Builtin `worker` as the standard-tier implementer** depends on per-run `skill: "step-contract"` being passed by every script and prompt that dispatches it; a direct `subagent({agent:"worker"})` from the parent will not carry the contract. Accept (ad-hoc dispatch is meant to be ad-hoc) or eject `worker` into a package agent later.
- R-p. **Personal-policy consistency.** AGENTS.md's "All-Anthropic by default; DeepSeek/OpenAI only when explicitly requested" and "never run sonnet-5 above medium" are separate personal policies the tier table must stay consistent with. The fast row naming DeepSeek is the explicit request for the *tier*; each session that dispatches `wf-flash-worker` must still be something the user turned on (it is disabled until then). Not resolved here; surfaced so the AGENTS.md wording can be reconciled when step 1 runs.
- R-q. **Hooks that write after a run ends crash headless runs.** pi-edit-hooks ≤ `a1c9cc2` delivered `onStop` with a deferred `pi.sendMessage` after `agent_end`; in `pi --print` and pi-subagents runners the session was already disposed, so the runner threw "extension ctx is stale" and exited 1 after the worker had committed (observed 2026-09-25: both `execute-wave.js` lanes reported FAIL). Fixed in pi-edit-hooks `679ac1d` (`agent_before_settle`, pi ≥0.87). The e2e fixture commits a `.pi/edit-hooks.json` so every worker run exercises this path. Any extension loaded into children must finish its writes before the run settles.
- R-r. **pi-subagents API drift.** 0.74.0 removed `workflowScript`/`workflowScriptPath` (now `workflow: true | "<path>"`) between two sessions of this migration. `tests/e2e/` re-runs the pipelines against the installed version in an isolated `PI_CODING_AGENT_DIR`; run it after every pi or pi-subagents upgrade.
- R-s. **Ledger timing.** Reviewers run before the parent writes the step's ledger rows, so a reviewer that audits PROGRESS.md instead of the worker's STEP-VERDICT reports false gaps (observed in the 2026-09-25 wave run). `wf-step-reviewer` audits STEP-VERDICT fields only.
