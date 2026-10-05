# Failed model children keep their structuredOutput/runId: runs.run rejects on !ok with only a message, so workflows
# launch them through runs.all. Reuses lane-a's stub runtime (wf, ww, SV, RV, mk_step, $C1), which rejects like the real one.

mk_step true
FAIL_C1="$(SV FAIL "$C1")"
out="$(wf '{}' "{\"implement\":{\"ok\":false,\"error\":\"acceptance rejected: verify g-unit-1 failed\",\"structuredOutput\":$FAIL_C1}}")"
check "e: acceptance-rejected worker FAIL+commit -> resume from fix with commit and worker" '.env.status == "failed" and .result.stage == "implement" and .result.verdict.commit == "'"$C1"'" and .result.resumePoint.from == "fix" and .result.resumePoint.commit == "'"$C1"'" and .result.resumePoint.workerRunId == "run-implement" and .result.resumePoint.args.resume.workerRunId == "run-implement"' "$out"
check "e: failed implement envelope offers resume from fix" 'any(.env.actionables[]; .what | startswith("resume from fix at '"$C1"'"))' "$out"
check "e: implement launched via runs.all" '(.callInfo[] | select(.key == "implement") | .via) == "all"' "$out"

out="$(wf '{}' "{\"implement\":$IMPL_OK,\"review-0\":$REV_FAIL,\"fix-1\":{\"ok\":false,\"error\":\"acceptance rejected\",\"structuredOutput\":$FAIL_C1}}")"
check "e: failed fix round keeps its runId for resume" '.result.stage == "fix" and .result.runId == "run-fix-1" and .result.resumePoint.from == "fix" and .result.resumePoint.workerRunId == "run-fix-1" and .result.verdict.verdict == "FAIL"' "$out"

out="$(wf "{\"resume\":{\"from\":\"fix\",\"commit\":\"$C1\",\"workerRunId\":\"w1\"}}" "{\"resume-fix\":{\"ok\":false,\"error\":\"acceptance rejected\",\"structuredOutput\":$FAIL_C1}}")"
check "e: rejected resume-fix with a verdict -> no fresh worker, resume keeps it" '(.calls | index("resume-fresh") | not) and .result.resumePoint.workerRunId == "run-resume-fix" and .result.verdict.verdict == "FAIL"' "$out"

out="$(wf '{}' "{\"implement\":$IMPL_OK,\"review-0\":{\"ok\":false,\"error\":\"crash\",\"structuredOutput\":$(RV PASS "$C1")},\"review-0-retry\":$REV_PASS}")"
check "e: failed reviewer with output is still retried, not trusted" '.env.status == "done" and (.calls | index("review-0-retry"))' "$out"

out="$(ww "{\"impl-step-01-x\":{\"ok\":false,\"error\":\"acceptance rejected\",\"structuredOutput\":$FAIL_C1}}")"
check "e: wave lane worker FAIL+commit -> resume from fix actionable" '.result.board[0].state == "FAIL" and .result.board[0].commit == "'"$C1"'" and .result.board[0].resumeFrom == "fix" and .result.board[0].workerRunId == "run-impl-step-01-x" and any(.env.actionables[]; .what | test("resume \\{from: \"fix\", commit: \"'"$C1"'\""))' "$out"
out="$(ww "{\"impl-step-01-x\":{\"ok\":false,\"error\":\"verify failed\",\"structuredOutput\":$(SV PASS "$C1")}}")"
check "e: wave lane claimed PASS rejected by gates -> resume from gates" '.result.board[0].resumeFrom == "gates"' "$out"

# Model children whose failed result matters must not go through runs.run (host-command children may: their failures
# carry nothing beyond the error).
for wf_name in execute-step execute-wave review-factcheck-fix plan-factcheck-fix; do
  bad="$(grep -n 'runs\.run(' "$ROOT/workflows/$wf_name.js" | grep -v 'wf-host-command' || true)"
  if [ -z "$bad" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $wf_name launches a model child via runs.run: $bad"; fi
done
