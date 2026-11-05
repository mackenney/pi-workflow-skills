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
check "cb: summary > 400" '.ok == false and any(.errors[]; test("summary must be a string of at most 400"))' "$(cb envelope "$(ev '.summary=("x"*401)')")"
check "cb: summary = 400" '.ok == true' "$(cb envelope "$(ev '.summary=("x"*400)')")"
check "cb: summary 400 code points (astral)" '.ok == true' "$(cb envelope "$(ev '.summary=("\ud83d\ude00"*400)')")"
check "cb: summary 401 code points (astral)" '.ok == false and any(.errors[]; test("at most 400"))' "$(cb envelope "$(ev '.summary=("\ud83d\ude00"*401)')")"
check "cb: what 300 code points (astral)" '.ok == true' "$(cb envelope "$(ev '.actionables[0].what=("\ud83d\ude00"*300)')")"
check "cb: what 301 chars" '.ok == false and any(.errors[]; test("what must be a string of at most 300"))' "$(cb envelope "$(ev '.actionables[0].what=("x"*301)')")"
check "cb: actionables > 12" '.ok == false and any(.errors[]; test("at most 12"))' "$(cb envelope "$(ev '.actionables=[range(13) | {what:"w",kind:"info",ref:"r"}]')")"
check "cb: actionables = 12" '.ok == true' "$(cb envelope "$(ev '.actionables=[range(12) | {what:"w",kind:"info",ref:"r"}]')")"
check "cb: actionable kind enum" '.ok == false and any(.errors[]; test("kind must be decision"))' "$(cb envelope "$(ev '.actionables[0].kind="note"')")"
check "cb: envelope status enum" '.ok == false and any(.errors[]; test("status must be one of"))' "$(cb envelope "$(ev '.status="ok"')")"
check "cb: artifacts extra key" '.ok == false and any(.errors[]; test("unknown key: artifacts.bogus"))' "$(cb envelope "$(ev '.artifacts.bogus=1')")"
check "cb: actionable extra key" '.ok == false and any(.errors[]; test("actionables\\[0\\].x"))' "$(cb envelope "$(ev '.actionables[0].x=1')")"
check "cb: artifacts.details not strings" '.ok == false and any(.errors[]; test("details must be an array of strings"))' "$(cb envelope "$(ev '.artifacts.details=5')")"
check "cb: envelope missing stage" '.ok == false and any(.errors[]; test("missing key: stage"))' "$(cb envelope "$(ev 'del(.stage)')")"
check "cb: fix-report fixed item type" '.ok == false and any(.errors[]; test("fixed\\[0\\] must be a string"))' "$(cb fix-report '{"fixed":[5],"escalated":[],"skipped":[]}')"
check "cb: unknown kind" '.ok == false and any(.errors[]; test("unknown kind \"nope\""))' "$(cb nope '{}')"
check "cb: no args" '.ok == false and any(.errors[]; test("usage: check-block"))' "$("$CS/check-block.sh" 2>/dev/null)"
check "cb: kind without file" '.ok == false and any(.errors[]; test("usage: check-block"))' "$("$CS/check-block.sh" envelope 2>/dev/null)"
check "cb: empty file" '.ok == false and any(.errors[]; test("cannot read JSON"))' "$(cb step-verdict '')"
check "cb: node missing keeps one JSON line" '.ok == false and any(.errors[]; test("node not found"))' "$(PATH="$T/nopath" /bin/bash "$CS/check-block.sh" step-verdict "$CB/b.json")"
# check-block: commit boundaries and enums
check "cb: commit 6 hex" '.ok == false and any(.errors[]; test("commit must"))' "$(cb step-verdict "$(sv '.commit="abc1234"[0:6]')")"
check "cb: commit 7 hex" '.ok == true' "$(cb step-verdict "$(sv '.commit="abc1234"')")"
check "cb: commit 40 hex" '.ok == true' "$(cb step-verdict "$(sv '.commit=("a"*40)')")"
check "cb: commit 41 hex" '.ok == false and any(.errors[]; test("commit must"))' "$(cb step-verdict "$(sv '.commit=("a"*41)')")"
check "cb: commit uppercase" '.ok == false and any(.errors[]; test("commit must"))' "$(cb step-verdict "$(sv '.commit="ABC1234"')")"
check "cb: verdict enum (case)" '.ok == false and any(.errors[]; test("verdict must be one of"))' "$(cb step-verdict "$(sv '.verdict="pass"')")"
check "cb: review verdict BLOCKED" '.ok == false and any(.errors[]; test("verdict must be one of PASS\\|FAIL "))' "$(cb review-verdict "$(rv '.verdict="BLOCKED"')")"
check "cb: gate class enum" '.ok == false and any(.errors[]; test("gates\\[0\\].class must be one of"))' "$(cb step-verdict "$(sv '.gates[0].class="lint"')")"
check "cb: gate result enum" '.ok == false and any(.errors[]; test("gates\\[0\\].result must be one of"))' "$(cb step-verdict "$(sv '.gates[0].result="ok"')")"
check "cb: severity enum" '.ok == false and any(.errors[]; test("findings\\[0\\].severity must be one of"))' "$(cb review-verdict "$(rv '.verdict="FAIL" | .findings=[{severity:"P3",class:"c",location:"l",evidence:"e",smallest_fix:"f"}]')")"
# check-block: contradictory PASS
check "cb: step PASS with a failed gate" '.ok == false and any(.errors[]; test("contradictory PASS"))' "$(cb step-verdict "$(sv '.gates[0].result="fail"')")"
check "cb: review PASS with failed gate" '.ok == false and any(.errors[]; test("contradictory PASS"))' "$(cb review-verdict "$(rv '.gates[0].result="fail"')")"
check "cb: review PASS with P0 finding" '.ok == false and any(.errors[]; test("P0/P1"))' "$(cb review-verdict "$(rv '.findings=[{severity:"P0",class:"c",location:"l",evidence:"e",smallest_fix:"f"}]')")"
check "cb: review PASS with ledger gap" '.ok == false and any(.errors[]; test("ledger gap"))' "$(cb review-verdict "$(rv '.ledger_gaps=["y"]')")"
check "cb: review PASS with P2 only" '.ok == true' "$(cb review-verdict "$(rv '.findings=[{severity:"P2",class:"c",location:"l",evidence:"e",smallest_fix:"f"}]')")"
check "cb: review FAIL with P0" '.ok == true' "$(cb review-verdict "$(rv '.verdict="FAIL" | .findings=[{severity:"P0",class:"c",location:"l",evidence:"e",smallest_fix:"f"}]')")"
# check-block: malformed input never crashes (one JSON object, exit 0)
check "cb: malformed JSON" '.ok == false and any(.errors[]; test("cannot read JSON"))' "$(cb step-verdict '{not json')"
check "cb: missing file" '.ok == false and any(.errors[]; test("cannot read JSON"))' "$("$CS/check-block.sh" step-verdict "$CB/none.json")"
check "cb: top-level array" '.ok == false and .errors == ["block must be a JSON object"]' "$(cb envelope '[1]')"
check "cb: gates not an array" '.ok == false and any(.errors[]; test("gates must be an array"))' "$(cb step-verdict "$(sv '.gates="x"')")"
check "cb: gates missing" '.ok == false and any(.errors[]; test("missing key: gates"))' "$(cb step-verdict "$(sv 'del(.gates)')")"
check "cb: gate item null" '.ok == false and any(.errors[]; test("gates\\[0\\] must be an object"))' "$(cb step-verdict "$(sv '.gates=[null]')")"
check "cb: deferred item a string" '.ok == false and any(.errors[]; test("deferred\\[0\\] must be an object"))' "$(cb step-verdict "$(sv '.deferred=["x"]')")"
check "cb: proxies_used item a number" '.ok == false and any(.errors[]; test("proxies_used\\[0\\] must be an object"))' "$(cb step-verdict "$(sv '.proxies_used=[5]')")"
check "cb: findings item a string" '.ok == false and any(.errors[]; test("findings\\[0\\] must be an object"))' "$(cb review-verdict "$(rv '.findings=["x"]')")"
check "cb: escalated item a string" '.ok == false and any(.errors[]; test("escalated\\[0\\] must be an object"))' "$(cb fix-report '{"fixed":[],"escalated":["x"],"skipped":[]}')"
check "cb: actionables item null" '.ok == false and any(.errors[]; test("actionables\\[0\\] must be an object"))' "$(cb envelope "$(ev '.actionables=[null]')")"

