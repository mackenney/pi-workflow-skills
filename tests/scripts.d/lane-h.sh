# pi integrity checks: tree-check host script, and execute-step/execute-wave blocking a dirty tree, drift, an empty gate
# set, plan edits, pi-subagents' own state, uncommitted or self-ignored work, contradictory PASSes, a resume without its sidecar hash or with
# HEAD elsewhere. Reuses lane-a's stub runtime (wf, ww, SV, RV, mk_step, g, $RA, $PD, $C0, $C1).

g checkout -q main
[ "$(g rev-parse HEAD)" = "$C1" ] && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: lane-h expects HEAD at C1"; }
mk_step true
ledger "$PD/PROGRESS.md" "" "" $'## Steps\n- [ ] [step-01-x](./step-01-x.md)'
SC="$PD/step-01-x.gates.json"
EXCL="$(g rev-parse --git-path info/exclude)"; case "$EXCL" in /*) ;; *) EXCL="$RA/repo/$EXCL" ;; esac
mkdir -p "$(dirname "$EXCL")"; touch "$EXCL"; cp "$EXCL" "$RA/exclude.bak"

# tree-check direct
tc() { (cd "$RA/repo" && "$S/tree-check.sh" <<< "$1"); }
out="$(tc '{"planDir":"'"$PD"'","hashFiles":["'"$SC"'","'"$PD"'/nope"],"drift":{"sidecar":"'"$SC"'","planJson":"'"$PD"'/plan.json"}}')"
check "tc: clean, on a branch, hashes, no drift" '.ok == true and .clean == true and .head == "'"$C1"'" and .branch == "refs/heads/main" and (.hashes["'"$PD"'/nope"] == "missing") and (.planSha | length) == 64 and .drift == null' "$out"
check "tc: sidecar hash is sha256sum" '.hashes["'"$SC"'"] == "'"$(sha256sum "$SC" | cut -d' ' -f1)"'"' "$out"
echo x > "$RA/repo/stray"
check "tc: stray file -> not clean" '.ok == false and .clean == false and .paths == ["?? stray"]' "$(tc '{"planDir":"'"$PD"'"}')"
rm "$RA/repo/stray"
mkdir -p "$RA/repo/.pi/subagents/artifacts" && echo x > "$RA/repo/.pi/subagents/artifacts/r.json"
# Hermetic: a global ignore of .pi/ would hide both cases.
tch() { GIT_CONFIG_GLOBAL=/dev/null XDG_CONFIG_HOME="$RA" tc "$1"; }
check "tc: pi-subagents runtime state is not dirt" '.ok == true and .paths == []' "$(tch '{"planDir":"'"$PD"'"}')"
echo x > "$RA/repo/.pi/other"
check "tc: other .pi files still count" '.ok == false and .paths == ["?? .pi/other"]' "$(tch '{"planDir":"'"$PD"'"}')"
rm -r "$RA/repo/.pi"
jq '.steps[0].tier = "deep"' "$PD/plan.json" > "$RA/p.json" && cp "$PD/plan.json" "$RA/plan.bak" && mv "$RA/p.json" "$PD/plan.json"
check "tc: drift in tier" '.ok == false and (.drift | test("tier"))' "$(tc '{"planDir":"'"$PD"'","drift":[{"sidecar":"'"$SC"'","planJson":"'"$PD"'/plan.json"}]}')"
mv "$RA/plan.bak" "$PD/plan.json"
check "tc: key order is not drift" '.drift == null' "$(jq '.steps[0] |= {coverage, gates, tier, id}' "$PD/plan.json" > "$RA/p2.json"; tc '{"planDir":"'"$PD"'","drift":{"sidecar":"'"$SC"'","planJson":"'"$RA"'/p2.json"}}')"
check "tc: wrong ignoreSha -> error" '.ok == false and (.error | test("ignore rules changed"))' "$(tc '{"planDir":"'"$PD"'","ignoreSha":"'"$(printf '0%.0s' {1..64})"'"}')"
check "tc: relative planDir rejected" '.ok == false and (.error | test("absolute"))' "$(tc '{"planDir":"plan"}')"
check "tc: missing planDir" '.ok == false and (.error | test("planDir is required"))' "$(tc '{}')"
check "tc: host-command allows tree-check" '.ok == false and (.error | test("planDir is required"))' "$(env_task '{"script":"tree-check"}' | "$S/host-command.sh")"

# execute-step: bases and recorded hashes
out="$(wf '{"maxFixRounds":0}' "{\"implement\":$IMPL_OK,\"review-0\":$REV_FAIL}")"
check "es: tree checked before and after the worker" '.calls[0:3] == ["gates","tree-pre","implement"] and (.calls | index("tree-implement"))' "$out"
check "es: fails-before base is HEAD at start, not the sidecar base" '(.callInfo[] | select(.key == "implement") | .task | test("fails-before checks: '"$C1"'"))' "$out"
check "es: reviewer gets the review range" '(.callInfo[] | select(.key == "review-0") | .task | test("Base commit: '"$C1"' \\(the step.s change is '"$C1"'\\.\\.'"$C1"'\\)"))' "$out"
check "es: resume args carry sidecarSha, reviewBase, baseCommit" '.result.resumePoint.args.sidecarSha == "'"$(sha256sum "$SC" | cut -d' ' -f1)"'" and .result.resumePoint.args.reviewBase == "'"$C1"'" and .result.resumePoint.args.baseCommit == "'"$C0"'" and (.result.ignoreSha | length) == 64' "$out"

# execute-step: blocks before any model runs
jq '.gates[0].result = "n/a" | .gates[0].reason = "x"' "$SC" > "$RA/s.json" && mv "$RA/s.json" "$SC"; jq '{steps:[{id:.step, tier, gates, coverage}]}' "$SC" > "$PD/plan.json"
out="$(wf '{}' '{}')"
check "es: no runnable gates -> blocked at contract, no launch" '.env.status == "blocked" and .result.stage == "contract" and (.result.reason | test("no runnable gates")) and .calls == ["gates","persist"]' "$out"
mk_step true
echo x > "$RA/repo/stray"
out="$(wf '{}' '{}')"
check "es: dirty tree -> blocked before dispatch" '.env.status == "blocked" and .result.stage == "contract" and (.result.reason | test("not clean.*stray")) and .calls == ["gates","tree-pre","persist"]' "$out"
rm "$RA/repo/stray"
jq '.steps[0].gates[0].cmd = "false"' "$PD/plan.json" > "$RA/p.json" && mv "$RA/p.json" "$PD/plan.json"
out="$(wf '{}' '{}')"
check "es: sidecar drift -> blocked" '.env.status == "blocked" and (.result.reason | test("drifted.*gates"))' "$out"
mk_step true

# execute-step: after the worker
out="$(wf '{}' "{\"implement\":$(jq -c '. + {sh: "echo x > leftover"}' <<< "$IMPL_OK")}")"
check "es: uncommitted work -> FAIL at implement, resume fix, alt gates" '.env.status == "failed" and .result.stage == "implement" and (.result.reason | test("uncommitted work.*leftover")) and .result.resumePoint.from == "fix" and .result.resumeAlternatives[0].from == "gates" and (.calls | index("review-0") | not)' "$out"
rm -f "$RA/repo/leftover"
out="$(wf '{}' "{\"implement\":$(jq -c '. + {sh: "echo \"{}\" > plan/step-01-x.gates.json"}' <<< "$IMPL_OK")}")"
check "es: worker edits the sidecar -> blocked, no review" '.env.status == "blocked" and (.result.reason | test("plan files changed")) and (.calls | index("review-0") | not)' "$out"
mk_step true
out="$(wf '{}' "{\"implement\":$(jq -c --arg e "$EXCL" '. + {sh: ("echo leftover >> " + $e + "; echo x > leftover")}' <<< "$IMPL_OK")}")"
check "es: worker ignores its own file -> blocked" '.env.status == "blocked" and .result.stage == "gates" and (.result.reason | test("ignore rules changed"))' "$out"
cp "$RA/exclude.bak" "$EXCL"; rm -f "$RA/repo/leftover"
out="$(wf '{}' "{\"implement\":$(jq -c '. + {sh: "echo pyc > x.pyc"}' <<< "$IMPL_OK")}")"
check "es: only gate by-products -> blocked at gates, resume gates" '.env.status == "blocked" and .result.stage == "gates" and (.result.reason | test("by-products")) and .result.resumePoint.from == "gates"' "$out"
rm -f "$RA/repo/x.pyc"
out="$(wf '{}' "{\"implement\":{\"ok\":true,\"structuredOutput\":$(SV PASS "$C1" | jq -c '.gates[0].result = "fail"')}}")"
check "es: PASS with a failed gate -> FAIL, no review" '.env.status == "failed" and .result.stage == "implement" and (.result.verdict.residual_risks[-1] | test("contradictory PASS")) and (.calls | index("review-0") | not)' "$out"
out="$(wf '{}' "{\"implement\":$IMPL_OK,\"review-0\":{\"ok\":true,\"structuredOutput\":$(RV PASS "$C1" | jq -c '.findings = [{severity:"P1",class:"bug",location:"b",evidence:"e",smallest_fix:"f"}]')},\"fix-1\":$IMPL_OK,\"review-1\":$REV_PASS}")"
check "es: review PASS with a P1 finding -> fix round" '.env.status == "done" and (.calls | index("fix-1")) and (.calls | index("tree-fix-1"))' "$out"

# execute-step: resume guards
out="$(wf "{\"sidecarSha\":null,\"resume\":{\"from\":\"review\",\"commit\":\"$C1\"}}" '{}')"
check "es resume: no sidecarSha -> blocked" '.env.status == "blocked" and (.result.reason | test("needs sidecarSha.*pass the current hash '"$(sha256sum "$SC" | cut -d' ' -f1)"'")) and .result.resumePoint.from == "review"' "$out"
out="$(wf "{\"sidecarSha\":\"$(printf 'a%.0s' {1..64})\",\"resume\":{\"from\":\"review\",\"commit\":\"$C1\"}}" '{}')"
check "es resume: sidecar hash changed -> blocked" '.env.status == "blocked" and (.result.reason | test("sidecar changed since"))' "$out"
out="$(wf "{\"resume\":{\"from\":\"gates\",\"commit\":\"$C0\"}}" '{}')"
check "es resume: gates with HEAD elsewhere -> blocked, no gate run" '.env.status == "blocked" and .result.stage == "resume" and (.result.reason | test("not the resume commit")) and (.calls | index("resume-gates") | not)' "$out"
g checkout -q --detach "$C1"
out="$(wf "{\"resume\":{\"from\":\"review\",\"commit\":\"$C1\"}}" '{}')"
check "es resume: detached HEAD -> blocked" '.env.status == "blocked" and (.result.reason | test("detached"))' "$out"
g checkout -q main
out="$(wf "{\"resume\":{\"from\":\"fix\",\"commit\":\"$C1\"}}" "{\"resume-fresh\":$IMPL_OK,\"review-0\":$REV_PASS}")"
check "es resume fix: fresh worker is told not to check out" '.env.status == "done" and (.callInfo[] | select(.key == "resume-fresh") | .task | test("do not check out another commit"))' "$out"

# execute-wave
out="$(ww "{\"impl-step-01-x\":$IMPL_OK,\"review-step-01-x\":$REV_PASS}")"
check "ew: wave base is HEAD, lane records sidecarSha" '.result.board[0].state == "PASS" and (.callInfo[] | select(.key == "impl-step-01-x") | .task | test("fails-before checks: '"$C1"'")) and (.result.board[0].sidecarSha | length) == 64 and (.calls | index("tree-post"))' "$out"
echo x > "$RA/repo/stray"
out="$(ww '{}')"
check "ew: dirty checkout -> wave blocked, no worker" '.env.status == "blocked" and (.result.reason | test("not clean")) and (.calls | index("impl-step-01-x") | not)' "$out"
rm "$RA/repo/stray"
out="$(ww "{\"impl-step-01-x\":$(jq -c '. + {sh: "echo \"# changed\" >> plan/step-01-x.md"}' <<< "$IMPL_OK")}")"
check "ew: plan edit during the wave -> lane BLOCKED, not reviewed" '.result.board[0].state == "BLOCKED" and .result.board[0].stage == "contract" and (.result.board[0].error | test("plan files changed")) and (.calls | index("review-step-01-x") | not)' "$out"
mk_step true
out="$(ww "{\"impl-step-01-x\":{\"ok\":true,\"structuredOutput\":$(SV PASS "$C1" | jq -c '.gates[0].result = "fail"')}}")"
check "ew: lane PASS with failed gate -> FAIL" '.result.board[0].state == "FAIL" and (.result.board[0].error | test("contradictory PASS"))' "$out"
out="$(ww "{\"impl-step-01-x\":$IMPL_OK,\"review-step-01-x\":{\"ok\":true,\"structuredOutput\":$(RV PASS "$C1" | jq -c '.ledger_gaps = ["missing decision"]')}}")"
check "ew: review PASS with a ledger gap -> lane FAIL" '.result.board[0].state == "FAIL" and .result.board[0].stage == "review" and (.result.board[0].error | test("ledger gap"))' "$out"
