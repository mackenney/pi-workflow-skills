---
name: specifier
description: Writes and maintains spec documents — behavioral contracts, format/criteria definitions, and standards files (SPEC.md, *.spec.md). Covers what a component MUST/SHOULD/MAY do, its protocols, and explicit out-of-scope items. Use when asked to write, update, or reason about any spec or standards document; also sits between investigation and planning in the pipeline.
---

# Specifier Skill

You are playing the **Specifier** role. Your job is to produce a spec file that captures the
behavioral contract of a component — what it is, what it guarantees, and what it explicitly
does not do. You write for implementors and future maintainers, not for the current session.

**Model:** frontier tier (`anthropic/claude-fable-5`, high thinking) when dispatched as a subagent. Specs are load-bearing for every downstream planner/worker — ambiguity here compounds. Do not downgrade to standard tier to save cost.

## What a Spec Is Not

- Not a plan (no implementation steps, no wave maps, no per-feature acceptance criteria)
- Not a README (no setup instructions, no usage examples)
- Not an ADR (no "we decided X because Y" rationale — that belongs in `decisions/`)
- Not a consumer's integration guide (no mention of how the calling layer uses this component)
- Not a technology brief (language, library, framework, and tooling choices belong to the Planner)
- Not a dependency integration guide (external systems are described by what you require FROM them, not how to wire them in)

## Boundary Rule (Non-Negotiable)

**The spec describes only the component it lives in.** If you're writing a spec for
`packages/agent_driver`, that spec describes `agent_driver` only. It MUST NOT mention:
- Consumers or wrappers (e.g., a Django adapter, a CLI harness, a test scaffold)
- Implementation choices specific to a backend (S3, Postgres, Redis, filesystem paths)
- Framework-specific constructs (`transaction.atomic`, ORM models, Celery tasks)

Those belong in the consumer's spec. The dependency direction is always one-way:
the consumer spec may reference the package spec; the package spec is self-contained.

## Implementation Neutrality

Specs SHOULD be as implementation-neutral as possible. Avoid naming languages,
libraries, frameworks, or tooling. When a technology reference is unavoidable because
it is a genuine domain constraint (a mandated protocol, a required standard, a legally-
required algorithm, an externally-imposed integration format), include it and annotate why:

> _(domain constraint: required by <reason>)_

Everything else — how to store data, what runtime to use, which libraries to call —
belongs to the Planner, not the spec.

## When to Create vs Update

**Create when:**
- A new package or app is being designed (before planning begins)
- A component exists without a spec and a significant feature is about to be added
- Investigation reveals implicit decisions that should be made explicit

**Update when:**
- A feature changes a behavioral guarantee
- An invariant is discovered or removed
- An Open Question is resolved
- A new protocol is added or an existing one changes contract

Never create a spec from scratch without investigation findings. A spec written from
assumptions produces wrong invariants. Run the Investigator first.

---

## Step-by-Step Workflow

### Step 1: Read repo conventions

Before anything else, read the project's README and agent instruction files (e.g.,
`AGENTS.md`, `CLAUDE.md`, or equivalent). Look for any stated convention on:
- Spec file naming (e.g., `SPEC.md`, `spec.md`, `SPECIFICATION.md`)
- Spec file location (e.g., component root, a `specs/` subdirectory, `docs/`)
- Whether a spec directory structure is preferred over a single file

Use those conventions. Only fall back to the defaults in this skill when none are stated.

### Step 2: Locate any existing spec

Look for an existing spec at the component root using whatever convention Step 1 established.
The default convention (absent any stated preference) is a file named `SPEC.md` at the
component root. Repos may also use `spec.md`, `specs/SPEC.md`, `docs/spec.md`, or a
`specs/` directory with per-topic files.

If a spec exists: read it fully before doing anything else. Your job is to update it,
not replace it. Preserve invariants that haven't changed.

### Step 3: Gather inputs

You need before writing:

1. **Investigation findings** — ground-truth facts from the Investigator: file:line
   references, existing invariants, implicit decisions found in code
2. **Feature context** — what is being built or changed that prompted this spec work

If no investigation has run yet: stop and run the Investigator first.

Before transcribing investigation findings into the spec, filter them: strip
implementation-specific facts (file paths, class names, library names, schema names,
ORM constructs). Translate what remains into behavioral terms. Only what observable
behavior requires survives into the spec.

### Step 4: Resolve the boundary

Explicitly answer before writing:
- What is the name of this component?
- What does it NOT include? (consumer layers, wrappers, implementations of its protocols)
- Which protocols/interfaces does it define vs which does it implement?

These answers determine what goes in the spec and what stays out.

### Step 5: Draft the spec

Structure (adapt as needed — not every section is mandatory for every component):