# gates.sh (hermetic: the user's git config must not change what counts as clean)
OLD_GCG="${GIT_CONFIG_GLOBAL-}"; export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
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
check "gates: failing gate" '.ok == false and .results[0].pass == false' "$(gs "$STEP" "$GC2" "$(side '{"gates":[{"id":"a","class":"unit","cmd":"exit 3"}]}')")"
check "gates: timeout" '.ok == false and .results[0].timedOut == true' "$(gs "$STEP" "$GC2" "$(side '{"gates":[{"id":"a","class":"unit","cmd":"sleep 5","timeoutMs":200}]}')")"
H="$(side '{"gates":[{"id":"n","class":"integ","result":"n/a","reason":"r"},{"id":"d","class":"unit","cmd":"true","result":"deferred","owed_by":"s9"}]}')"
check "gates: empty runnable set fails closed" '.ok == false and (.error | test("no runnable gates")) and .skipped == ["n","d"]' "$(gs "$STEP" "$GC2" "$H")"
H="$(side '{"gates":[{"id":"a","class":"unit","cmd":"true"}]}')"
printf '%s' '{"gates":[{"id":"a","class":"unit","cmd":"true","result":"n/a"}]}' > "$SIDE"
check "gates: sidecar edited after hash" '.ok == false and (.error | test("changed since"))' "$(gs "$STEP" "$GC2" "$H")"
check "gates: relative step path" '.ok == false and (.error | test("absolute"))' "$(cd "$GR" && "$CS/gates.sh" plan/step-01-x.md "$GC2" "$H" "$GR/repo")"
check "gates: missing sha arg" '.ok == false and (.error | test("usage"))' "$(gs "$STEP" "$GC2")"
check "gates: malformed sha" '.ok == false and (.error | test("sha256"))' "$(gs "$STEP" "$GC2" "abc")"
check "gates: uppercase sha" '.ok == false and (.error | test("64 lowercase hex"))' "$(gs "$STEP" "$GC2" "$(tr a-f A-F <<< "$H")")"
check "gates: sha256sum line (with path) rejected" '.ok == false and (.error | test("64 lowercase hex"))' "$(gs "$STEP" "$GC2" "$(sha256sum "$SIDE")")"
check "gates: node missing keeps one JSON line" '.ok == false and (.error | test("node not found"))' "$(PATH="$T/nopath" "$BASH" "$CS/gates.sh" "$STEP" "$GC2" "$H")"
check "gates: missing sidecar" '.ok == false and (.error | test("unreadable"))' "$(gs "$GR/plan/nope.md" "$GC2" "$H")"
check "gates: sidecar null" '.ok == false and (.error | test("no gates array"))' "$(gs "$STEP" "$GC2" "$(side 'null')")"
check "gates: null gate skipped" '.ok == true and .skipped == [null]' "$(gs "$STEP" "$GC2" "$(side '{"gates":[null,{"id":"a","class":"unit","cmd":"true"}]}')")"
check "gates: only a null gate" '.ok == false and (.error | test("no runnable"))' "$(gs "$STEP" "$GC2" "$(side '{"gates":[null]}')")"
check "gates: bad JSON" '.ok == false and (.error | test("unreadable"))' "$(gs "$STEP" "$GC2" "$(side '{nope')")"
# gates.sh: the tree must be clean outside the plan dir (run-gates checks only HEAD).

