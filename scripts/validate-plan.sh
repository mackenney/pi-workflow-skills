#!/usr/bin/env bash
# Typed-gate command for plan-factcheck-fix.js: validate-plan.sh <plan.json>
# Always exits 0; reports {ok, errors[]} on stdout (the retry branch must not depend on process exit code).
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/validate-plan.mjs" "$@"
