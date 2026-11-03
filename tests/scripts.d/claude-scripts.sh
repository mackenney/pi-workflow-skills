# Claude Code helpers: claude/scripts/check-block.sh, claude/scripts/gates.sh, claude-install.sh.
# Sourced by tests/scripts.test.sh (check, pass/fail, $S, $T, $ROOT).

CS="$ROOT/claude/scripts"
CB="$T/cb"; mkdir -p "$CB"
cb() { # kind json -> check-block output; also asserts exit 0 and exactly one JSON line
  printf '%s' "$2" > "$CB/b.json"
  local o rc; o="$("$CS/check-block.sh" "$1" "$CB/b.json" 2>/dev/null)"; rc=$?
  if [ "$rc" -ne 0 ] || [ "$(printf '%s\n' "$o" | wc -l)" -ne 1 ]; then echo '{"rc":'"$rc"'}'; else printf '%s' "$o"; fi
}
SV='{"verdict":"PASS","step":"s","commit":"abc1234","gates":[{"id":"g1","class":"unit","result":"pass"}],"coverage":[{"row":"r","gate":"g1"}],"proxies_used":[],"deferred":[],"decisions_taken":[],"pending_decisions":[],"residual_risks":[]}'
sv() { jq -c "$1" <<< "$SV"; }
RV='{"verdict":"PASS","step":"s","commit":"abc1234","gates":[{"id":"g1","class":"unit","result":"pass"}],"findings":[],"ledger_gaps":[]}'
rv() { jq -c "$1" <<< "$RV"; }
EV='{"stage":"x","status":"done","summary":"ok","actionables":[{"what":"w","kind":"info","ref":"f#a"}],"artifacts":{"primary":"p","details":["d"]}}'
ev() { jq -c "$1" <<< "$EV"; }

