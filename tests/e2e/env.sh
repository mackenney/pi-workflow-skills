#!/usr/bin/env bash
# Isolated pi install for end-to-end tests of THIS checkout (e.g. a worktree).
# Usage: source tests/e2e/env.sh   (creates $PI_WF_ISO on first use)
# Loads only pi-subagents, pi-web-access (wf-fact-checker tools), pi-edit-hooks and this checkout; reuses the live auth/models
# by symlink (no secret copies) and the live subagents/model settings.
_wf_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PI_WF_ISO="${PI_WF_ISO:-/tmp/pi-wf-iso}"
export PI_CODING_AGENT_DIR="$PI_WF_ISO/agent"
export PI_WORKFLOW_SKILLS_DIR="$_wf_root"
_live="${PI_WF_LIVE_AGENT_DIR:-$HOME/.pi/agent}"
_subagents_pkg="${PI_WF_SUBAGENTS_PKG:-$_live/npm/node_modules/pi-subagents}"
_edithooks_pkg="${PI_WF_EDITHOOKS_PKG:-$HOME/pr/pi-edit-hooks}"
_webaccess_pkg="${PI_WF_WEBACCESS_PKG:-$_live/npm/node_modules/pi-web-access}"
if [ ! -f "$PI_CODING_AGENT_DIR/settings.json" ]; then
  mkdir -p "$PI_CODING_AGENT_DIR" "$PI_WF_ISO/sessions" && chmod 700 "$PI_WF_ISO"
  for f in auth.json models.json web-search.json; do [ -e "$_live/$f" ] && ln -sf "$_live/$f" "$PI_CODING_AGENT_DIR/$f"; done
  jq --arg sa "$_subagents_pkg" --arg eh "$_edithooks_pkg" --arg wa "$_webaccess_pkg" --arg wf "$_wf_root" --arg sd "$PI_WF_ISO/sessions" '
    {defaultProvider, defaultModel, defaultThinkingLevel, enabledModels, retry, subagents,
     defaultProjectTrust: "always", quietStartup: true, sessionDir: $sd,
     packages: [$sa, $wa, $eh, $wf]}' "$_live/settings.json" > "$PI_CODING_AGENT_DIR/settings.json"
fi
unset _wf_root _live _subagents_pkg _edithooks_pkg _webaccess_pkg
