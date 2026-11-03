# Claude Code variants

Claude Code–native versions of the ten pipeline skills (`claude/skills/`) and the role agents they
dispatch (`claude/agents/`). The pi originals under `skills/`, `agents/` and `workflows/` stay the
source of truth for pi and are never linked into `~/.claude`.

Install: `./claude-install.sh` (links `claude/skills/*` → `~/.claude/skills/`, `claude/agents/*.md`
→ `~/.claude/agents/`; `--dir <path>` for another target, `--uninstall` to remove). It replaces links
an older version of the script made to the pi originals.

## What is different from pi

This is a best-effort port. pi enforces the pipeline at runtime; Claude Code has no equivalent, so
prose steering replaces enforcement and the guarantees are weaker.

| pi mechanism | Claude Code variant | Guarantee lost |
|---|---|---|
| `workflows/*.js` sandbox (deterministic dispatch, loops, retries) | The main session follows a numbered procedure in the skill (`Main session procedure` sections) | Control flow is model-followed, not code-enforced; a step can be skipped or reordered |
| `acceptance.verify[]` host-run gates | The main session runs the sidecar gates itself through Bash (`scripts/run-gates.sh`) on the worker's commit, then the reviewer re-runs them | The orchestrator may forget; there is no runtime refusal of a PASS |
| `outputSchema` / `structured_output` | Last-message fenced blocks (`STEP-VERDICT:` / `REVIEW-VERDICT:` + ` ```gate-report `, `FIX-REPORT:` + ` ```json `), extracted by the main session and checked with `jq` | No schema validation at the tool layer; truncation or prose drift is caught only by the `jq` check |
| typed `gate:` on a child (validate-plan, classify-*) | The main session runs the same script through Bash after the child returns | Same scripts, but the decision to run them is prose |
| `contact_supervisor` `need_decision` (child blocks until answered) | Child stops and ends with a `NEEDS-DECISION:` block; the main session asks the user, then resumes the child with `SendMessage` (or re-dispatches) | The child does not pause mid-work; it ends and is resumed |
| `resume` of a retained child (fix rounds, cross-exam) | `SendMessage` to the finished agent (Claude Code resumes it in the background); fresh dispatch with the prior verdict as fallback | Resume ids are session-local; after `/clear` only the fresh-dispatch fallback works |
| `worktree: true` lanes on `pi-subagents/<key>-…` branches | The main session creates one `git worktree` per lane on a `lane/<step>` branch from the wave base, and tells the worker to work there | Isolation is by instruction (absolute paths, `cd`), not by sandbox |
| `modelScope`, cross-vendor lanes (GPT, DeepSeek) | Dropped. The "diversity" review angle runs on `sonnet` next to `opus` angles | Vendor diversity is gone; only model-size diversity remains |
| `wf-flash-worker` (fast tier) | Dropped (disabled in pi). The `fast` executor tier is not available | — |
| `wf-host-command` (model-free script runner) | Dropped. The main session runs `scripts/*.sh` through Bash | — |
| Ledger written only by `ledger-apply` from typed verdicts | Unchanged: the main session pipes the extracted verdict JSON into `scripts/ledger-apply.sh` | The "no model edits ledger rows" rule is prose for the main session |
| `terminal-gate` | Unchanged script, run through Bash | — |
| Tier → model via `agentOverrides` | `model:` + `effort:` written into each agent file | Re-binding a tier means editing the agent files |

Single-depth delegation: the main session that runs a skill is the only dispatcher. No agent in
`claude/agents/` lists the `Agent` tool, so subagents cannot spawn subagents (Claude Code allows
nesting by default). Every pi flow with sub-sub-agents is flattened into main-session stages. The
skills use only these agents, never the built-in `general-purpose`, whose tools include `Agent`.

The Claude Code `Workflow` tool is not used: it needs per-run opt-in and the user asked for native
single-depth `Agent` dispatch.

## Agents