# check-block: valid blocks
check "cb: valid step-verdict" '.ok == true' "$(cb step-verdict "$SV")"
check "cb: valid review-verdict" '.ok == true' "$(cb review-verdict "$RV")"
check "cb: valid envelope" '.ok == true' "$(cb envelope "$EV")"
check "cb: valid fix-report" '.ok == true' "$(cb fix-report '{"fixed":["a"],"escalated":[{"title":"t","why":"w"}],"skipped":[],"extra":1}')"
check "cb: FAIL without commit is fine" '.ok == true' "$(cb step-verdict "$(sv '.verdict="FAIL" | .commit="" | .gates[0].result="fail"')")"
# check-block: schema rejections
check "cb: PASS without commit" '.ok == false and any(.errors[]; test("PASS without"))' "$(cb step-verdict "$(sv 'del(.commit)')")"
check "cb: unknown key" '.ok == false and any(.errors[]; test("unknown key: bogus"))' "$(cb step-verdict "$(sv '.bogus=1')")"
check "cb: numeric commit" '.ok == false and any(.errors[]; test("commit must"))' "$(cb step-verdict "$(sv '.commit=1234567')")"
check "cb: proxy without proxies_used" '.ok == false and any(.errors[]; test("no proxies_used"))' "$(cb step-verdict "$(sv '.gates[0].result="proxy"')")"
check "cb: proxy with proxies_used" '.ok == true' "$(cb step-verdict "$(sv '.gates[0].result="proxy" | .proxies_used=[{gate:"g1",proxy_cmd:"c",real_gate:"r"}]')")"
check "cb: coverage item not an object" '.ok == false and any(.errors[]; test("coverage\\[0\\] must be an object"))' "$(cb step-verdict "$(sv '.coverage=[5]')")"
check "cb: string-array item type" '.ok == false and any(.errors[]; test("decisions_taken\\[0\\] must be a string"))' "$(cb step-verdict "$(sv '.decisions_taken=[5]')")"
check "cb: summary > 400" '.ok == false' "$(cb envelope "$(ev '.summary=("x"*401)')")"
check "cb: actionables > 12" '.ok == false' "$(cb envelope "$(ev '.actionables=[range(13) | {what:"w",kind:"info",ref:"r"}]')")"
check "cb: artifacts extra key" '.ok == false and any(.errors[]; test("unknown key: artifacts.bogus"))' "$(cb envelope "$(ev '.artifacts.bogus=1')")"
check "cb: actionable extra key" '.ok == false and any(.errors[]; test("actionables\\[0\\].x"))' "$(cb envelope "$(ev '.actionables[0].x=1')")"
check "cb: artifacts.details not strings" '.ok == false' "$(cb envelope "$(ev '.artifacts.details=5')")"
check "cb: envelope missing stage" '.ok == false' "$(cb envelope "$(ev 'del(.stage)')")"
check "cb: fix-report fixed item type" '.ok == false' "$(cb fix-report '{"fixed":[5],"escalated":[],"skipped":[]}')"
check "cb: unknown kind" '.ok == false' "$(cb nope '{}')"
# check-block: contradictory PASS
check "cb: step PASS with a failed gate" '.ok == false and any(.errors[]; test("contradictory PASS"))' "$(cb step-verdict "$(sv '.gates[0].result="fail"')")"
check "cb: review PASS with failed gate" '.ok == false and any(.errors[]; test("contradictory PASS"))' "$(cb review-verdict "$(rv '.gates[0].result="fail"')")"
check "cb: review PASS with P0 finding" '.ok == false and any(.errors[]; test("P0/P1"))' "$(cb review-verdict "$(rv '.findings=[{severity:"P0",class:"c",location:"l",evidence:"e",smallest_fix:"f"}]')")"
check "cb: review PASS with ledger gap" '.ok == false and any(.errors[]; test("ledger gap"))' "$(cb review-verdict "$(rv '.ledger_gaps=["y"]')")"
check "cb: review PASS with P2 only" '.ok == true' "$(cb review-verdict "$(rv '.findings=[{severity:"P2",class:"c",location:"l",evidence:"e",smallest_fix:"f"}]')")"
check "cb: review FAIL with P0" '.ok == true' "$(cb review-verdict "$(rv '.verdict="FAIL" | .findings=[{severity:"P0",class:"c",location:"l",evidence:"e",smallest_fix:"f"}]')")"
# check-block: malformed input never crashes (one JSON object, exit 0)
check "cb: malformed JSON" '.ok == false' "$(cb step-verdict '{not json')"
check "cb: missing file" '.ok == false' "$("$CS/check-block.sh" step-verdict "$CB/none.json")"
check "cb: top-level array" '.ok == false' "$(cb envelope '[1]')"
check "cb: gates not an array" '.ok == false and any(.errors[]; test("gates must be an array"))' "$(cb step-verdict "$(sv '.gates="x"')")"
check "cb: gates missing" '.ok == false' "$(cb step-verdict "$(sv 'del(.gates)')")"
check "cb: gate item null" '.ok == false' "$(cb step-verdict "$(sv '.gates=[null]')")"
check "cb: deferred item a string" '.ok == false and any(.errors[]; test("deferred\\[0\\] must be an object"))' "$(cb step-verdict "$(sv '.deferred=["x"]')")"
check "cb: proxies_used item a number" '.ok == false and any(.errors[]; test("proxies_used\\[0\\] must be an object"))' "$(cb step-verdict "$(sv '.proxies_used=[5]')")"
check "cb: findings item a string" '.ok == false and any(.errors[]; test("findings\\[0\\] must be an object"))' "$(cb review-verdict "$(rv '.findings=["x"]')")"
check "cb: escalated item a string" '.ok == false' "$(cb fix-report '{"fixed":[],"escalated":["x"],"skipped":[]}')"
check "cb: actionables item null" '.ok == false' "$(cb envelope "$(ev '.actionables=[null]')")"

