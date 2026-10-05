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

# classifiers fail closed on off-schema input (review items 1-2)
for bad in '{"findings":[{"sev":"P0"}]}' '{"P0":[1]}' '{"blockers":3,"important":[],"refuted":[]}' '{"blockers":{"a":1},"important":[],"refuted":[]}' '[1,2]'; do
  echo "$bad" > "$T/r.json"; check "classify-review rejects $bad" 'has("error")' "$("$S/classify-review.sh" "$T/r.json")"
done
echo '{"blockers":[],"important":[],"refuted":[]}' > "$T/r.json"
check "classify-review clean" '.blockers == 0 and .important == 0 and (has("error") | not)' "$("$S/classify-review.sh" "$T/r.json")"
for bad in '{"results":[]}' '{"claims":[]}' '[{"verdict":"REFUTED"}]' '{"claims":[{"verdict":"Refuted - wrong line"}]}' '{"claims":[{"claim":"x"}]}'; do
  echo "$bad" > "$T/f.json"; check "classify-factcheck rejects $bad" 'has("error")' "$("$S/classify-factcheck.sh" "$T/f.json")"
done
echo '{"claims":[{"verdict":"unverifiable"},{"verdict":"CONFIRMED"}]}' > "$T/f.json"
check "classify-factcheck counts unverifiable" '.unverifiable == 1 and .total == 2 and (has("error") | not)' "$("$S/classify-factcheck.sh" "$T/f.json")"

# ci-gate with a stub gh (review items 4-5)
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
if [ "$2" = "view" ]; then echo "{\"headRefOid\":\"${STUB_HEAD:-abc1234def}\"}"; exit 0; fi
if [ -n "${STUB_ERR:-}" ]; then echo "$STUB_ERR" >&2; exit 1; fi
printf '%s\n' "$STUB_CHECKS"; exit 0
GH
chmod +x "$T/bin/gh"
ci() { local task='{"pr":1}'; [ -n "${2:-}" ] && task="$2"; STUB_CHECKS="$1" PI_WF_GH="$T/bin/gh" "$S/ci-gate.sh" <<< "$task"; }
check "ci: zero checks -> none" '.state == "none"' "$(ci '[]')"
check "ci: unknown bucket -> unknown" '.state == "unknown"' "$(ci '[{"name":"a","bucket":"weird"}]')"
check "ci: all pass -> green" '.state == "green"' "$(ci '[{"name":"a","bucket":"pass"},{"name":"b","bucket":"skipping"}]')"
check "ci: only skipping -> none" '.state == "none"' "$(ci '[{"name":"b","bucket":"skipping"}]')"
check "ci: fail -> red" '.state == "red" and (.failing | length) == 1' "$(ci '[{"name":"a","bucket":"pass"},{"name":"b","bucket":"fail"}]')"
check "ci: cancel -> red" '.state == "red"' "$(ci '[{"name":"b","bucket":"cancel"}]')"
check "ci: pending -> pending" '.state == "pending"' "$(ci '[{"name":"b","bucket":"pending"}]')"
check "ci: no checks reported -> none" '.state == "none"' "$(STUB_ERR='no checks reported on the branch' PI_WF_GH="$T/bin/gh" "$S/ci-gate.sh" <<< '{"pr":1}')"
check "ci: stale head sha" '.state == "stale"' "$(ci '[{"name":"a","bucket":"pass"}]' '{"pr":1,"expectSha":"fff0000"}')"
check "ci: matching head sha" '.state == "green"' "$(ci '[{"name":"a","bucket":"pass"}]' '{"pr":1,"expectSha":"abc1234"}')"
check "ci: short expectSha -> unknown" '.state == "unknown"' "$(ci '[{"name":"a","bucket":"pass"}]' '{"pr":1,"expectSha":"a"}')"

# terminal-gate strict parsing (review item 8)
ledger "$T/tg/PROGRESS.md" "" "" $'## Steps\n- [x] a\n1. step-02 still to do'
check "tg: non-checkbox list item in Steps" '.ok == false and any(.errors[]; test("not a \\[ \\]/\\[x\\] checkbox"))' "$(tg "$T/tg")"
ledger "$T/tg/PROGRESS.md" "" "" $'## Steps\n- [x] a\n1. [ ] b'
check "tg: numbered checkbox counts as open" '.ok == false and .openSteps == ["b"]' "$(tg "$T/tg")"
ledger "$T/tg/PROGRESS.md" "- g-integ-1 owed by step-09 open" "" $'## Steps\n- [x] a'
check "tg: bullet inside debt section" '.ok == false and any(.errors[]; test("outside the table"))' "$(tg "$T/tg")"
ledger "$T/tg/PROGRESS.md" "" "The flaky CI job is still disabled (open)." $'## Steps\n- [x] a'
check "tg: prose inside debt section" '.ok == false and any(.errors[]; test("outside the table"))' "$(tg "$T/tg")"
ledger "$T/tg/PROGRESS.md" "<!-- note -->" "" $'## Steps\n- [x] a\n```\n- [ ] example in a fence\n```'
check "tg: html comment and fenced example ignored" '.ok == true' "$(tg "$T/tg")"

