#!/usr/bin/env bash
# Model-free tests for scripts/*. Run: bash tests/scripts.test.sh  (exit 0 = all pass)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S="$ROOT/scripts"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { # name expected-jq-expr json
  if printf '%s' "$3" | jq -e "$2" >/dev/null 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: $2"; echo "  got: $3"; fi
}

DEBT='## Tech debt / deferred gates
| Gate | Class | Owed by | Reason deferred | Status |
|------|-------|---------|-----------------|--------|
ROWS_D
## Disabled/softened checks
| Check | Where | Why | Status |
|-------|-------|-----|--------|
ROWS_X'
ledger() { # file deferred-rows disabled-rows steps-block
  local d="${DEBT/ROWS_D/$2}"; d="${d/ROWS_X/$3}"; printf '# P\n\n%s\n\n%s\n' "$d" "$4" > "$1"
}
tg() { echo "{\"planDir\":\"$1\"}" | "$S/terminal-gate.sh"; }

# terminal-gate
mkdir -p "$T/tg"
ledger "$T/tg/PROGRESS.md" "" "" $'## Steps\n- [x] a\n- [X] b'
check "tg: all closed" '.ok == true' "$(tg "$T/tg")"
ledger "$T/tg/PROGRESS.md" "" "" $'## Steps\n- [x] a\n- [ ] b'
check "tg: open step" '.ok == false and .openSteps == ["b"]' "$(tg "$T/tg")"
ledger "$T/tg/PROGRESS.md" "" "" ""
check "tg: no Steps section" '.ok == false and (.errors | index("missing section: ## Steps"))' "$(tg "$T/tg")"
ledger "$T/tg/PROGRESS.md" "" "" "## Steps"
check "tg: empty Steps" '.ok == false and (.errors[0] | test("no checklist"))' "$(tg "$T/tg")"
ledger "$T/tg/PROGRESS.md" "| g | unit | s2 | slow | open |" "" $'## Steps\n- [x] a'
check "tg: open deferred" '.ok == false and (.openDeferred | length) == 1' "$(tg "$T/tg")"
ledger "$T/tg/PROGRESS.md" "| g | unit | s2 | slow | discharged abc1234 |" "| ci | x | flaky | waived by Ignacio 2026-10-02: accepted |" $'## Steps\n- [x] a'
check "tg: discharged + waived" '.ok == true' "$(tg "$T/tg")"
ledger "$T/tg/PROGRESS.md" "| g | unit | s2 | slow | waived: fine |" "" $'## Steps\n- [x] a'
check "tg: malformed waiver" '.ok == false' "$(tg "$T/tg")"
ledger "$T/tg/PROGRESS.md" "| (none) | | | | |" "" $'## Steps\n- [x] a'
check "tg: placeholder row is open" '.ok == false' "$(tg "$T/tg")"
check "tg: missing ledger" '.ok == false' "$(tg "$T/nope")"

# classifiers
echo '{"blockers":[1],"important":[],"refuted":[1,2],"nits":[1]}' > "$T/r.json"
check "classify-review" '.blockers == 1 and .important == 0 and .refuted == 2' "$("$S/classify-review.sh" "$T/r.json")"
check "classify-review missing file" 'has("error")' "$("$S/classify-review.sh" "$T/none.json")"
echo '{"claims":[{"verdict":"CONFIRMED"},{"verdict":"refuted"},{"verdict":"PARTIAL"},{"verdict":"DISPUTED"},{"verdict":"UNVERIFIABLE"}]}' > "$T/f.json"
check "classify-factcheck" '.refuted == 1 and .partial == 1 and .disputed == 1 and .total == 5' "$("$S/classify-factcheck.sh" "$T/f.json")"
echo 'not json' > "$T/bad.json"
check "classify-factcheck bad json" 'has("error")' "$("$S/classify-factcheck.sh" "$T/bad.json")"

