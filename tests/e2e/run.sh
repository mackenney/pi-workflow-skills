#!/usr/bin/env bash
# run.sh <name> <cwd> <prompt...>  — one headless pi turn in the isolated install.
# Log: $PI_WF_ISO/runs/<name>.log ; exit code of pi is preserved.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
name="$1"; cwd="$2"; shift 2
mkdir -p "$PI_WF_ISO/runs"
log="$PI_WF_ISO/runs/$name.log"
cd "$cwd" || exit 2
timeout "${PI_WF_TIMEOUT:-3600}" pi --print --model "${PI_WF_DRIVER_MODEL:-anthropic/claude-sonnet-5-5}" "$*" </dev/null >"$log" 2>&1
rc=$?; echo "[run.sh] exit $rc" >>"$log"; exit $rc
