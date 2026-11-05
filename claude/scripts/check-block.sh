#!/usr/bin/env bash
set -euo pipefail
# Keep the one-JSON-line contract even without node or coreutils: callers read stdout, not the exit code.
command -v node >/dev/null || { echo '{"ok":false,"errors":["node not found on PATH"]}'; exit 0; }
self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null)" && [ -n "$self" ] || { echo '{"ok":false,"errors":["readlink -f failed (coreutils missing from PATH?)"]}'; exit 0; }
exec node "${self%/*}/check-block.mjs" "$@"
