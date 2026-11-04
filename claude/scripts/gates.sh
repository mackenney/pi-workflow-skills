#!/usr/bin/env bash
set -euo pipefail
# Keep the one-JSON-line contract even without node: callers read stdout, not the exit code.
command -v node >/dev/null || { echo '{"ok":false,"error":"node not found on PATH"}'; exit 0; }
exec node "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/gates.mjs" "$@"