H="$(side '{"gates":[{"id":"a","class":"unit","cmd":"test -f u"}]}')"
touch "$GR/repo/u"
check "gates: untracked file outside the plan dir" '.ok == false and (.error | test("not clean")) and (.error | test("\\?\\? u"))' "$(gs "$STEP" "$GC2" "$H")"
gg config status.showUntrackedFiles no
check "gates: untracked file seen under showUntrackedFiles=no" '.ok == false and (.error | test("\\?\\? u"))' "$(gs "$STEP" "$GC2" "$H")"
gg config --unset status.showUntrackedFiles; rm "$GR/repo/u"
check "gates: clean tree, gate sees no stray file" '.ok == false and .results[0].pass == false' "$(gs "$STEP" "$GC2" "$H")"
check "gates: HEAD mismatch says never detach" '.ok == false and (.error | test("move the branch there"))' "$(gs "$STEP" "$GC1" "$H")"
echo a2 > "$GR/repo/a"
check "gates: modified tracked file" '.ok == false and (.error | test(" M a"))' "$(gs "$STEP" "$GC2" "$H")"
gg add a
check "gates: staged-only change" '.ok == false and (.error | test("M  a"))' "$(gs "$STEP" "$GC2" "$H")"
gg reset -q a; gg checkout -q -- a
check "gates: git failure is not clean" '.ok == false and (.error | test("git rev-parse failed"))' "$("$CS/gates.sh" "$STEP" "$GC2" "$H" "$GR/plan")"
mkdir -p "$T/nodeonly"; ln -sf "$(node -p process.execPath)" "$T/nodeonly/node"
check "gates: git missing gives a reason" '.ok == false and (.error | test("ENOENT"))' "$(cd "$GR/repo" && PATH="$T/nodeonly" "$T/nodeonly/node" "$CS/gates.mjs" "$STEP" "$GC2" "$H")"
check "gates: coreutils missing keeps one JSON line" '.ok == false and (.error | test("readlink"))' "$(PATH="$T/nodeonly" "$BASH" "$CS/gates.sh" "$STEP" "$GC2" "$H")"
check "cb: coreutils missing keeps one JSON line" '.ok == false and any(.errors[]; test("readlink"))' "$(PATH="$T/nodeonly" "$BASH" "$CS/check-block.sh" step-verdict "$CB/b.json")"
# Plan dirs inside the repo: the plan dir and untracked sibling plan dirs (PROGRESS.md/plan.json/spec.md) are excluded.
pl() { mkdir -p "$GR/repo/$1"; cp "$STEP" "$GR/repo/$1/step-01-x.md"; printf '%s' '{"gates":[{"id":"a","class":"unit","cmd":"true"}]}' > "$GR/repo/$1/step-01-x.gates.json"; }
PH="$(printf '%s' '{"gates":[{"id":"a","class":"unit","cmd":"true"}]}' | sha256sum | cut -d' ' -f1)"
pl plans/foo; mkdir -p "$GR/repo/plans/bar"; echo x > "$GR/repo/plans/bar/PROGRESS.md"
check "gates: untracked plans/<name> with a sibling plan dir is clean" '.ok == true' "$(gs "$GR/repo/plans/foo/step-01-x.md" "$GC2" "$PH")"
pl docs/p
check "gates: other plan roots are not excluded" '.ok == false and (.error | test("plans/bar/PROGRESS.md"))' "$(gs "$GR/repo/docs/p/step-01-x.md" "$GC2" "$PH")"
rm -rf "$GR/repo/plans" "$GR/repo/docs"
pl .agent-plans/foo; mkdir -p "$GR/repo/.agent-plans/bar"; echo x > "$GR/repo/.agent-plans/bar/PROGRESS.md"
check "gates: .agent-plans sibling is clean" '.ok == true' "$(gs "$GR/repo/.agent-plans/foo/step-01-x.md" "$GC2" "$PH")"
rm -rf "$GR/repo/.agent-plans"
pl x/y/plans/foo; mkdir -p "$GR/repo/x/y/plans/bar"; echo x > "$GR/repo/x/y/plans/bar/plan.json"
check "gates: nested plans root sibling is clean" '.ok == true' "$(gs "$GR/repo/x/y/plans/foo/step-01-x.md" "$GC2" "$PH")"
echo x > "$GR/repo/x/y/plans/notes.md"; mkdir -p "$GR/repo/x/y/plans/misc"; echo x > "$GR/repo/x/y/plans/misc/m.py"
check "gates: non-plan siblings under the plan parent count" '.ok == false and (.paths | index("?? x/y/plans/notes.md")) and (.paths | index("?? x/y/plans/misc/m.py"))' "$(gs "$GR/repo/x/y/plans/foo/step-01-x.md" "$GC2" "$PH")"
rm -rf "$GR/repo/x"
pl scratch/plan; echo x > "$GR/repo/scratch/new.py"
check "gates: all-untracked parent is not excluded wholesale" '.ok == false and (.paths == ["?? scratch/new.py"])' "$(gs "$GR/repo/scratch/plan/step-01-x.md" "$GC2" "$PH")"
rm -rf "$GR/repo/scratch"
mkdir -p "$GR/repo/plans/done"; echo d > "$GR/repo/plans/done/PROGRESS.md"; gg add plans/done; gg commit -qm done; GCD="$(gg rev-parse HEAD)"
pl plans/foo; mkdir -p "$GR/repo/plans/bar"; echo x > "$GR/repo/plans/bar/PROGRESS.md"
check "gates: committed finished plan next to untracked ones is clean" '.ok == true' "$(gs "$GR/repo/plans/foo/step-01-x.md" "$GCD" "$PH")"
gg rm -q --cached plans/done/PROGRESS.md
check "gates: sibling removed from the index still counts" '.ok == false and (.paths | index("D  plans/done/PROGRESS.md")) and (.paths | index("?? plans/done/PROGRESS.md"))' "$(gs "$GR/repo/plans/foo/step-01-x.md" "$GCD" "$PH")"
gg reset -q; rm -rf "$GR/repo/plans/foo" "$GR/repo/plans/bar"; gg rm -rq plans; gg commit -qm undone
mkdir -p "$GR/repo/src"; echo t > "$GR/repo/src/t"; gg add src/t; gg commit -qm src; GC3="$(gg rev-parse HEAD)"
pl src/plan; echo x > "$GR/repo/src/conftest.py"
check "gates: tracked parent of the plan dir is not excluded" '.ok == false and (.error | test("src/conftest.py"))' "$(gs "$GR/repo/src/plan/step-01-x.md" "$GC3" "$PH")"
rm -rf "$GR/repo/src/plan" "$GR/repo/src/conftest.py"
check "gates: plan dir at the repo root is rejected" '.ok == false and (.error | test("repo root"))' "$("$CS/gates.sh" --clean "$GR/repo" "$GR/repo")"
# --clean, --stage, --wtdir
GP="$GR/plan"
check "gates --clean: clean" '.ok == true and .paths == []' "$("$CS/gates.sh" --clean "$GP" "$GR/repo")"
check "gates --clean: relative plan dir" '.ok == false and (.error | test("absolute"))' "$("$CS/gates.sh" --clean plan "$GR/repo")"
check "gates --clean: relative --stage" '.ok == false and (.error | test("--stage must be an absolute"))' "$("$CS/gates.sh" --clean "$GP" "$GR/repo" --stage .stage)"
mkdir -p "$GR/repo/.stage/run-1"; echo '{}' > "$GR/repo/.stage/run-1/brief.json"
check "gates --clean: stage dir outside the plan dir is dirty" '.ok == false and (.paths | index("?? .stage/run-1/brief.json"))' "$("$CS/gates.sh" --clean "$GP" "$GR/repo")"
check "gates --clean: --stage excludes it" '.ok == true' "$("$CS/gates.sh" --clean "$GP" "$GR/repo" --stage "$GR/repo/.stage")"
check "gates: --stage on a gate run" '.ok == false and .results[0].pass == false' "$(gs "$STEP" "$GC3" "$H" --stage "$GR/repo/.stage")"
rm -rf "$GR/repo/.stage"
gg worktree add -q -b lane/x "$GR/repo/.wt/lane-x" "$GC3"
check "gates --clean: unignored lane worktree without --wtdir is dirty" '.ok == false and (.paths | index("?? .wt/lane-x/"))' "$("$CS/gates.sh" --clean "$GP" "$GR/repo")"
check "gates --clean: --wtdir excludes registered lanes" '.ok == true' "$("$CS/gates.sh" --clean "$GP" "$GR/repo" --wtdir "$GR/repo/.wt")"
echo s > "$GR/repo/.wt/stray"
check "gates --clean: stray file in wtdir still dirty" '.ok == false and .paths == ["?? .wt/stray"]' "$("$CS/gates.sh" --clean "$GP" "$GR/repo" --wtdir "$GR/repo/.wt")"
rm "$GR/repo/.wt/stray"
gg worktree add -q -b lane/h "$GR/repo/src/hidden" "$GC3"
check "gates --clean: worktree outside --wtdir still dirty" '.ok == false and (.paths | index("?? src/hidden/"))' "$("$CS/gates.sh" --clean "$GP" "$GR/repo" --wtdir "$GR/repo/.wt")"
gg worktree remove --force "$GR/repo/src/hidden"
echo l > "$GR/repo/.wt/lane-x/dirt"
check "gates --clean: lane checked as its own repo" '.ok == false and .paths == ["?? dirt"]' "$("$CS/gates.sh" --clean "$GP" "$GR/repo/.wt/lane-x" --wtdir "$GR/repo/.wt")"
gg worktree remove --force "$GR/repo/.wt/lane-x"; gg branch -qD lane/x lane/h; rmdir "$GR/repo/.wt"
mkdir -p "$GR/repo/pkg/__pycache__"; echo c > "$GR/repo/pkg/__pycache__/m.pyc"
GC3="$(gg rev-parse HEAD)"
check "gates: by-product hint" '.ok == false and .allByproducts == true and .byproducts == ["?? pkg/__pycache__/m.pyc"] and (.hint | test("ignore them"))' "$(gs "$STEP" "$GC3" "$H")"
echo a3 > "$GR/repo/a"
check "gates --clean: tracked edit next to by-products is not all by-products" '.ok == false and .allByproducts == false and .byproducts == ["?? pkg/__pycache__/m.pyc"]' "$("$CS/gates.sh" --clean "$GR/plan" "$GR/repo")"
gg checkout -q -- a; rm -rf "$GR/repo/pkg"
# Index flags and ignore sources a worker could use to hide changes.
echo hidden > "$GR/repo/a"; gg update-index --skip-worktree a
check "gates --clean: skip-worktree edit counts" '.ok == false and .paths == [" M a (skip-worktree)"]' "$("$CS/gates.sh" --clean "$GR/plan" "$GR/repo")"
gg update-index --no-skip-worktree a; gg update-index --assume-unchanged a
check "gates --clean: assume-unchanged edit counts" '.ok == false and .paths == [" M a (assume-unchanged)"]' "$("$CS/gates.sh" --clean "$GR/plan" "$GR/repo")"
gg checkout -q -- a 2>/dev/null; echo a > "$GR/repo/a"
check "gates --clean: assume-unchanged without an edit is clean" '.ok == true' "$("$CS/gates.sh" --clean "$GR/plan" "$GR/repo")"
gg update-index --no-assume-unchanged a
mkdir -p "$GR/repo/src2"; printf '*\n' > "$GR/repo/src2/.gitignore"; echo x > "$GR/repo/src2/b.py"
check "gates --clean: self-ignoring .gitignore counts" '.ok == false and .paths == ["?? src2/.gitignore"]' "$("$CS/gates.sh" --clean "$GR/plan" "$GR/repo")"
rm -rf "$GR/repo/src2"
IS="$("$CS/gates.sh" --clean "$GR/plan" "$GR/repo" | jq -r .ignoreSha)"
check "gates --clean: same ignore rules keep the hash" '.ok == true' "$("$CS/gates.sh" --clean "$GR/plan" "$GR/repo" --ignore-sha "$IS")"
cp "$GR/repo/.git/info/exclude" "$T/exclude.bak"; echo 'u' >> "$GR/repo/.git/info/exclude"; touch "$GR/repo/u"
check "gates: info/exclude edited after recording" '.ok == false and (.error | test("ignore rules changed"))' "$(gs "$STEP" "$GC3" "$H" --ignore-sha "$IS")"
cp "$T/exclude.bak" "$GR/repo/.git/info/exclude"; rm "$GR/repo/u"
check "gates: malformed --ignore-sha" '.ok == false and (.error | test("ignore-sha needs"))' "$(gs "$STEP" "$GC3" "$H" --ignore-sha abc)"
# Exclusion candidates are bounded.
check "gates --clean: --stage at the repo root" '.ok == false and (.error | test("--stage is the repo root"))' "$("$CS/gates.sh" --clean "$GR/plan" "$GR/repo" --stage "$GR/repo")"
check "gates --clean: --stage holding tracked files" '.ok == false and (.error | test("holds tracked files"))' "$("$CS/gates.sh" --clean "$GR/plan" "$GR/repo" --stage "$GR/repo/src")"
ln -s src "$GR/repo/lnk"
check "gates --clean: symlinked --stage" '.ok == false and (.error | test("must not be a symlink"))' "$("$CS/gates.sh" --clean "$GR/plan" "$GR/repo" --stage "$GR/repo/lnk")"
check "gates --clean: symlinked plan dir" '.ok == false and (.error | test("plan dir must not be a symlink"))' "$("$CS/gates.sh" --clean "$GR/repo/lnk" "$GR/repo")"
check "gates --clean: --wtdir at the repo root" '.ok == false and (.error | test("--wtdir is the repo root"))' "$("$CS/gates.sh" --clean "$GR/plan" "$GR/repo" --wtdir "$GR/repo")"
rm "$GR/repo/lnk"
# A submodule's dirt counts even when the user's config ignores submodules.
SM="$T/gr-sub"; git init -q -b main "$SM"; echo s > "$SM/s"; git -C "$SM" add s; git -C "$SM" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm s
gg -c protocol.file.allow=always submodule --quiet add "$SM" sub; gg commit -qm sub; GC4="$(gg rev-parse HEAD)"
echo dirt > "$GR/repo/sub/s"; gg config diff.ignoreSubmodules all
check "gates --clean: dirty submodule under diff.ignoreSubmodules=all" '.ok == false and (.paths | index(" M sub"))' "$("$CS/gates.sh" --clean "$GP" "$GR/repo")"
gg config --unset diff.ignoreSubmodules
if [ -n "$OLD_GCG" ]; then export GIT_CONFIG_GLOBAL="$OLD_GCG"; else unset GIT_CONFIG_GLOBAL; fi; unset GIT_CONFIG_NOSYSTEM