# gates.sh
GR="$T/gr"; mkdir -p "$GR/repo" "$GR/plan"
gg() { git -C "$GR/repo" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }
gg init -q -b main; echo a > "$GR/repo/a"; gg add a; gg commit -qm base; GC1="$(gg rev-parse HEAD)"
echo b > "$GR/repo/b"; gg add b; gg commit -qm work; GC2="$(gg rev-parse HEAD)"
STEP="$GR/plan/step-01-x.md"; SIDE="$GR/plan/step-01-x.gates.json"; echo '# step' > "$STEP"
side() { printf '%s' "$1" > "$SIDE"; sha256sum "$SIDE" | cut -d' ' -f1; }
gs() { (cd "$GR/repo" && "$CS/gates.sh" "$@" 2>/dev/null) || echo '{"rc":"nonzero"}'; }
H="$(side '{"gates":[{"id":"a","class":"unit","cmd":"test -f b"},{"id":"n","class":"integ","result":"n/a","reason":"r"},{"id":"d","class":"e2e-smoke","cmd":"false","result":"deferred","owed_by":"s9"}]}')"
check "gates: n/a + deferred filtered" '.ok == true and (.results | length) == 1 and .results[0].id == "a" and .skipped == ["n","d"]' "$(gs "$STEP" "$GC2" "$H")"
check "gates: repo arg from another cwd" '.ok == true' "$(cd "$T" && "$CS/gates.sh" "$STEP" "$GC2" "$H" "$GR/repo")"
check "gates: HEAD mismatch" '.ok == false and (.error | test("check the commit out"))' "$(gs "$STEP" "$GC1" "$H")"
check "gates: failing gate" '.ok == false' "$(gs "$STEP" "$GC2" "$(side '{"gates":[{"id":"a","class":"unit","cmd":"exit 3"}]}')")"
check "gates: timeout" '.ok == false and .results[0].timedOut == true' "$(gs "$STEP" "$GC2" "$(side '{"gates":[{"id":"a","class":"unit","cmd":"sleep 5","timeoutMs":200}]}')")"
H="$(side '{"gates":[{"id":"n","class":"integ","result":"n/a","reason":"r"},{"id":"d","class":"unit","cmd":"true","result":"deferred","owed_by":"s9"}]}')"
check "gates: empty runnable set fails closed" '.ok == false and (.error | test("no runnable gates")) and .skipped == ["n","d"]' "$(gs "$STEP" "$GC2" "$H")"
H="$(side '{"gates":[{"id":"a","class":"unit","cmd":"true"}]}')"
printf '%s' '{"gates":[{"id":"a","class":"unit","cmd":"true","result":"n/a"}]}' > "$SIDE"
check "gates: sidecar edited after hash" '.ok == false and (.error | test("changed since"))' "$(gs "$STEP" "$GC2" "$H")"
check "gates: relative step path" '.ok == false and (.error | test("absolute"))' "$(cd "$GR" && "$CS/gates.sh" plan/step-01-x.md "$GC2" "$H" "$GR/repo")"
check "gates: missing sha arg" '.ok == false and (.error | test("usage"))' "$(gs "$STEP" "$GC2")"
check "gates: malformed sha" '.ok == false and (.error | test("sha256"))' "$(gs "$STEP" "$GC2" "abc")"
check "gates: missing sidecar" '.ok == false and (.error | test("unreadable"))' "$(gs "$GR/plan/nope.md" "$GC2" "$H")"
check "gates: sidecar null" '.ok == false and (.error | test("no gates array"))' "$(gs "$STEP" "$GC2" "$(side 'null')")"
check "gates: null gate skipped" '.ok == true and .skipped == [null]' "$(gs "$STEP" "$GC2" "$(side '{"gates":[null,{"id":"a","class":"unit","cmd":"true"}]}')")"
check "gates: only a null gate" '.ok == false and (.error | test("no runnable"))' "$(gs "$STEP" "$GC2" "$(side '{"gates":[null]}')")"
check "gates: bad JSON" '.ok == false and (.error | test("unreadable"))' "$(gs "$STEP" "$GC2" "$(side '{nope')")"

