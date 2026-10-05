# Deliberate-defect plans for tests/e2e/defects.sh: only execution catches (a); validate-plan must reject (b)'s frontier tier.
DEF="$T/defects"
FX="$DEF" DEFECTS_PREPARE_ONLY=1 bash "$ROOT/tests/e2e/defects.sh" >/dev/null 2>&1
check "g: unmodified fixture passes validate-plan" '.ok == true' "$("$S/validate-plan.sh" "$DEF/wave-plan/plan.json")"
check "g: impossible-gate plan is syntactically valid" '.ok == true' "$("$S/validate-plan.sh" "$DEF/cases/impossible-gate/plan/plan.json")"
check "g: impossible-gate gate cmd is false in sidecar and plan.json" '.[0] == "false" and .[1] == "false"' "$(jq -c -s '[(.[0].gates[]|select(.id=="g-unit-1").cmd), (.[1].steps[0].gates[]|select(.id=="g-unit-1").cmd)]' "$DEF/cases/impossible-gate/plan/step-01-add.gates.json" "$DEF/cases/impossible-gate/plan/plan.json")"
check "g: frontier-tier plan rejected with frontier error" '.ok == false and any(.errors[]; test("frontier"))' "$("$S/validate-plan.sh" "$DEF/cases/frontier-tier/plan/plan.json")"
check "g: each case has its own wavetoy repo" '. == 3' "$(ls -d "$DEF"/cases/*/wavetoy/.git | wc -l)"
