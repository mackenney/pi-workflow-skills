# execute-step resume points, reviewer-infra retry, commit pattern; host scripts commit-check, run-gates, write-artifact read.
# Sourced by tests/scripts.test.sh (check, pass/fail, $S, $T, $ROOT, ledger()).

RA="$T/ra"; mkdir -p "$RA/repo"
g() { git -C "$RA/repo" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }
g init -q -b main
echo a > "$RA/repo/a"; g add a; g commit -qm base; C0="$(g rev-parse HEAD)"
echo b > "$RA/repo/b"; g add b; g commit -qm work; C1="$(g rev-parse HEAD)"
g checkout -q --orphan other; echo z > "$RA/repo/z"; g add z; g commit -qm unrelated; CX="$(g rev-parse HEAD)"
g checkout -q main

# commit-check
cc() { (cd "$RA/repo" && "$S/commit-check.sh" <<< "$1"); }
check "commit-check: descendant" '.ok == true and .commit == "'"$C1"'" and .base == "'"$C0"'"' "$(cc '{"commit":"'"${C1:0:8}"'","base":"'"$C0"'"}')"
check "commit-check: base itself" '.ok == true' "$(cc '{"commit":"'"$C0"'","base":"'"$C0"'"}')"
check "commit-check: unrelated commit" '.ok == false and (.error | test("does not descend"))' "$(cc '{"commit":"'"$CX"'","base":"'"$C0"'"}')"
check "commit-check: ancestor is not a descendant" '.ok == false' "$(cc '{"commit":"'"$C0"'","base":"'"$C1"'"}')"
check "commit-check: missing commit" '.ok == false and (.error | test("does not exist"))' "$(cc '{"commit":"deadbeefdeadbeef","base":"'"$C0"'"}')"
check "commit-check: non-hex commit" '.ok == false' "$(cc '{"commit":"HEAD","base":"'"$C0"'"}')"
check "commit-check: option-like base" '.ok == false' "$(cc '{"commit":"'"$C1"'","base":"--all"}')"
check "commit-check: repo arg" '.ok == true' "$("$S/commit-check.sh" <<< '{"commit":"'"$C1"'","base":"'"$C0"'","repo":"'"$RA/repo"'"}')"

# run-gates
rg() { (cd "$RA/repo" && "$S/run-gates.sh" <<< "$1"); }
check "run-gates: all pass at HEAD" '.ok == true and (.results | length) == 2 and all(.results[]; .pass)' "$(rg '{"commit":"'"$C1"'","gates":[{"id":"a","command":"true"},{"id":"b","command":"test -f b"}]}')"
check "run-gates: failing gate" '.ok == false and .results[1].pass == false and .results[1].exitCode == 3 and (.results[1].tail | test("oops"))' "$(rg '{"commit":"'"$C1"'","gates":[{"id":"a","command":"true"},{"id":"b","command":"echo oops; exit 3"}]}')"
check "run-gates: timeout" '.ok == false and .results[0].timedOut == true' "$(rg '{"commit":"'"$C1"'","gates":[{"id":"a","command":"sleep 5","timeoutMs":200}]}')"
check "run-gates: HEAD is not the commit" '.ok == false and (.error | test("check the commit out"))' "$(rg '{"commit":"'"$C0"'","gates":[{"id":"a","command":"true"}]}')"
check "run-gates: empty gates" '.ok == false' "$(rg '{"commit":"'"$C1"'","gates":[]}')"

# write-artifact read
echo '{"state":"BLOCKED","ledger":{"step":"s"}}' > "$T/prior.json"
check "write-artifact: read" '.ok == true and .json.ledger.step == "s"' "$(echo '{"read":"'"$T"'/prior.json"}' | "$S/write-artifact.sh")"
check "write-artifact: read rejects .md" '.ok == false' "$(echo '{"read":"'"$T"'/x.md"}' | "$S/write-artifact.sh")"
check "write-artifact: read rejects dotdot" '.ok == false' "$(echo '{"read":"'"$T"'/../prior.json"}' | "$S/write-artifact.sh")"
check "write-artifact: read missing" '.ok == false' "$(echo '{"read":"'"$T"'/nope.json"}' | "$S/write-artifact.sh")"
check "host-command allows commit-check" '.ok == false and (.error | test("commit must"))' "$(env_task '{"script":"commit-check","commit":"x","base":"y"}' | "$S/host-command.sh")"
check "host-command allows run-gates" '.ok == false and (.error | test("gates must"))' "$(env_task '{"script":"run-gates","commit":"abc1234","gates":[]}' | "$S/host-command.sh")"