| Agent | Model / effort | Tools | Preloaded skills | Replaces (pi) |
|---|---|---|---|---|
| `wf-planner` | opus / medium | Read, Grep, Glob, Bash (read-only by instruction), Write | step-contract, planner | `wf-planner` (pi gave it grep/find/ls without bash; see note) |
| `wf-synthesizer` | fable / high | Read, Grep, Glob, Bash, Write | specifier, planner, step-contract | `wf-synthesizer` (per-run `skill:` → all three preloaded) |
| `wf-structural-worker` | opus / medium | Read, Grep, Glob, Bash, Edit, Write | step-contract | `wf-structural-worker` |
| `wf-step-reviewer` | sonnet / medium | Read, Grep, Glob, Bash | step-contract | `wf-step-reviewer` |
| `wf-code-reviewer` | opus / medium | Read, Grep, Glob, Bash, Write | code-reviewer | `wf-code-reviewer` |
| `wf-fact-checker` | opus / medium | Read, Grep, Glob, Bash, Write, WebSearch, WebFetch | fact-checker, step-contract | `wf-fact-checker` (`source_check` → WebSearch + WebFetch) |
| `wf-worker` | sonnet / medium | Read, Grep, Glob, Bash, Edit, Write | step-contract | builtin `worker` + `delegate` (standard tier) |
| `wf-scout` | haiku | Read, Grep, Glob, Bash, Write | — | builtin `scout` |
| `wf-researcher` | sonnet / medium | Read, Write, WebSearch, WebFetch | — | builtin `researcher` |

`Grep` and `Glob` are listed for builds that have them; the Claude Code build tested here (2.1.317)
has neither and drops them silently, so every agent that must search the repo also has `Bash`
(`rg`, `ls`, `git`). That is why `wf-planner` has Bash where its pi original did not.

Models come from `~/.pi/agent/settings.json` `subagents.agentOverrides` as of 2026-11-03, mapped
fast/standard/deep/frontier → haiku/sonnet/opus/fable. No agent sets `omitClaudeMd`: like pi's
`inheritProjectContext: true`, agents see the project's CLAUDE.md. Unlike pi
(`inheritGlobalContext: false`) they also see `~/.claude/CLAUDE.md`.

## Conventions the skills share

- **Repo path.** Skills locate this repo's scripts with
  `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"` (works whether the skill dir is the symlink
  in `~/.claude/skills` or the real path). Scripts: `"$WFS/scripts/<name>.sh"`. Never a hardcoded
  home path.
- **Dispatch.** `Agent` with `subagent_type: "wf-…"`; parallel children are several `Agent` calls
  in one message. Pass paths, not content. Each child writes its detail to a file; the main
  session reads files only as a procedure step requires.
- **Final blocks.** A child's machine-readable result is the last fenced block of its reply,
  preceded by a marker line (`STEP-VERDICT:`, `REVIEW-VERDICT:`, `FIX-REPORT:`, `ENVELOPE:`,
  `NEEDS-DECISION:`). The main session copies the block verbatim into a file in the stage directory
  with the Write tool and checks it with `jq` before using it. A missing or invalid block is a failed
  child, never an implied PASS.
- **Stage directories.** Every procedure writes `brief.json` (the stage envelope, see the
  `coordinator` skill) and `result.json` into its stage directory, as the pi workflows did, so runs
  stay resumable after `/clear`.
- **Resuming an agent.** `SendMessage` to a finished agent's id resumes it with its own context
  (fix rounds, cross-exam, answers to `NEEDS-DECISION:`). It can be a deferred tool: load it with
  ToolSearch (`select:SendMessage`) before first use. If it fails, re-dispatch a fresh agent with the
  prior result's file path.
- **Helpers.** `claude/scripts/check-block.sh <step-verdict|review-verdict|envelope|fix-report> <file>`
  (schema check, the `outputSchema` stand-in) and `claude/scripts/gates.sh <step.md> <commit> [repo]`
  (runs a sidecar's runnable gates through `scripts/run-gates.sh`, the `acceptance.verify` stand-in).
  Both print one JSON object and exit 0.
- **Questions.** Only the main session talks to the user (`AskUserQuestion` is not available to
  subagents).

## Verification status

See `PORTABILITY.md` §6 for what was smoke-tested and what was not.