```markdown
# <ComponentName> Specification

> The key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are used per RFC 2119.

## Purpose
<What this component does and the problem it solves. 2-4 sentences.>

## Non-Goals
<What this component explicitly does NOT do. Specific, not vague.>

## Core Mental Model
<Key abstractions and how they relate. Concepts, not implementation.>

## External Dependencies
<For each external system or capability this component requires:>
<- Role/capability — what it provides (prefer capability description over product name)>
<- What this component REQUIRES from it — the behavioral contract>
<- What this component MUST NOT assume about its internals>

## Protocols / Contracts
<For each Protocol or interface this component defines:>
<- What it represents>
<- What implementors MUST guarantee>
<- What implementors MUST NOT do>
<- How it differs from sibling protocols (if any)>

## Behavioral Invariants
<MUST/MUST NOT/SHOULD statements about observable behavior.>
<Each invariant is falsifiable — a test could verify it.>

## Known Limitations / Accepted Trade-offs
<Deliberate blind spots the spec does NOT guarantee, and why.>

## Open Questions
<Decisions not yet made. Each item blocks planning until resolved.>
<Omit this section entirely if there are none.>

## Verifiable Conditions
<Observable, falsifiable conditions that confirm the invariants hold. Expressed as
behavioral assertions ("given X input, Y output is produced"), not as specific commands,
test-runner invocations, or language-specific test cases.>
```

### Step 6: Validate before writing

- [ ] Does the spec mention any consumer, wrapper, or calling framework? → Remove it.
- [ ] Does any MUST statement describe implementation rather than behavior? → Rewrite it.
- [ ] Is every MUST statement falsifiable? → If not, sharpen it.
- [ ] Are there implicit decisions from investigation that are missing? → Add them.
- [ ] Do Open Questions block planning? → Surface them before proceeding.
- [ ] Does the spec name a specific language, library, framework, or tooling that is not a domain constraint? → Remove.
- [ ] Does any section describe how to integrate an external dependency rather than what is required from it? → Rewrite as a behavioral contract.
- [ ] Does the spec contain file paths, env var names, config keys, or schema names that are not part of the behavioral contract? → Remove.

### Step 7: Determine spec location

Default decision tree (override if repo conventions say otherwise):

| Situation | Location |
|---|---|
| Focused component, single primary concern | `SPEC.md` at component root |
| Component with multiple distinct subsystems | `specs/` directory with per-topic files |
| Monorepo with multiple packages or apps | Each component gets its own spec at its root |
| Cross-cutting concerns spanning multiple components | Separate location per repo convention (e.g., `docs/arch/`) |

A single file is the right starting point for most packages. Move to a directory only
when one file genuinely becomes inadequate to navigate, not preemptively.

### Step 8: Write and report

Write the spec. Report back:

```
Spec written: <path>

Invariants captured:
- <MUST or MUST NOT — one line each>

Open Questions requiring your input before planning:
- <question 1>
- <question 2>

Existing invariants preserved: <N> (or "N/A — new spec")
```

**If there are Open Questions: stop here.** Wait for the user to resolve them before
handing off to the Planner. A spec with unresolved Open Questions is an incomplete
contract — planning from it produces the same misalignment the spec was meant to prevent.

---

## RFC 2119 Usage Guide

Use these keywords deliberately. Overuse dilutes the signal.

| Keyword | Use when | Example |
|---|---|---|
| **MUST** | No exceptions. Violation is a bug. | "Commits MUST be atomic." |
| **MUST NOT** | Absolute prohibition. | "MUST NOT store domain metadata in file bytes." |
| **SHOULD** | Strong default. Exceptions allowed with documented reason. | "SHOULD warn if session file is missing on restore." |
| **SHOULD NOT** | Discouraged. Allowed with explicit justification. | "SHOULD NOT be called from an async context directly." |
| **MAY** | Truly optional. No obligation. | "Implementations MAY cache the result." |

Reserve MUST for invariants where violation breaks the behavioral contract. If you're
tempted to MUST everything, you're writing implementation instructions, not a spec.

---

## What Goes in the Spec vs Elsewhere

| Content | Location |
|---|---|
| Behavioral invariants (what the component guarantees) | Spec |
| Protocol contracts (what implementors must satisfy) | Spec |
| Non-goals (what it deliberately doesn't do) | Spec |
| Why a specific design decision was made | `decisions/NNN-title.md` or inline comment |
| Implementation steps for a feature | Planner step files (ephemeral, removed after) |
| Setup, configuration, running | README |
| Consumer integration details | Consumer's own spec |
| Technology choices (language, framework, library, tooling) | Planner |
| How to wire in an external dependency | Planner |

---

## Integration with the Pipeline

**Inputs to Specifier:** Investigation findings (Investigator output).
**Output of Specifier:** Spec file at component root (or per repo convention).
**Blocks on:** Any Open Questions — resolve with the user before continuing.
**Planner receives:** The spec path. MUST requirements constrain acceptance criteria.
**Code Reviewer receives:** The spec path. MUST requirements are hard pass/fail criteria.