# validate-plan stricter checks (review items 9-11, 13)
vp_mut() { mkplan; jq "$1" "$P/plan.json" > "$T/x" && mv "$T/x" "$P/plan.json"; [ -n "${2:-}" ] && { jq "$2" "$P/step-01-x.gates.json" > "$T/x" && mv "$T/x" "$P/step-01-x.gates.json"; }; vp; }
check "vp: frontier tier has no lane" '.ok == false and any(.errors[]; test("no executor lane"))' "$(vp_mut '.steps[0].tier="frontier"' '.tier="frontier"')"
check "vp: files required" '.ok == false and any(.errors[]; test("files must be"))' "$(vp_mut 'del(.steps[0].files)')"
check "vp: duplicate step id" '.ok == false and any(.errors[]; test("duplicate step id"))' "$(vp_mut '.steps += [.steps[0]]')"
check "vp: duplicate gate id" '.ok == false and any(.errors[]; test("duplicate gate id"))' "$(vp_mut '.steps[0].gates[1].id="g-build-1"' '.gates[1].id="g-build-1"')"
check "vp: dangling coverage gate" '.ok == false and any(.errors[]; test("not a runnable gate"))' "$(vp_mut '.steps[0].coverage[0].gate="nope"' '.coverage[0].gate="nope"')"
check "vp: all gates n/a" '.ok == false and any(.errors[]; test("no runnable gate"))' "$(vp_mut '.steps[0].gates |= map(del(.cmd) | .result="n/a" | .reason="x") | .steps[0].coverage=[]' '.gates |= map(del(.cmd) | .result="n/a" | .reason="x") | .coverage=[]')"
check "vp: sidecar step mismatch" '.ok == false and any(.errors[]; test("sidecar \"step\""))' "$(vp_mut '.' '.step="step-09-other"')"
check "vp: sidecar tier mismatch" '.ok == false and any(.errors[]; test("sidecar tier"))' "$(vp_mut '.' '.tier="deep"')"
check "vp: sidecar path not the executed one" '.ok == false and any(.errors[]; test("not the file the executor loads"))' "$(vp_mut '.steps[0].sidecar="other.gates.json"')"
mkplan; printf '# step-01-x\nGates: g-build-10 g-static-1 g-unit-1 g-e2e-smoke-1 g-regress-1\n' > "$P/step-01-x.md"
check "vp: gate id substring does not count" '.ok == false and any(.errors[]; test("does not mention gate\\(s\\) g-build-1"))' "$(vp)"
mkplan; ledger "$P/PROGRESS.md" "" "" $'## Steps\n- [ ] [step-010-x](./step-010-x.md)'
check "vp: step id substring does not count" '.ok == false and any(.errors[]; test("no checklist item for step-01-x"))' "$(vp)"
DEF='.gates[5] = {"id":"g-integ-1","class":"integ","result":"deferred","owed_by":"step-09","reason":"slow"}'
check "vp: deferred gate needs open row" '.ok == false and any(.errors[]; test("needs an open row"))' "$(vp_mut ".steps[0]$DEF" "$DEF")"
mkplan; jq ".steps[0]$DEF" "$P/plan.json" > "$T/x" && mv "$T/x" "$P/plan.json"; jq "$DEF" "$P/step-01-x.gates.json" > "$T/x" && mv "$T/x" "$P/step-01-x.gates.json"
ledger "$P/PROGRESS.md" "| g-integ-1 | integ | step-09 | slow | open |" "" $'## Steps\n- [ ] [step-01-x](./step-01-x.md)'
check "vp: deferred gate with open row" '.ok == true' "$(vp)"
check "vp: deferred gate needs owed_by" '.ok == false and any(.errors[]; test("owed_by"))' "$(vp_mut '.steps[0].gates[5] = {"id":"g-integ-1","class":"integ","result":"deferred"}' '.gates[5] = {"id":"g-integ-1","class":"integ","result":"deferred"}')"
check "vp: First-Artifact on Dockerfile with proxy-only build" '.ok == false and any(.errors[]; test("First-Artifact"))' "$(vp_mut '.steps[0].files=["Dockerfile"] | .steps[0].gates[0] += {"proxy":true,"real_gate":"docker build ."} | .steps[0].gates[3] = {"id":"g-e2e-smoke-1","class":"e2e-smoke","result":"n/a","reason":"x"}' '.gates[0] += {"proxy":true,"real_gate":"docker build ."} | .gates[3] = {"id":"g-e2e-smoke-1","class":"e2e-smoke","result":"n/a","reason":"x"}')"

