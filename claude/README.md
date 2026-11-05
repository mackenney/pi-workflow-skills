# Claude Code variants

Claude Code–native versions of the ten pipeline skills (`claude/skills/`) and the role agents they
dispatch (`claude/agents/`). The pi originals under `skills/`, `agents/` and `workflows/` stay the
source of truth for pi and are never linked into `~/.claude`.

Install: `./claude-install.sh` (links `claude/skills/*` → `~/.claude/skills/`, `claude/agents/*.md`
→ `~/.claude/agents/`; `--dir <path>` for another target, `--uninstall` to remove). It replaces links
an older version of the script made to the pi originals. No copy is involved: links point into this
checkout, so edits apply at once (skills reload live; agents on the next session). For one session
without touching `~/.claude`, `claude --add-dir <dir>` loads `<dir>/.claude/skills` and
`<dir>/.claude/agents`, where those are symlinks into `claude/` (how every live run in
`PORTABILITY.md` §6 loaded them). `permissions.additionalDirectories`
grants file access only and loads neither. A plugin would also read in place, but prefixes every
name (`plugin:wf-worker`), which every `subagent_type` here would have to follow.

## What is different from pi

This is a best-effort port. pi enforces the pipeline at runtime; Claude Code has no equivalent, so
prose steering replaces enforcement and the guarantees are weaker.