# claude-install.sh (always --dir into the temp dir, never ~/.claude)
CI="$T/ci"; mkdir -p "$CI/real"
cp "$ROOT/claude-install.sh" "$CI/real/"; mkdir -p "$CI/real/claude/skills/sk" "$CI/real/claude/agents" "$CI/real/skills/sk" "$CI/real/skills/old"
echo a > "$CI/real/claude/agents/wf-a.md"
ln -s real "$CI/link"
inst() { "$@" 2>&1; echo "rc=$?"; }
o="$(inst "$ROOT/claude-install.sh" --help)"
if grep -q '^Usage: claude-install.sh' <<< "$o" && grep -q 'rc=0' <<< "$o"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: install: --help"; echo "$o"; fi
o="$(inst "$ROOT/claude-install.sh" --bogus --dir "$T/ci-bad")"
if grep -q '^Unknown option: --bogus' <<< "$o" && grep -q 'rc=1' <<< "$o" && [ ! -e "$T/ci-bad" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: install: unknown option"; echo "$o"; fi
# The real tree: every skill and agent is linked (10 skills + 9 agents).
o="$(inst "$ROOT/claude-install.sh" --dir "$T/ci-real")"
if [ "$(grep -c '^linked' <<< "$o")" = 19 ] && [ "$(ls "$T/ci-real/skills" | wc -l)" = 10 ] && [ "$(ls "$T/ci-real/agents" | wc -l)" = 9 ] && grep -q 'rc=0' <<< "$o"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: install: real tree 10+9"; echo "$o"; fi
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
# A dangling link (moved checkout) is never adopted or removed: the installer leaves it and prints a removal hint.
mkdir -p "$CI/t5/skills" "$CI/t5/agents"; ln -s "$CI/gone/claude/skills/sk" "$CI/t5/skills/sk"
o="$(inst "$CI/real/claude-install.sh" --dir "$CI/t5")"
if grep -q "^conflict  $CI/t5/skills/sk  (dangling symlink to $CI/gone/claude/skills/sk.*rm '$CI/t5/skills/sk'" <<< "$o" && [ "$(readlink "$CI/t5/skills/sk")" = "$CI/gone/claude/skills/sk" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: install: dangling link left with a hint"; echo "$o"; fi
o="$(inst "$CI/real/claude-install.sh" --dir "$CI/t5" --uninstall)"
if grep -q "^skipped   $CI/t5/skills/sk  (dangling symlink to .*rm '$CI/t5/skills/sk'" <<< "$o" && [ -L "$CI/t5/skills/sk" ] && grep -q "^removed   $CI/t5/agents/wf-a.md" <<< "$o"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: install: uninstall leaves a dangling link with a hint"; echo "$o"; fi
