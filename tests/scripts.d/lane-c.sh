# generate-tier-overrides: override-active exit code, state-file keys, project-settings warning.
# Always run with --settings in a temp dir so state/backup/patch files never land in ~/.pi/agent.
LC="$T/lane-c"; mkdir -p "$LC/home" "$LC/proj"
cp "$T/AGENTS.md" "$LC/AGENTS.md"
gen() { (cd "$LC/proj" && node "$S/generate-tier-overrides.mjs" --agents-md "$LC/AGENTS.md" --settings "$LC/home/settings.json" --package-dir "$ROOT" "$@" 2>&1); }
echo '{"enabledModels":[],"subagents":{"agentOverrides":{"worker":{"tools":["read"],"defaultContext":"fresh"}}}}' > "$LC/home/settings.json"
gen --apply --override-tier standard=anthropic/m-over:low >/dev/null
check "lane-c: state stores only model/thinking" '(.applied.worker | keys) == ["model","thinking"] and .applied.worker.model == "anthropic/m-over"' "$(cat "$LC/home/tier-overrides.state.json")"
check "lane-c: hand-owned keys kept in settings" '.subagents.agentOverrides.worker.tools == ["read"]' "$(cat "$LC/home/settings.json")"
out="$(gen)"; rc=$?
if [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'override-active'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: lane-c: applied override should exit 0 (rc=$rc)"; fi
jq '.subagents.agentOverrides.worker.model="hand-edited"' "$LC/home/settings.json" > "$LC/s.tmp" && mv "$LC/s.tmp" "$LC/home/settings.json"
out="$(gen)"; rc=$?
if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q '^worker | model | .* | upstream-change\|^worker | model | .* | drift'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: lane-c: changed overridden key should exit 2 (rc=$rc)"; fi
gen --apply --force >/dev/null
jq '.subagents.agentOverrides.scout.model="x" | .subagents.agentOverrides.worker.model="drifted"' "$LC/home/settings.json" > "$LC/s.tmp" && mv "$LC/s.tmp" "$LC/home/settings.json"
mkdir -p "$LC/proj/.pi"; echo '{"subagents":{"agentOverrides":{"worker":{"model":"proj"}}}}' > "$LC/proj/.pi/settings.json"
out="$(gen --clear-override standard)"
if printf '%s' "$out" | grep -q 'warning: project settings .*"worker"'; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: lane-c: missing project-settings warning"; fi
rm -rf "$LC"