# validate-plan
P="$T/plan"; mkdir -p "$P"
GATES='[{"id":"g-build-1","class":"build","cmd":"true"},{"id":"g-static-1","class":"static","cmd":"true"},{"id":"g-unit-1","class":"unit","cmd":"true"},{"id":"g-e2e-smoke-1","class":"e2e-smoke","cmd":"true"},{"id":"g-regress-1","class":"regress","cmd":"true"},{"id":"g-integ-1","class":"integ","result":"n/a","reason":"final step owns it"}]'
COV='[{"row":"default","gate":"g-unit-1"}]'
mkplan() {
  jq -n --argjson g "$GATES" --argjson c "$COV" '{steps:[{id:"step-01-x",tier:"standard",files:["x.py"],gates:$g,coverage:$c,hard_splits_declared:[]}]}' > "$P/plan.json"
  jq -n --argjson g "$GATES" --argjson c "$COV" '{step:"step-01-x",tier:"standard",gates:$g,coverage:$c,hard_splits_declared:[]}' > "$P/step-01-x.gates.json"
  printf '# step-01-x\nGates: g-build-1 g-static-1 g-unit-1 g-e2e-smoke-1 g-regress-1 g-integ-1\n' > "$P/step-01-x.md"
  ledger "$P/PROGRESS.md" "" "" $'## Steps\n- [ ] [step-01-x](./step-01-x.md)'
}
vp() { "$S/validate-plan.sh" "$P/plan.json"; }
mkplan; check "vp: valid plan" '.ok == true' "$(vp)"
mkplan; jq '.steps[0].gates |= map(select(.class != "regress"))' "$P/plan.json" > "$T/x" && mv "$T/x" "$P/plan.json"
check "vp: omitted class" '.ok == false and any(.errors[]; test("regress"))' "$(vp)"
mkplan; jq '.gates[0].cmd = "false"' "$P/step-01-x.gates.json" > "$T/x" && mv "$T/x" "$P/step-01-x.gates.json"
check "vp: sidecar drift" '.ok == false and any(.errors[]; test("differ from sidecar"))' "$(vp)"
mkplan; rm "$P/step-01-x.gates.json"
check "vp: sidecar missing" '.ok == false and any(.errors[]; test("sidecar missing"))' "$(vp)"
mkplan; printf '# step-01-x\nno gate ids here\n' > "$P/step-01-x.md"
check "vp: md omits gate ids" '.ok == false and any(.errors[]; test("does not mention"))' "$(vp)"
mkplan; ledger "$P/PROGRESS.md" "| (none) | | | | |" "" $'## Steps\n- [ ] [step-01-x](./step-01-x.md)'
check "vp: placeholder row" '.ok == false and any(.errors[]; test("placeholder"))' "$(vp)"
mkplan; ledger "$P/PROGRESS.md" "| g-integ-1 | integ | step-09 | slow | open |" "" $'## Steps\n- [ ] [step-01-x](./step-01-x.md)'
check "vp: open deferred row is fine at plan time" '.ok == true' "$(vp)"
mkplan; ledger "$P/PROGRESS.md" "" "" $'## Steps\n- [ ] [step-02-y](./step-02-y.md)'
check "vp: step missing from checklist" '.ok == false and any(.errors[]; test("no checklist item for step-01-x"))' "$(vp)"
mkplan; rm "$P/PROGRESS.md"
check "vp: no PROGRESS.md" '.ok == false and any(.errors[]; test("PROGRESS.md not found"))' "$(vp)"

# host-command envelope (as wf-host-command delivers it) + allow-list
mkplan
env_task() { printf '<System instructions>\nignored {"script":"evil"}\n\n<Task>\n%s\n\n## Acceptance Contract\n{"noise": true}\n' "$1"; }
out="$(env_task "{\"script\":\"step-loader\",\"stepFile\":\"$P/step-01-x.md\"}" | "$S/host-command.sh")"
check "host-command: step-loader via envelope" '.step == "step-01-x"' "$out"
out="$(env_task '{"script":"rm"}' | "$S/host-command.sh" 2>/dev/null)"
check "host-command: unknown script rejected" '.error == "unknown script"' "$out"
out="$(env_task "{\"script\":\"terminal-gate\",\"planDir\":\"$P\"}" | "$S/host-command.sh")"
check "host-command: terminal-gate" '.ok == false and .openSteps == ["[step-01-x](./step-01-x.md)"]' "$out"
# The agent's runner line: bash -c 'exec "${PI_WORKFLOW_SKILLS_DIR:-...}/scripts/host-command.sh"'
runner_arg="$(sed -n 's/^  args: \["-c", "\(.*\)"\]$/\1/p' "$ROOT/agents/wf-host-command.md" | sed 's/\\"/"/g')"
out="$(env_task "{\"script\":\"step-loader\",\"stepFile\":\"$P/step-01-x.md\"}" | PI_WORKFLOW_SKILLS_DIR="$ROOT" bash -c "$runner_arg")"
check "wf-host-command runner args honour PI_WORKFLOW_SKILLS_DIR" '.step == "step-01-x"' "$out"

# generate-tier-overrides: the Default cell may carry prose after the model code span
cat > "$T/AGENTS.md" <<'MD'
## Model Tiers

| Tier | Default | Thinking | Notes |
|---|---|---|---|
| frontier | `anthropic/m-frontier` | high | x |
| deep | `anthropic/m-deep` | medium | x |
| standard | `anthropic/m-std` (fallback: `anthropic/m-old`) | medium | x |
| fast | `openrouter/m-fast` | low | x |
MD
echo '{"enabledModels":["anthropic/m-std"],"subagents":{"agentOverrides":{}}}' > "$T/settings.json"
out="$(node "$S/generate-tier-overrides.mjs" --agents-md "$T/AGENTS.md" --settings "$T/settings.json" --package-dir "$ROOT" 2>&1)"
if printf '%s' "$out" | grep -q 'fallback'; then fail=$((fail+1)); echo "FAIL: generator kept the fallback prose in the model id"; printf '%s\n' "$out" | grep fallback | head -2
elif printf '%s' "$out" | grep -q '^worker | model | .* | "anthropic/m-std" |'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: generator did not bind worker to anthropic/m-std"; printf '%s\n' "$out" | grep worker | head -2; fi

echo "scripts.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