| pi mechanism | Claude Code variant | Guarantee lost |
|---|---|---|
| `workflows/*.js` sandbox (deterministic dispatch, loops, retries) | The main session follows a numbered procedure in the skill (`Main session procedure` sections) | Control flow is model-followed, not code-enforced; a step can be skipped or reordered |
| `acceptance.verify[]` host-run gates | The main session runs the sidecar gates itself through Bash (`claude/scripts/gates.sh`, with the sidecar's sha256 recorded before dispatch) on the worker's commit, then the reviewer re-runs them | The orchestrator may forget; there is no runtime refusal of a PASS |
| `outputSchema` / `structured_output` | Last-message fenced blocks (`STEP-VERDICT:` / `REVIEW-VERDICT:` + ` ```gate-report `, `FIX-REPORT:` + ` ```json `), extracted by the main session and checked with `claude/scripts/check-block.sh` | No schema validation at the tool layer; truncation or prose drift is caught only by the `check-block.sh` run |
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
Every dispatching skill states this rule, but it is prose only: fork mode (on by default in recent
Claude Code) lets the model start a fork on its own, and a fork inherits `Agent`. Optional
enforcement: add `"Agent(fork)"` to `permissions.deny` in `~/.claude/settings.json` (or the
project's `.claude/settings.json`). The installer does not touch settings.

The Claude Code `Workflow` tool is not used: it needs per-run opt-in and the user asked for native
single-depth `Agent` dispatch.

## Agents

| Agent | Model / effort | Tools | Preloaded skills | Replaces (pi) |
|---|---|---|---|---|
| `wf-planner` | opus / medium | Read, Grep, Glob, Bash (read-only on the target repo by instruction), Write | step-contract, planner | `wf-planner` (pi gave it grep/find/ls without bash; see note) |
| `wf-synthesizer` | fable / high | Read, Grep, Glob, Bash, Write | specifier, planner, step-contract | `wf-synthesizer` (per-run `skill:` → all three preloaded) |
| `wf-structural-worker` | opus / medium | Read, Grep, Glob, Bash, Edit, Write | step-contract | `wf-structural-worker` |
| `wf-step-reviewer` | sonnet / medium | Read, Grep, Glob, Bash | step-contract | `wf-step-reviewer` |
| `wf-code-reviewer` | opus / medium | Read, Grep, Glob, Bash, Write | code-reviewer | `wf-code-reviewer` |
| `wf-fact-checker` | opus / medium | Read, Grep, Glob, Bash, Write, WebSearch, WebFetch | fact-checker, step-contract | `wf-fact-checker` (`source_check` → WebSearch + WebFetch) |
| `wf-worker` | sonnet / medium | Read, Grep, Glob, Bash, Edit, Write | step-contract | builtin `worker` + `delegate` (standard tier) |
| `wf-scout` | haiku | Read, Grep, Glob, Bash, Write | — | builtin `scout` |
| `wf-researcher` | sonnet / medium | Read, Write, WebSearch, WebFetch | — | builtin `researcher` |

On Linux and macOS, Claude Code gives a subagent `Grep`/`Glob` only when its `tools` list names them
and leaves out `Bash`; every agent here that lists them also lists `Bash`, so it searches with `rg`,
`ls` and `git` through Bash. `wf-planner` has Bash, where its pi original did not, because it runs
the plan validator, `--collect-only`-style test listings and `git log/show` (read-only by
instruction).

Models come from `~/.pi/agent/settings.json` `subagents.agentOverrides` as of 2026-11-03, mapped
fast/standard/deep/frontier → haiku/sonnet/opus/fable. No agent sets `omitClaudeMd`: like pi's
`inheritProjectContext: true`, agents see the project's CLAUDE.md. Unlike pi
(`inheritGlobalContext: false`) they also see `~/.claude/CLAUDE.md`.

## Conventions the skills share

- **Repo path.** Skills locate this repo's scripts with
  `WFS="$(readlink -f "${CLAUDE_SKILL_DIR}/../../..")"` (works whether the skill dir is the symlink
  in `~/.claude/skills` or the real path). Scripts: `"$WFS/scripts/<name>.sh"`. Shell variables do
  not persist between Bash calls, so every command that uses `$WFS` starts with that assignment.
  Never a hardcoded home path.
- **Dispatch.** `Agent` with `subagent_type: "wf-…"`; parallel children are several `Agent` calls
  in one message. Never fork (`subagent_type: "fork"`) during a procedure: a fork inherits `Agent`
  and breaks single depth. Parallel dispatches run in the background; a single dispatch may run in
  the foreground and return inline. Either way, wait for every agent's result before any file or
  gate check; a check before that is not a failure. Notifications always arrive: never schedule
  wakeups, crons or sleep loops while waiting (in `-p` a pending wakeup keeps the process alive
  until it fires). Never pass your own attribution trailer to a child; each agent names its own
  model. Pass paths, not content. Each child writes its detail to a file; the main
  session reads files only as a procedure step requires.
- **Final blocks.** A child's machine-readable result is the last fenced block of its reply,
  preceded by a marker line (`STEP-VERDICT:`, `REVIEW-VERDICT:`, `FIX-REPORT:`, `ENVELOPE:`,
  `NEEDS-DECISION:`). The main session copies the block verbatim into a file in the stage directory
  with the Write tool and checks it with `claude/scripts/check-block.sh` before using it. A missing or invalid block is a failed
  child, never an implied PASS.
- **Stage directories.** Every stage procedure writes `brief.json` (the stage envelope, see the
  `coordinator` skill) into its stage directory; procedures that produce state (executor, review,
  plan) also write `result.json`, as the pi workflows did, so runs stay resumable after `/clear`.
- **Resuming an agent.** `SendMessage` to a finished agent's id resumes it with its own context
  (fix rounds, cross-exam, answers to `NEEDS-DECISION:`). The resumed agent sees it as a message
  from the coordinator. If it is not in the tool list (deferred in some sessions), load it with
  ToolSearch (`select:SendMessage`) before first use. If it fails, re-dispatch a fresh agent with the
  prior result's file path.
- **Helpers.** `claude/scripts/check-block.sh <step-verdict|review-verdict|envelope|fix-report> <file>`
  (schema check, the `outputSchema` stand-in; also rejects a PASS that contradicts its own gates,
  findings or ledger gaps) and `claude/scripts/gates.sh <abs step.md> <commit> <sidecar-sha256> [repo]
  [--stage <dir>] [--wtdir <dir>] [--ignore-sha <hex>]` (runs a sidecar's runnable gates through
  `scripts/run-gates.sh`, the `acceptance.verify` stand-in; fails closed when the sidecar changed
  since its hash was recorded, has no runnable gate, HEAD is not the commit, the ignore rules
  changed, or the repo is not clean). `gates.sh --clean <abs planDir> [repo] [--stage] [--wtdir]
  [--ignore-sha]` is the one clean-tree definition: untracked files count whatever the user's git
  config, as do assume-unchanged/skip-worktree edits and self-ignoring `.gitignore` files, except
  the plan dir, untracked sibling plan dirs, the stage dir and lane worktrees under `--wtdir`.
  Ignored files are never checked, so gate by-products must be ignored (`byproducts` lists likely
  ones; the executor recommends `.git/info/exclude`), and `ignoreSha` hashes `.git/info/exclude`
  and `core.excludesFile` so a worker cannot ignore its own files. Plan-dir edits are caught by the
  executor's `planSha`, not here. Both
  scripts print one JSON object and exit 0, also when `node` or coreutils are missing. Run `gates.sh` with Bash `timeout: 600000` (or in the background) and wait for its
  output; see the `executor` skill.
- **Questions.** Only the main session talks to the user (`AskUserQuestion` is not available to
  subagents).
- **Lane worktrees** live under the `wtdir` input, else `<repo>/.wt/` if present, else
  `<repo>/.worktrees/` if present, else the executor asks (recommending `.wt/`); ignored through
  `.git/info/exclude`, on `lane/<step>` branches.
- **Headless runs.** `claude -p --output-format stream-json` emits one `result` event per
  main-session turn (each background-agent notification starts a turn); the outcome is the last.
- **`rm` in gates.** Even under `bypassPermissions`, a subagent's `bash -c` script containing `rm`
  can be denied by a safety check, so gate commands avoid `rm` (`gates.sh` is not affected).

## Verification status

See `PORTABILITY.md` §6 for what was smoke-tested and what was not.
