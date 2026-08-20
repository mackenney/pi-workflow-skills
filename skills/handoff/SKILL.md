---
name: handoff
description: Produces a handoff artifact and a short copy-pasteable message so work can resume in a clean context, continuing the current workstream by default or steered by whatever focus is given at invocation. Use before /copy plus /new, a phase or agent-role boundary, or a worktree/subagent handoff.
---

# Handoff Skill

You are producing a **handoff**: a deliberate compaction of the current session into one
artifact with a clear objective, so a continuation (yourself with fresh context, or a
different agent) can pick up work without re-deriving anything you already know. This is
not a status update — it's the load-bearing document the next context will treat as ground
truth for "what happened" and a starting point (not a substitute) for "what to verify."

**When this runs:** context is getting crowded, a phase boundary is reached (investigation
done, plan done, execution interrupted, review requested), you're about to `/copy` then
`/new`, you're spinning off a worktree/subagent for someone else to continue, or you're
told to cancel/stop and hand off.

## Step 0 — Establish Intent (ask only if genuinely ambiguous)

**Default (bare `/skill:handoff`, no extra text): continuation mode.** Produce a file +
a short copy-pasteable message whose sole job is letting the *same workstream* continue
in a clean context via `/copy` then `/new` — no new direction, no scope change, just
state + next steps as already understood. This is the default and the common case;
don't ask for clarification to reach it.

**Any text accompanying the invocation is a strong signal of intended focus, not a**
**mode toggle.** `/skill:handoff` alone → pure continuation. `/skill:handoff, focus the
next steps on X` or `/skill:handoff for the reviewer, skip Y, this reverses Z` → still
produces the same file + message pair, but the Objective and Next Steps sections are
steered by that text near-verbatim rather than left to your own inference. Treat it as
the stated objective, don't paraphrase it away, and don't invent additional direction
beyond what was actually said.

The distinction that matters for the artifact's content is how much *direction* was
given, not whether a different agent/role is involved — a same-role continuation with
explicit new focus still gets an explicit Objective statement; a role handoff with no
extra text still defaults to "continue exactly this." Ask only if the accompanying text
is genuinely ambiguous about what should happen next (e.g. contradicts the current plan
without saying which one wins).

## Step 1 — Orient (cheap, no subagents)

You hold the context; a subagent does not — do not delegate the writing of this document.
Gather what you don't already have in-session:

- `git status`, `git log --oneline -10`, current branch/worktree path
- Whether a plan/progress file already exists for this work (`plans/**`, `PROGRESS.md`,
  `HANDOFF*.md`) — if one exists, this handoff **supersedes or extends** it, it doesn't
  duplicate it
- Any uncommitted changes — flag prominently if present, they are the single most common
  thing a next agent silently loses

## Step 2 — Pick the Artifact Location (respect existing convention)

Check for an existing convention before inventing one:
- If the repo already has `HANDOFF.md` / `plans/<slug>/HANDOFF.md` usage, or a stated
  "don't commit plans/investigation docs" rule, or a `.gitignore` entry for these files —
  follow it.
- No convention found → default: `plans/<slug>/HANDOFF.md` if a plan directory exists for
  this work, else `/tmp/<short-topic>-handoff.md` for throwaway/cross-session use.
- Treat the file as an **untracked dev artifact** by default (gitignored or `/tmp`), not a
  permanent repo doc, unless the user asks for a committed/shareable version.
- If a prior `HANDOFF.md` already exists for this exact work, don't silently overwrite it:
  either update it in place with a clear "superseded" banner, or write a new
  version-suffixed file (`HANDOFF-REPLAN.md`, `HANDOFF-VERIFY-2.md`) that states what it
  supersedes and why. Never leave two contradictory handoffs for the same scope without a
  pointer between them.

## Step 3 — Write the Artifact

Required sections, in this order. Omit a section only if genuinely empty — don't pad.

```markdown
# Handoff: <topic>

## Objective
<What the NEXT agent is supposed to accomplish. Default: continue the current
workstream exactly as understood. If extra focus/direction was given at invocation,
state that adjusted goal explicitly here — never left implicit in the narrative below.
If this reverses or narrows a prior handoff/plan, say so in one line up front.>

## State
<Branch/worktree/commit. What's done, with commit refs where possible. Don't restate
the whole session — just what a resuming agent needs to trust as already-true.>

⚠️ Uncommitted changes: <list, or "none">

## Next Steps
<Prioritized, ordered list. Not a wishlist — the actual next actions.>

## Open Questions / Known Gaps
<Carry verbatim, don't invent resolutions the user hasn't given. Mark clearly if
something was deliberately deferred vs. simply not reached.>

## Gotchas / Traps
<Anything the next agent would otherwise waste time rediscovering: env setup quirks,
false leads already ruled out, access patterns, files that look relevant but aren't.>

## Key Files
<file: one-line purpose, only the ones that matter>

## Boundaries
<Worktree/repo scope: where the next agent may write, and anything explicitly
off-limits (e.g. "read-only — .wt/other-agent is a different agent's worktree").>

## Verification Instruction
Do not trust the State/Next Steps above blindly — re-verify load-bearing claims
(test results, "already fixed" claims, environment assumptions) before building on them.
```

Calibrate length to the work: a single-bug continuation is a few short bullets per
section; a multi-track investigation handoff feeding several downstream subagents is
denser. Default to complete-but-not-verbose — err short over padded.

## Step 4 — Produce the Copy-Paste Message (default output, not optional)

Always pair the file with a short standalone message, unless the target is a direct
subagent/coordinator dispatch rather than a human `/copy` + `/new`. The message is what
the user pastes into the fresh session/context to resume — that's the whole point of
the default continuation case, so don't skip it:

```
Handoff written to: <path>

<3-6 line executive summary: objective + the one or two things the next agent must not
miss (uncommitted changes, a reversed direction, a hard blocker). Point to the file for
everything else — don't duplicate the file's content here.>
```

If it's a direct subagent/coordinator dispatch instead of a human paste, skip the
standalone message — just point the dispatch task at the file path plus the one-line
objective.

## Anti-Patterns

- Writing a narrative transcript of the session instead of a structured, next-action-
  oriented document.
- Letting "what happened" bury "what to do" — Objective and Next Steps must be scannable
  in isolation from the rest.
- Silently answering open questions the user hasn't actually resolved.
- Skipping the distrust/re-verify instruction — handoffs get treated as ground truth by
  default; you must explicitly counter that.
- Overwriting a prior handoff for the same scope without a supersession note.
- Committing a throwaway dev artifact into repo history without being asked to.
