# A worker FAIL with a commit may be environmental: both "fix" and "gates" resume points are offered, never chosen.
# Reuses lane-a's stub runtime (wf, ww, SV, mk_step, $C1).

mk_step true
FAIL_C1="$(SV FAIL "$C1")"
out="$(wf '{}' "{\"implement\":{\"ok\":false,\"error\":\"acceptance rejected\",\"structuredOutput\":$FAIL_C1}}")"
check "f: worker FAIL+commit -> primary fix, alternative gates with a distinct stageDir" '.result.resumePoint.from == "fix" and .result.resumeAlternatives[0].from == "gates" and .result.resumeAlternatives[0].commit == "'"$C1"'" and .result.resumeAlternatives[0].workerRunId == "run-implement" and .result.resumeAlternatives[0].args.resume.from == "gates" and (.result.resumeAlternatives[0].args.stageDir != .result.resumePoint.args.stageDir) and (.result.resumeAlternatives[0].args.stageDir | endswith("-resume-gates"))' "$out"
check "f: envelope lists both resume actionables" '[.env.actionables[] | select(.kind == "fix" and (.what | startswith("resume from ")))] as $r | ($r | length) == 2 and ($r[0].what | startswith("resume from fix at '"$C1"'")) and ($r[1].what | startswith("resume from gates at '"$C1"' (after fixing the environment): args.resume="))' "$out"

out="$(wf '{}' "{\"implement\":{\"ok\":false,\"error\":\"verify failed\",\"structuredOutput\":$(SV PASS "$C1")}}")"
check "f: runtime-rejected claimed PASS keeps gates primary and adds fix" '.result.resumePoint.from == "gates" and .result.resumeAlternatives[0].from == "fix"' "$out"

out="$(ww "{\"impl-step-01-x\":{\"ok\":false,\"error\":\"acceptance rejected\",\"structuredOutput\":$FAIL_C1}}")"
check "f: wave lane FAIL+commit gets fix and gates actionables" '[.env.actionables[] | select(.kind == "fix")] as $a | any($a[]; .what | test("resume \\{from: \"fix\"")) and any($a[]; .what | test("resume from gates .*resume \\{from: \"gates\", commit: \"'"$C1"'\""))' "$out"
