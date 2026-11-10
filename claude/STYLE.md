# Style for the Claude Code variants

How `claude/skills/*/SKILL.md` and `claude/agents/*.md` are written. Other documents own the rest:
- the `description` field: `SPEC.md` (root);
- what a pi skill keeps and what moves to workflows, agents and scripts: `ORCHESTRATION-ENCODING.md`;
- runtime conventions (`$WFS`, dispatch, final blocks, stage dirs, helpers): `README.md`, "Conventions the skills share".

`tests/scripts.d/claude-scripts.sh` checks the frontmatter rules marked *(tested)*.

## Frontmatter

- **Skills:** `name` (the directory name), `description`, optional `user-invocable`. **Agents:** `name` (the file name), `description`,
  `tools`, `model`, `effort`, optional `skills`, in that order. *(tested)*
- `description` is one line, 150–300 characters *(tested)*, and follows `SPEC.md`. An agent's description
  starts with its tier ("Deep-tier …"). It must parse as strict YAML *(tested)*: quote the value when it
  contains `: ` or ` #`; otherwise use a dash instead of a colon.
- `effort` follows the tier: fable `high`, opus and sonnet `medium`, haiku `low` *(tested)*. Never set sonnet
  above `medium`; move the work to opus instead.

## Skill body

- Start with `# <Name> Skill` and one paragraph: what it produces and who runs it (the main session, a
  `wf-*` child in stage mode, or both).
- Then the sections the skill needs, in this order: when to use it; inputs, flags and setup; the
  procedure; templates and role sections; stage mode; failure handling; reporting. A skill without one of
  these leaves it out; it does not add an empty heading.
- **`Main session procedure`** names only steps the orchestrating session runs. Agents that preload the
  skill are told to ignore those sections, so nothing a child must do goes there. A procedure that
  replaces a pi workflow says so in its heading: `## Main session procedure — <what> (was \`workflows/<x>.js\`)`.
- **Roles** for children are `## <Role> role` sections, with the reply format the child must produce.
- **Stage mode** is `### Stage mode (coordinator)` at the end of the procedure, or `## Stage mode (coordinator)`
  when the skill has no main-session procedure. It names the agent, the detail file, the `ENVELOPE:` block,
  `check-block.sh envelope` and the single retry.

## Procedure steps

- Number steps, prefixed by the procedure letter where a skill has several (`A1`, `B.7.2`). Bold the step
  title; mark a step whose outcome can stop the run with **(gate)**.
- Every gate outcome names three things: the state (`PASS`, `FAIL`, `BLOCKED`, `FIXED_UNREVIEWED`,
  `NEEDS-DECISION`), the `stage`, and where to resume (`resumePoint.from`) or what the human must
  decide. A check with no stated outcome is unfinished.
- Put the reason text a run reports in double quotes ("sidecar drifted from plan.json"). Use the same
  wording as the pi workflow when one exists, so a reader can match the two.
- Fail closed. A missing or invalid final block, unparseable script output or a contradictory PASS is a
  failed child, never an implied PASS. A worker reporting a wrong or impossible gate is `FAIL` with the
  reason under `pending_decisions`.
- Check inputs before the first dispatch. In stage mode a bad input is a `blocked` brief; standalone,
  ask the user.
- Commands are complete and copyable: the `WFS=` assignment, absolute paths, the Bash `timeout` where a
  script can run long. Never a fixed `/tmp/<name>`; scratch goes in `mktemp -d`.

## Agent body

- First sentence: ``You are `wf-<name>`: <one job>.`` A multi-mode or general agent says instead that
  its task names the mode or the job. Then what the task gives it and what it reads first.
- Every agent says it is a leaf: "You are a leaf agent: you cannot dispatch other agents and must not
  try."
- Every agent with `Bash` carries the exit-code rule word for word: "Run every command whose exit code
  you judge as `cmd >"$d/log" 2>&1; echo rc=$?` (`d=$(mktemp -d)`), then read the log: through a pipe
  (`| tail`, `| grep`) you get the last command's exit code, not `cmd`'s." Logs never go to a
  relative path: inside the repo they are dirt for the clean-tree check.
- Agents that edit the repo also state the repo-state rules: stay on the given branch (no checkout of a
  sha, no `git stash`) and never edit ignore files or git config.
- End with a "Final output" paragraph: the file the child writes, and the marker line plus fenced block
  it ends with (`STEP-VERDICT:`, `REVIEW-VERDICT:`, `FIX-REPORT:`, `ENVELOPE:`, `NEEDS-DECISION:`). An
  agent whose final block depends on the task (`wf-worker`) says so in its first paragraph instead.
- Vocabulary lives in the preloaded skills. An agent file states the role and the rules that differ
  per role; keep it under 30 lines.

## Wording

- Imperative and present tense: "Block", not "should block".
- State each rule once and refer to it by section name ("Setup, "Envelope"") instead of restating it.
- Capitals for verdict and step states (`BLOCKED`); lower case for envelope `status` (`blocked`).
- Identifiers, paths, flags and literal values in backticks.
- A deliberate difference from pi goes in the README table "Behaviour that differs from pi on purpose".
  In the skill, add "(pi: …)" only where a reader who knows pi would otherwise follow pi.
- No section-separator comments, no filler, no restating what a heading already says.