# ledger-apply (ledger by script)
LA="$T/la"; mkdir -p "$LA"
printf '# P\n\n## Decisions taken\n\n## Pending decisions (human)\n\n' > "$LA/PROGRESS.md"
ledger "$T/la-tail.md" "" "" $'## Steps\n- [ ] [step-01-x](./step-01-x.md) — x\n- [ ] [step-010-y](./step-010-y.md) — y'
sed -n '3,$p' "$T/la-tail.md" >> "$LA/PROGRESS.md"
LJ='{"planDir":"'"$LA"'","ledgers":[{"step":"step-01-x","commit":"abc1234def","decisions_taken":["used a | pipe"],"pending_decisions":["pick a name"],"deferred":[{"gate":"g-integ-1","class":"integ","owed_by":"step-09","reason":"slow"}],"proxies_used":[{"gate":"g-build-2","proxy_cmd":"bake --print","real_gate":"bake"}]}]}'
out="$(echo "$LJ" | "$S/ledger-apply.sh")"
check "ledger-apply: applies all" '.ok == true and .applied.decisions == 1 and .applied.pending == 1 and .applied.deferredRows == 2 and .applied.ticked == ["step-01-x"]' "$out"
check "ledger-apply: tg sees the open rows, step-010 untouched" '.ok == false and (.openDeferred | length) == 2 and .openSteps == ["[step-010-y](./step-010-y.md) — y"]' "$(tg "$LA")"
out="$(echo "$LJ" | "$S/ledger-apply.sh")"
check "ledger-apply: idempotent" '.ok == true and .applied.decisions == 0 and .applied.deferredRows == 0 and .applied.ticked == []' "$out"
grep -q '^- step-01-x @abc1234: used a | pipe$' "$LA/PROGRESS.md" && grep -q 'step-01-x.*\[x\].*\|\[x\].*step-01-x.* — abc1234' "$LA/PROGRESS.md" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: ledger-apply text"; cat "$LA/PROGRESS.md"; }
echo '{"board":[{"state":"PASS","ledger":{"step":"step-010-y","commit":"def5678"}},{"state":"FAIL","ledger":{"step":"zzz"}}]}' > "$T/result.json"
check "ledger-apply: fromResult PASS lanes" '.ok == true and .applied.ticked == ["step-010-y"]' "$(echo '{"planDir":"'"$LA"'","fromResult":"'"$T"'/result.json"}' | "$S/ledger-apply.sh")"
check "ledger-apply: fromResult missing lane" '.ok == false' "$(echo '{"planDir":"'"$LA"'","fromResult":"'"$T"'/result.json","steps":["zzz"]}' | "$S/ledger-apply.sh")"
check "ledger-apply: unknown step" '.ok == false and any(.errors[]; test("no checklist item"))' "$(echo '{"planDir":"'"$LA"'","ledgers":[{"step":"step-99","commit":"1"}]}' | "$S/ledger-apply.sh")"

# write-artifact
check "write-artifact: json" '.ok == true' "$(echo '{"path":"'"$T"'/a/b/brief.json","json":{"x":1}}' | "$S/write-artifact.sh")"
check "write-artifact: content" '.x == 1' "$(cat "$T/a/b/brief.json")"
check "write-artifact: rejects relative" '.ok == false' "$(echo '{"path":"rel.json","json":{}}' | "$S/write-artifact.sh")"
check "write-artifact: rejects dotdot" '.ok == false' "$(echo '{"path":"'"$T"'/../x.json","json":{}}' | "$S/write-artifact.sh")"
check "write-artifact: rejects other extensions" '.ok == false' "$(echo '{"path":"'"$T"'/x.sh","text":"rm -rf"}' | "$S/write-artifact.sh")"
out="$(env_task '{"script":"write-artifact","path":"'"$T"'/via-host.json","json":{"y":2}}' | "$S/host-command.sh")"
check "write-artifact via host-command" '.ok == true' "$out"

check "write-artifact: check reports missing" '.ok == true and .missing == ["/nope/x"]' "$(echo '{"check":["/tmp","/nope/x"]}' | "$S/write-artifact.sh")"

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