# verdict schemas: commit must be empty or a sha, in both workflows
for wf in execute-step execute-wave; do
  if grep -q 'const COMMIT = { type: "string", pattern: "^(\[0-9a-f\]{7,40})?\$" }' "$ROOT/workflows/$wf.js" && [ "$(grep -c 'commit: COMMIT' "$ROOT/workflows/$wf.js")" = 2 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $wf verdict commit pattern"; fi
done

# execute-step behaviour under a stub runtime: model children answer from a scenario table, wf-host-command children run
# the real host scripts in the test repo. Keys absent from the table are a test failure (an unexpected launch).
cat > "$T/wf-harness.mjs" <<'JS'
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const [wfPath, argsJson, scenarioJson, repo, scripts] = process.argv.slice(2);
const scenario = JSON.parse(scenarioJson);
const calls = [];
// Mirrors pi-subagents scripted-workflow.js: every child settles to a result; runs.run then throws on a failed one
// (losing structuredOutput/runId), while runs.all with config objects (collectFailure) returns the failed result.
// "reject" in the scenario is a child that failed with no output. Keys absent from the table reject either way.
const launch = (key, item, via) => {
  calls.push({ key, via, agent: item.agent ?? null, resume: item.resume ?? null, hasSchema: !!item.outputSchema, hasAcceptance: !!item.acceptance });
  if (item.agent === "wf-host-command") {
    const task = JSON.parse(item.task);
    const r = spawnSync(scripts + "/" + task.script + ".sh", { input: JSON.stringify(task), cwd: repo, encoding: "utf8" });
    return Promise.resolve({ ok: r.status === 0, output: r.stdout, runId: key, ...(r.status === 0 ? {} : { error: "exit " + r.status }) });
  }
  const resp = scenario[key];
  if (resp === undefined) return Promise.reject(new Error("unexpected launch " + key));
  if (resp === "reject") return Promise.resolve({ ok: false, error: "child failed: " + key, runId: "run-" + key });
  return Promise.resolve({ runId: "run-" + key, ...resp });
};
const runs = {
  run(key, item) {
    return launch(key, item, "run").then((r) => {
      const recoverable = r.recovery?.status === "available-for-review" && r.recovery.reason === "acceptance-metadata-rejected";
      if (!r.ok && r.state !== "running" && !r.stopped && !recoverable) throw new Error("Run '" + key + "' failed: " + (r.error ?? r.output));
      return r;
    });
  },
  all(items) { return Promise.all(items.map(({ key, ...item }) => launch(key, item, "all"))); }
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const env = await new AsyncFunction("args", "runs", "state", fs.readFileSync(wfPath, "utf8"))(JSON.parse(argsJson), runs, undefined);
let result = null;
const args = JSON.parse(argsJson);
try { result = JSON.parse(fs.readFileSync((args.stageDir) + "/result.json", "utf8")); } catch {}
process.stdout.write(JSON.stringify({ env, calls: calls.map((c) => c.key), callInfo: calls, result }));
JS
PD="$RA/repo/plan"; mkdir -p "$PD"
mk_step() { # gate-cmd
  jq -n --arg c0 "$C0" --arg cmd "$1" '{step:"step-01-x",tier:"standard",base_commit:$c0,gates:[{id:"g-unit-1",class:"unit",cmd:$cmd}],coverage:[{row:"r",gate:"g-unit-1"}],hard_splits_declared:[]}' > "$PD/step-01-x.gates.json"
  printf '# step-01-x\n' > "$PD/step-01-x.md"
  ledger "$PD/PROGRESS.md" "" "" $'## Steps\n- [ ] [step-01-x](./step-01-x.md)'
}
n=0
wf() { # args-json-extra scenario-json
  n=$((n+1)); local sd="$RA/stage-$n"
  local a; a="$(jq -c --arg sf "$PD/step-01-x.md" --arg pd "$PD" --arg sd "$sd" '{stepFile:$sf, planDir:$pd, stageDir:$sd} + .' <<< "$1")"
  node "$T/wf-harness.mjs" "$ROOT/workflows/execute-step.js" "$a" "$2" "$RA/repo" "$S"
}
SV() { jq -nc --arg v "$1" --arg c "$2" '{verdict:$v, step:"step-01-x", commit:$c, gates:[{id:"g-unit-1",class:"unit",result:"pass"}], coverage:[], proxies_used:[], deferred:[], decisions_taken:[], pending_decisions:[], residual_risks:[]}'; }
RV() { jq -nc --arg v "$1" --arg c "$2" '{verdict:$v, step:"step-01-x", commit:$c, gates:[{id:"g-unit-1",class:"unit",result:"pass"}], findings:(if $v == "FAIL" then [{severity:"P1",class:"bug",location:"b",evidence:"wrong",smallest_fix:"fix"}] else [] end), ledger_gaps:[]}'; }
IMPL_OK="{\"ok\":true,\"structuredOutput\":$(SV PASS "$C1")}"
REV_PASS="{\"ok\":true,\"structuredOutput\":$(RV PASS "$C1")}"
REV_FAIL="{\"ok\":true,\"structuredOutput\":$(RV FAIL "$C1")}"

mk_step true
out="$(wf '{}' "{\"implement\":$IMPL_OK,\"review-0\":{\"ok\":false,\"error\":\"reviewer crashed\"},\"review-0-retry\":\"reject\"}")"
check "es: reviewer crashes twice -> blocked, no fix round" '.env.status == "blocked" and .result.stage == "review" and (.calls | index("fix-1") | not) and .result.resumePoint.from == "review" and .result.resumePoint.commit == "'"$C1"'" and .result.resumePoint.workerRunId == "run-implement"' "$out"
check "es: blocked review envelope carries resume actionable" 'any(.env.actionables[]; .kind == "fix" and (.what | startswith("resume from review at '"$C1"'")))' "$out"
out="$(wf '{}' "{\"implement\":$IMPL_OK,\"review-0\":{\"ok\":false},\"review-0-retry\":$REV_PASS}")"
check "es: reviewer crash then pass -> done, ledger ticked" '.env.status == "done" and (.calls | index("fix-1") | not) and .result.ledgerApply.applied.ticked == ["step-01-x"] and (.result | has("resumePoint") | not)' "$out"
mk_step true
out="$(wf '{"maxFixRounds":0}' "{\"implement\":$IMPL_OK,\"review-0\":$REV_FAIL}")"
check "es: review FAIL after last round -> resume from fix" '.env.status == "failed" and .result.resumePoint.from == "fix" and .result.resumePoint.args.resume.resultPath == (.result.resumePoint.args.stageDir | sub("-resume-fix$"; "")) + "/result.json" and .result.resumePoint.args.resume.workerRunId == "run-implement"' "$out"
out="$(wf '{}' "{\"implement\":{\"ok\":false,\"error\":\"verify g-unit-1 failed\",\"structuredOutput\":$(SV PASS "$C1")}}")"
check "es: runtime gates reject a claimed PASS -> resume from gates" '.env.status == "failed" and .result.resumePoint.from == "gates" and .result.stage == "implement"' "$out"
out="$(wf '{}' "{\"implement\":{\"ok\":true,\"structuredOutput\":$(SV FAIL "$C1")}}")"
check "es: worker FAIL with commit -> resume from fix" '.result.resumePoint.from == "fix"' "$out"
out="$(wf '{}' "{\"implement\":{\"ok\":true,\"structuredOutput\":$(SV FAIL "")}}")"
check "es: FAIL without commit -> no resume point" '.result.resumePoint == null and (any(.env.actionables[]; .what | startswith("resume")) | not)' "$out"

# resume entry checks (fail closed before any model launch)
out="$(wf "{\"resume\":{\"from\":\"review\",\"commit\":\"$CX\"}}" '{}')"
check "es resume: unrelated commit -> blocked, no launch" '.env.status == "blocked" and .result.stage == "resume" and (.result.reason | test("does not descend")) and .calls == ["gates","resume-check","persist"]' "$out"
out="$(wf '{"resume":{"from":"review","commit":"deadbeefdeadbeef"}}' '{}')"
check "es resume: missing commit -> blocked" '.env.status == "blocked" and (.result.reason | test("does not exist"))' "$out"
out="$(wf "{\"resume\":{\"from\":\"nope\",\"commit\":\"$C1\"}}" '{}')"
check "es resume: bad from -> blocked" '.env.status == "blocked" and .result.stage == "resume"' "$out"
out="$(wf "{\"resume\":{\"from\":\"review\",\"commit\":\"$C1\",\"extra\":1}}" '{}')"
check "es resume: unknown key -> blocked" '.env.status == "blocked" and (.result.reason | test("unknown keys: extra"))' "$out"
out="$(wf "{\"resume\":{\"from\":\"ci\",\"commit\":\"$C1\"}}" '{}')"
check "es resume: ci without pr -> blocked" '.env.status == "blocked" and (.result.reason | test("needs pr"))' "$out"
out="$(wf "{\"resume\":{\"from\":\"ledger\",\"commit\":\"$C1\"}}" '{}')"
check "es resume: ledger without resultPath -> blocked" '.env.status == "blocked" and (.result.reason | test("resultPath"))' "$out"

# resume paths
mk_step 'test -f b'
out="$(wf "{\"resume\":{\"from\":\"gates\",\"commit\":\"$C1\",\"workerRunId\":\"w1\"}}" "{\"review-0\":$REV_PASS}")"
check "es resume gates: gates re-run, reviewed, done" '.env.status == "done" and .calls == ["gates","resume-check","resume-gates","review-0","ledger","persist"] and .result.ledger.gates[0].result == "pass" and .result.resumedFrom == "gates"' "$out"
mk_step false
out="$(wf "{\"resume\":{\"from\":\"gates\",\"commit\":\"$C1\",\"workerRunId\":\"w1\"}}" '{}')"
check "es resume gates: still failing -> resume from fix" '.env.status == "failed" and .result.stage == "gates" and .result.resumePoint.from == "fix" and .result.resumePoint.workerRunId == "w1"' "$out"
mk_step true
out="$(wf "{\"resume\":{\"from\":\"review\",\"commit\":\"$C1\",\"workerRunId\":\"w1\"}}" "{\"review-0\":$REV_FAIL,\"fix-1\":$IMPL_OK,\"review-1\":$REV_PASS}")"
check "es resume review: fix round resumes the given worker" '.env.status == "done" and (.callInfo[] | select(.key == "fix-1") | .resume == "w1" and .hasSchema and .hasAcceptance)' "$out"
out="$(wf "{\"resume\":{\"from\":\"fix\",\"commit\":\"$C1\",\"workerRunId\":\"w1\",\"guidance\":\"use X\"}}" "{\"resume-fix\":$IMPL_OK,\"review-0\":$REV_PASS}")"
check "es resume fix: continues retained worker with schema+acceptance" '.env.status == "done" and (.calls | index("resume-fresh") | not) and (.callInfo[] | select(.key == "resume-fix") | .resume == "w1" and .hasSchema and .hasAcceptance)' "$out"
out="$(wf "{\"resume\":{\"from\":\"fix\",\"commit\":\"$C1\",\"workerRunId\":\"w1\"}}" "{\"resume-fix\":\"reject\",\"resume-fresh\":$IMPL_OK,\"review-0\":$REV_PASS}")"
check "es resume fix: failed resume -> fresh worker" '.env.status == "done" and (.callInfo[] | select(.key == "resume-fresh") | .resume == null and .hasSchema and .hasAcceptance)' "$out"
out="$(wf "{\"resume\":{\"from\":\"fix\",\"commit\":\"$C1\"}}" "{\"resume-fresh\":$IMPL_OK,\"review-0\":$REV_PASS}")"
check "es resume fix: no workerRunId -> fresh worker only" '.env.status == "done" and (.calls | index("resume-fix") | not)' "$out"

# ledger resume: a PASS whose ledger-apply failed (ledger file missing), then resumed after the file is restored
rm "$PD/PROGRESS.md"
out="$(wf '{}' "{\"implement\":$IMPL_OK,\"review-0\":$REV_PASS}")"
check "es: ledger failure after PASS -> resume from ledger" '.env.status == "blocked" and .result.stage == "ledger" and .result.resumePoint.from == "ledger"' "$out"
args_json="$(jq -c '.result.resumePoint.args | del(.stepFile, .planDir)' <<< "$out")"
ledger "$PD/PROGRESS.md" "" "" $'## Steps\n- [ ] [step-01-x](./step-01-x.md)'
out="$(wf "$args_json" '{}')"
check "es resume ledger: applies prior ledger, no model launch" '.env.status == "done" and .calls == ["gates","resume-check","resume-read","ledger","persist"] and .result.ledgerApply.applied.ticked == ["step-01-x"]' "$out"
echo "{\"ledger\":{\"step\":\"step-01-x\",\"commit\":\"$C0\"}}" > "$RA/other.json"
out="$(wf "{\"resume\":{\"from\":\"ledger\",\"commit\":\"$C1\",\"resultPath\":\"$RA/other.json\"}}" '{}')"
check "es resume ledger: prior ledger for another commit -> blocked" '.env.status == "blocked" and (.result.reason | test("not '"$C1"'"))' "$out"

# ci resume: reads CI bound to the resume commit (stub gh from scripts.test.sh), then ticks with a bare ledger
mk_step true
out="$(STUB_HEAD="$C1" STUB_CHECKS='[{"name":"a","bucket":"pass"}]' PI_WF_GH="$T/bin/gh" wf "{\"pr\":1,\"resume\":{\"from\":\"ci\",\"commit\":\"$C1\"}}" '{}')"
check "es resume ci: green -> done, no model launch" '.env.status == "done" and .calls == ["gates","resume-check","ci","ledger","persist"] and .result.ledgerApply.applied.ticked == ["step-01-x"]' "$out"
mk_step true
out="$(STUB_HEAD="$C0" STUB_CHECKS='[{"name":"a","bucket":"pass"}]' PI_WF_GH="$T/bin/gh" wf "{\"pr\":1}" "{\"implement\":$IMPL_OK,\"review-0\":$REV_PASS}")"
check "es: stale CI -> resume from ci" '.env.status == "blocked" and .result.stage == "ci" and .result.resumePoint.from == "ci" and .result.resumePoint.args.pr == 1' "$out"

# execute-wave: reviewer crash is retried once and never turns a lane into FAIL; PASS without a commit is FAIL
ww() { n=$((n+1)); node "$T/wf-harness.mjs" "$ROOT/workflows/execute-wave.js" "$(jq -nc --arg sf "$PD/step-01-x.md" --arg pd "$PD" --arg sd "$RA/stage-$n" '{stepFiles:[$sf], planDir:$pd, stageDir:$sd}')" "$1" "$RA/repo" "$S"; }
out="$(ww "{\"impl-step-01-x\":$IMPL_OK,\"review-step-01-x\":\"reject\",\"review-step-01-x-retry\":{\"ok\":false}}")"
check "ew: reviewer crashes twice -> lane BLOCKED" '.result.board[0].state == "BLOCKED" and (.result.board[0].error | test("infrastructure"))' "$out"
out="$(ww "{\"impl-step-01-x\":$IMPL_OK,\"review-step-01-x\":\"reject\",\"review-step-01-x-retry\":$REV_PASS}")"
check "ew: reviewer crash then pass -> lane PASS" '.result.board[0].state == "PASS" and .env.status == "done"' "$out"
out="$(ww "{\"impl-step-01-x\":{\"ok\":true,\"structuredOutput\":$(SV PASS "")}}")"
check "ew: PASS without commit -> FAIL" '.result.board[0].state == "FAIL" and .result.board[0].error == "PASS without a commit sha" and (.calls | index("review-step-01-x") | not)' "$out"