# claude-install.sh (always --dir into the temp dir, never ~/.claude)
CI="$T/ci"; mkdir -p "$CI/real"
cp "$ROOT/claude-install.sh" "$CI/real/"; mkdir -p "$CI/real/claude/skills/sk" "$CI/real/claude/agents" "$CI/real/skills/sk" "$CI/real/skills/old"
echo a > "$CI/real/claude/agents/wf-a.md"
ln -s real "$CI/link"
inst() { "$@" 2>&1; echo "rc=$?"; }
o="$(inst "$CI/real/claude-install.sh" --dir "$CI/t1")"
if grep -q "linked    $CI/t1/skills/sk -> $CI/real/claude/skills/sk" <<< "$o" && grep -q "rc=0" <<< "$o" && [ "$(readlink "$CI/t1/agents/wf-a.md")" = "$CI/real/claude/agents/wf-a.md" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: install: fresh install"; echo "$o"; fi
o="$(inst "$CI/real/claude-install.sh" --dir "$CI/t1")"
if [ "$(grep -c '^exists' <<< "$o")" = 2 ] && ! grep -q -E '^(linked|conflict)' <<< "$o"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: install: rerun reports exists"; echo "$o"; fi
o="$(inst "$CI/link/claude-install.sh" --dir "$CI/t2")"
if [ "$(readlink "$CI/t2/skills/sk")" = "$CI/real/claude/skills/sk" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: install: via symlinked checkout records the physical path"; echo "$o"; fi
# A link an older version wrote through the symlinked checkout (logical path) is still ours from the real path.
mkdir -p "$CI/t3/skills" "$CI/t3/agents"; ln -s "$CI/link/claude/skills/sk" "$CI/t3/skills/sk"; ln -s "$CI/link/claude/agents/wf-a.md" "$CI/t3/agents/wf-a.md"
o="$(inst "$CI/real/claude-install.sh" --dir "$CI/t3")"
if [ "$(grep -c '^exists' <<< "$o")" = 2 ] && ! grep -q conflict <<< "$o"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: install: logical-path link counts as ours"; echo "$o"; fi
o="$(inst "$CI/real/claude-install.sh" --dir "$CI/t3" --uninstall)"
if [ "$(grep -c '^removed' <<< "$o")" = 2 ] && [ ! -L "$CI/t3/skills/sk" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: install: uninstall removes logical-path links"; echo "$o"; fi
# Legacy link to the pi original is migrated; a foreign link and a foreign file are left alone.
mkdir -p "$CI/t4/skills" "$CI/t4/agents"; ln -s "$CI/real/skills/sk" "$CI/t4/skills/sk"; ln -s /elsewhere "$CI/t4/agents/wf-a.md"
o="$(inst "$CI/real/claude-install.sh" --dir "$CI/t4")"
if grep -q "^migrated  $CI/t4/skills/sk" <<< "$o" && [ "$(readlink -f "$CI/t4/skills/sk")" = "$CI/real/claude/skills/sk" ] && grep -q "^conflict  $CI/t4/agents/wf-a.md" <<< "$o" && [ "$(readlink "$CI/t4/agents/wf-a.md")" = /elsewhere ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: install: legacy migrated, foreign link skipped"; echo "$o"; fi
rm "$CI/t4/agents/wf-a.md"; echo mine > "$CI/t4/agents/wf-a.md"
o="$(inst "$CI/real/claude-install.sh" --dir "$CI/t4" --uninstall)"
if grep -q "^removed   $CI/t4/skills/sk" <<< "$o" && [ "$(cat "$CI/t4/agents/wf-a.md")" = mine ] && grep -q "^skipped   $CI/t4/agents/wf-a.md" <<< "$o"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: install: uninstall leaves foreign files"; echo "$o"; fi