# --apply keeps settings.json's mode and writes the state file beside --settings, never into ~/.pi/agent
chmod 600 "$T/settings.json"
node "$S/generate-tier-overrides.mjs" --apply --agents-md "$T/AGENTS.md" --settings "$T/settings.json" --package-dir "$ROOT" >/dev/null 2>&1
if [ "$(stat -c %a "$T/settings.json")" = 600 ] && [ -f "$T/tier-overrides.state.json" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: generator --apply: mode $(stat -c %a "$T/settings.json"), state beside settings: $([ -f "$T/tier-overrides.state.json" ] && echo yes || echo no)"; fi

# validate-chain: every meaningful prose word is mapped; args must be ones the workflow accepts
vc() { printf '%s' "$1" > "$T/chain.json"; "$S/validate-chain.sh" "$T/chain.json"; }
VC_OK='{"prose":"code-reviewer frontier -> fix only trivial stuff, x1","status":"ready","questions":[],
 "stages":[{"n":1,"stage":"review","args":{"target":"branch feat","reviewDir":"/r","reviewerModel":"anthropic/claude-fable-5-1:high","fixScope":"trivial","maxRounds":1}}],
 "mapping":[{"from":"code-reviewer","to":"stage:review","confidence":"exact"},{"from":"frontier","to":"review.reviewerModel=anthropic/claude-fable-5-1:high","confidence":"exact"},
  {"from":"fix only trivial stuff","to":"review.fixScope=trivial","confidence":"inferred"},{"from":"x1","to":"review.maxRounds=1","confidence":"exact"}]}'
check "vc: fully mapped chain ok" '.ok == true and .status == "ready" and (.inferred | length) == 1' "$(vc "$VC_OK")"
check "vc: dropped word -> uncovered" '.ok == false and .uncovered == ["frontier"]' "$(vc "$(jq -c '.mapping |= map(select(.from != "frontier"))' <<< "$VC_OK")")"
check "vc: unknown arg rejected" '.ok == false and (.errors[0] | test("reviewerModle"))' "$(vc "$(jq -c '.stages[0].args.reviewerModle = 1' <<< "$VC_OK")")"
check "vc: mapped but not applied" '.ok == false and (.errors[0] | test("not applied"))' "$(vc "$(jq -c 'del(.stages[0].args.fixScope)' <<< "$VC_OK")")"
check "vc: invented from rejected" '.ok == false and (.errors[0] | test("verbatim"))' "$(vc "$(jq -c '.mapping += [{"from":"with gpt","to":"x","confidence":"exact"}]' <<< "$VC_OK")")"
check "vc: ambiguous needs questions" '.ok == false and (.errors[0] | test("without questions"))' "$(vc "$(jq -c '.mapping[1].confidence = "ambiguous"' <<< "$VC_OK")")"
check "vc: questions force ask" '.ok == true and .status == "ask"' "$(vc "$(jq -c '.mapping[1].confidence = "ambiguous" | .status = "ask" | .questions = [{"about":"frontier","options":["reviewer model","plan tier"]}]' <<< "$VC_OK")")"
check "vc: ignored needs a reason" '.ok == false and (.errors[0] | test("reason"))' "$(vc "$(jq -c '.mapping[1] = {"from":"frontier","confidence":"ignored"}' <<< "$VC_OK")")"
check "vc: required arg missing" '.ok == false and (.errors[0] | test("required arg target"))' "$(vc "$(jq -c 'del(.stages[0].args.target)' <<< "$VC_OK")")"
check "vc: unknown stage" '.ok == false and (.errors[0] | test("unknown stage"))' "$(vc "$(jq -c '.stages[0].stage = "revue"' <<< "$VC_OK")")"

# every workflow declares ALLOWED_ARGS and returns a blocked envelope for unknown args (no silent drops)
for wf in "$ROOT"/workflows/*.js; do
  if grep -q 'const ALLOWED_ARGS = ' "$wf" && grep -q 'badArgs.length' "$wf"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $(basename "$wf") lacks the ALLOWED_ARGS guard"; fi
done
# every arg a workflow reads is in its ALLOWED_ARGS (a read-but-rejected arg would make the guard block valid calls)
for wf in "$ROOT"/workflows/*.js; do
  allowed="$(tr '\n' ' ' < "$wf" | grep -o 'const ALLOWED_ARGS = \[[^]]*\]' | sed 's/.*= //' | jq -r '.[]' 2>/dev/null)"
  missing="$(grep -o -E 'args\.[a-zA-Z]+' "$wf" | sed 's/args\.//' | sort -u | grep -v -x -F "$allowed")"
  if [ -z "$missing" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $(basename "$wf") reads args not in ALLOWED_ARGS: $missing"; fi
done

# Per-topic test files (sourced, so they share check/pass/fail, $S, $T and $ROOT); lets parallel lanes add tests without conflicts.
for f in "$ROOT"/tests/scripts.d/*.sh; do [ -f "$f" ] && source "$f"; done

echo "scripts.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
