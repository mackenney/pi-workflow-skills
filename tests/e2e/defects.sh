#!/usr/bin/env bash
# Deliberate-defects e2e: broken plans must yield failed/blocked envelopes with a reason — no crash, no loop.
#   bash tests/e2e/defects.sh                 # isolated install (env.sh); PI_WF_LIVE=1 uses the live install like run.sh
#   DEFECTS_PREPARE_ONLY=1 FX=/tmp/x bash tests/e2e/defects.sh   # build the 3 broken plans only, no model
# Cases (each gets its own plan dir + fresh wavetoy copy under $FX/cases/<case>; stageDir $FX/runs/<case>):
#   impossible-gate  step-01 unit gate is `false`      -> failed|needs-decision, sidecar untouched, step unticked
#   frontier-tier    step-02 tier frontier             -> blocked "no worker lane", no implement child
#   unknown-arg      args include bogus: 1             -> blocked "unknown args"
# Assertions read <stageDir>/brief.json and files, never driver text. Exit 1 if any case FAILs.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export FX="${FX:-/tmp/pi-wf-defects}"
CASES=(impossible-gate frontier-tier unknown-arg)

bash "$HERE/fixtures.sh" >/dev/null || { echo "fixtures failed" >&2; exit 2; }

# Separate plan dir + repo per case so parallel drivers cannot see each other's commits or edits.
for c in "${CASES[@]}"; do
  mkdir -p "$FX/cases/$c"
  cp -a "$FX/wavetoy" "$FX/cases/$c/wavetoy"
  cp -a "$FX/wave-plan" "$FX/cases/$c/plan"
done
# The step .md keeps the real acceptance command: a worker must notice it contradicts the sidecar gate, not edit it.
P="$FX/cases/impossible-gate/plan"
jq '(.gates[] | select(.id=="g-unit-1") | .cmd) = "false"' "$P/step-01-add.gates.json" > "$P/t" && mv "$P/t" "$P/step-01-add.gates.json"
jq '(.steps[] | select(.id=="step-01-add") | .gates[] | select(.id=="g-unit-1") | .cmd) = "false"' "$P/plan.json" > "$P/t" && mv "$P/t" "$P/plan.json"
P="$FX/cases/frontier-tier/plan"
jq '.tier="frontier"' "$P/step-02-mul.gates.json" > "$P/t" && mv "$P/t" "$P/step-02-mul.gates.json"
jq '(.steps[] | select(.id=="step-02-mul") | .tier) = "frontier"' "$P/plan.json" > "$P/t" && mv "$P/t" "$P/plan.json"
sed -i 's/^standard$/frontier/' "$P/PROGRESS.md"
printf '\nTier: frontier\n' >> "$P/step-02-mul.md"

[ "${DEFECTS_PREPARE_ONLY:-0}" = 1 ] && { echo "prepared defect plans in $FX/cases"; exit 0; }

if [ "${PI_WF_LIVE:-0}" = 1 ]; then
  SK="$ROOT"
else
  # shellcheck source=env.sh
  source "$HERE/env.sh"; SK="$PI_WORKFLOW_SKILLS_DIR"
fi
declare -A STEP=([impossible-gate]=step-01-add [frontier-tier]=step-02-mul [unknown-arg]=step-01-add)
declare -A EXTRA=([unknown-arg]=', "bogus": 1')
mkdir -p "$FX/runs"
sha() { sha256sum "$1" | cut -d' ' -f1; }
for c in "${CASES[@]}"; do sha "$FX/cases/$c/plan/${STEP[$c]}.gates.json" > "$FX/cases/$c/sidecar.sha"; done

pids=()
for c in "${CASES[@]}"; do
  d="$FX/cases/$c"; s="${STEP[$c]}"
  args="{\"stepFile\": \"$d/plan/$s.md\", \"planDir\": \"$d/plan\", \"stageDir\": \"$FX/runs/$c\"${EXTRA[$c]:-}}"
  bash "$HERE/run.sh" "defects-$c" "$d/wavetoy" "Make exactly one subagent call: subagent({workflow: \"$SK/workflows/execute-step.js\", async: false, args: $args}). Do not retry, fix or edit anything yourself, and stop right after the call returns." &
  pids+=($!)
done
wait "${pids[@]}"

fails=0
command -v pibar >/dev/null && pibar defects --total 3 --desc "defect cases" --watch-pid $$
verdict() { # case, jq-assertions-ok(0/1), detail
  if [ "$2" = 0 ]; then echo "PASS $1"; else echo "FAIL $1: $3"; fails=$((fails+1)); fi
  command -v pibar >/dev/null && pibar defects +1
}
for c in "${CASES[@]}"; do
  d="$FX/cases/$c"; b="$FX/runs/$c/brief.json"; r="$FX/runs/$c/result.json"; s="${STEP[$c]}"; why=""
  [ -f "$b" ] || { verdict "$c" 1 "no $b"; continue; }
  st="$(jq -r .status "$b")"; txt="$(jq -r '[.summary] + [.actionables[]?.what] | join(" ")' "$b")"
  [ "$(sha "$d/plan/$s.gates.json")" = "$(cat "$d/sidecar.sha")" ] || why+="sidecar changed; "
  grep -q "^- \[ \] \[$s\]" "$d/plan/PROGRESS.md" || why+="step ticked; "
  case "$c" in
    impossible-gate) [[ "$st" = failed || "$st" = needs-decision ]] || why+="status $st; " ;;
    frontier-tier)
      [ "$st" = blocked ] || why+="status $st; "
      [[ "$txt" == *"no worker lane"* ]] || why+="no 'no worker lane' in envelope; "
      # The lane check precedes dispatch, so any implement child means the guard was bypassed.
      if [ -f "$r" ] && jq -e '[.. | strings | select(test("implement"))] | length > 0' "$r" >/dev/null; then why+="implement child in result.json; "; fi
      compgen -G "$FX/runs/$c/children/*implement*" >/dev/null && why+="implement child dir; " ;;
    unknown-arg)
      [ "$st" = blocked ] || why+="status $st; "
      [[ "$txt" == *"unknown args"* ]] || why+="no 'unknown args' in envelope; " ;;
  esac
  if [ -z "$why" ]; then verdict "$c" 0; else verdict "$c" 1 "$why"; fi
done
command -v pibar >/dev/null && pibar defects --close
exit $((fails > 0))
