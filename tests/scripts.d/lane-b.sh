# done-check binds CI to HEAD; ledger-apply upserts debt rows; wave fixture is contract-valid.
LB="$T/lb"; mkdir -p "$LB/repo"
git -C "$LB/repo" init -q -b main
git -C "$LB/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
HEAD_SHA="$(git -C "$LB/repo" rev-parse HEAD)"
ledger "$LB/repo/PROGRESS.md" "" "" $'## Steps\n- [x] a'
tgpr() { # head-oid [extra json]
  STUB_HEAD="$1" STUB_CHECKS='[{"name":"a","bucket":"pass"}]' PI_WF_GH="$T/bin/gh" "$S/terminal-gate.sh" <<< "{\"planDir\":\"$LB/repo\",\"pr\":1${2:-}}"
}
check "tg-pr: PR head == HEAD -> ok" '.ok == true and .ci.state == "green"' "$(tgpr "$HEAD_SHA")"
check "tg-pr: PR head != HEAD -> not ok (stale)" '.ok == false and .ci.state == "stale"' "$(tgpr deadbeef00)"
check "tg-pr: explicit expectSha wins over HEAD" '.ok == true' "$(tgpr deadbeef00 ',"expectSha":"deadbeef00"')"
mkdir -p "$LB/norepo"; cp "$LB/repo/PROGRESS.md" "$LB/norepo/"
check "tg-pr: unresolvable HEAD fails closed" '.ok == false and any(.errors[]; test("HEAD"))' "$(STUB_HEAD=abc1234def STUB_CHECKS='[{"name":"a","bucket":"pass"}]' PI_WF_GH="$T/bin/gh" GIT_CEILING_DIRECTORIES="$T" "$S/terminal-gate.sh" <<< "{\"planDir\":\"$LB/norepo\",\"pr\":1}")"

LU="$T/lu"; mkdir -p "$LU"
upl() { ledger "$LU/PROGRESS.md" "$1" "" $'## Steps\n- [ ] [step-01-x](./step-01-x.md)'; }
lu() { echo '{"planDir":"'"$LU"'","ledgers":[{"step":"step-01-x","commit":"abc1234def","deferred":[{"gate":"g-integ-1","class":"integ","owed_by":"step-09","reason":"slow"}]}]}' | "$S/ledger-apply.sh"; }
rows() { grep -c '^| g-integ-1' "$LU/PROGRESS.md"; }
upl "| g-integ-1 | integ | step-09 | planned deferral | open |"
lu >/dev/null
check "ledger-apply: plan row + apply -> one row" '. == 1' "$(rows)"
grep -q 'planned deferral | open |' "$LU/PROGRESS.md" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: plan row not authoritative"; }
upl "| g-integ-1 | - |  |  | open |"
check "ledger-apply: fills empty columns" '.applied.deferredRows == 1' "$(lu)"
grep -q '^| g-integ-1 | integ | step-09 | slow (from step-01-x) | open |$' "$LU/PROGRESS.md" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: columns not filled"; cat "$LU/PROGRESS.md"; }
check "ledger-apply: re-apply idempotent" '.applied.deferredRows == 0' "$(lu)"
check "ledger-apply: still one row" '. == 1' "$(rows)"
upl "| g-integ-1 | integ | - | - | discharged abc1234 |"
lu >/dev/null
check "ledger-apply: discharged row stays closed, no dup" '. == 1' "$(rows)"
grep -q 'discharged abc1234 |$' "$LU/PROGRESS.md" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: closed row changed"; }
upl "| g-integ-1 | integ | step-09 | x | waived by ann 2026-01-02: fine |"
lu >/dev/null
check "ledger-apply: waived row stays, no dup" '. == 1' "$(rows)"
grep -q 'waived by ann 2026-01-02: fine |$' "$LU/PROGRESS.md" && pass=$((pass+1)) || { fail=$((fail+1)); echo "FAIL: waived row changed"; }

FXD="$T/fx"
FX="$FXD" bash "$ROOT/tests/e2e/fixtures.sh" >/dev/null 2>&1
check "fixtures: wave plan passes validate-plan" '.ok == true' "$("$S/validate-plan.sh" "$FXD/wave-plan/plan.json")"
