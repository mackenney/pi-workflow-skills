#!/usr/bin/env bash
# run.sh <name> <cwd> <prompt...>  — one headless pi turn in the isolated install
# (PI_WF_LIVE=1: use the live ~/.pi/agent install instead; logs still go to $PI_WF_ISO/runs).
# Log: $PI_WF_ISO/runs/<name>.log ; exit code of pi is preserved.
set -uo pipefail
if [ "${PI_WF_LIVE:-0}" = 1 ]; then
  export PI_WF_ISO="${PI_WF_ISO:-/tmp/pi-wf-iso}"; unset PI_CODING_AGENT_DIR PI_WORKFLOW_SKILLS_DIR
else
  source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
fi
name="$1"; cwd="$2"; shift 2
mkdir -p "$PI_WF_ISO/runs"
log="$PI_WF_ISO/runs/$name.log"
cd "$cwd" || exit 2
timeout "${PI_WF_TIMEOUT:-3600}" pi --print --model "${PI_WF_DRIVER_MODEL:-anthropic/claude-sonnet-5-5}" "$*" </dev/null >"$log" 2>&1
rc=$?; echo "[run.sh] exit $rc" >>"$log"; exit $rc
