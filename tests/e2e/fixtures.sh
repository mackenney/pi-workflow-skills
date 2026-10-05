#!/usr/bin/env bash
# Recreate the toy fixtures under $FX (default /tmp/pi-wf-fx). Idempotent: wipes and rebuilds.
#   $FX/wavetoy        git repo (calc.py), clean, .gitignore for __pycache__
#   $FX/wave-plan      two independent atomic steps (add, mul) + sidecars + PROGRESS.md
#   $FX/spec/SPEC.md   small spec for plan-factcheck-fix.js against wavetoy (after the wave)
set -euo pipefail
FX="${FX:-/tmp/pi-wf-fx}"
G=(-c user.email=e2e@test -c user.name=e2e)
rm -rf "$FX" && mkdir -p "$FX/wavetoy" "$FX/wave-plan" "$FX/spec"
cd "$FX/wavetoy" && git init -q -b main
printf 'def sub(a, b):\n    return a - b\n' > calc.py
printf '__pycache__/\n' > .gitignore
# Exercises pi-edit-hooks onStop in every child that edits Python (regression: stale-ctx crash).
mkdir -p .pi && printf '{"onStop":{"*.py":"python3 -m py_compile {files}"}}\n' > .pi/edit-hooks.json
git add -A && git add -f .pi/edit-hooks.json && git "${G[@]}" commit -qm init
if [ "${WITH_WAVE:-0}" = 1 ]; then  # state after the wave: add.py + mul.py committed
  printf 'def add(a, b):\n    return a + b\n' > add.py; printf 'def mul(a, b):\n    return a * b\n' > mul.py
  git add add.py mul.py && git "${G[@]}" commit -qm "add add() and mul()"
fi
BASE=$(git rev-parse HEAD)
P="$FX/wave-plan"
step() { # id file fn op expect
  cat > "$P/$1.md" <<MD
# Step $1
Create \`$2\` at the repo root defining \`$3(a, b)\` returning \`a $4 b\`. Touch no other file.
## Acceptance
- \`g-unit-1\`: \`python3 -c "from ${2%.py} import $3; assert $3(2,3)==$5"\` passes.
MD
  # Every gate class needs a verdict (step contract); the toy has one real gate and declares the rest n/a.
  jq -n --arg s "$1" --arg b "$BASE" --arg f "$2" --arg c "python3 -c \"from ${2%.py} import $3; assert $3(2,3)==$5\"" --arg r "$3 result" '
    {step:$s,tier:"standard",base_commit:$b,files:[$f],
     gates:(["build","static","integ","e2e-smoke","regress"] | map({id:("g-"+.+"-1"),class:.,result:"n/a",reason:"toy repo has no \(.) gate"})
            + [{id:"g-unit-1",class:"unit",cmd:$c}]),
     coverage:[{row:$r,gate:"g-unit-1"}],hard_splits_declared:[]}' > "$P/$1.gates.json"
  jq -s '{id:.[0].step,tier:.[0].tier,files:.[0].files,gates:.[0].gates,coverage:.[0].coverage,hard_splits_declared:[]}' "$P/$1.gates.json" > "$P/$1.plan-entry.json"
}
step step-01-add add.py add + 5
step step-02-mul mul.py mul '*' 6
jq -s '{steps:.}' "$P"/step-0*.plan-entry.json > "$P/plan.json" && rm "$P"/*.plan-entry.json
cat > "$P/PROGRESS.md" <<'MD'
# Progress

## Executor Tier
standard

## Decisions taken

## Pending decisions (human)

## Tech debt / deferred gates
| Gate | Class | Owed by | Reason deferred | Status |
|------|-------|---------|-----------------|--------|

## Disabled/softened checks
| Check | Where | Why | Status |
|-------|-------|-----|--------|

## Steps
- [ ] [step-01-add](./step-01-add.md) — add()
- [ ] [step-02-mul](./step-02-mul.md) — mul()
MD
cat > "$FX/spec/SPEC.md" <<MD
# Spec: calc CLI

Repo: $FX/wavetoy (Python 3, stdlib only, modules \`add.py\`, \`mul.py\`, \`calc.py\` (defines \`sub\`) at the repo root).

## MUST
1. \`div(a, b)\` in \`div.py\` at the repo root returns \`a / b\`; raises \`ZeroDivisionError\` with message "division by zero" when \`b == 0\`.
2. \`cli.py\` at the repo root: \`python3 cli.py <op> <a> <b>\` with op in {add, sub, mul, div} prints the result to stdout and exits 0. Unknown op → message on stderr, exit 2. Division by zero → message on stderr, exit 1. Wrong arity or non-numeric operand → stderr, exit 2.
3. Tests with stdlib \`unittest\` under \`tests/\`, runnable with \`python3 -m unittest discover -s tests\`.

## Out of scope
Packaging, float formatting, argparse help text.
MD
echo "fixtures ready in $FX (base $BASE)"
