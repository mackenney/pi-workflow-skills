#!/usr/bin/env bash
set -euo pipefail
exec node "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/gates.mjs" "$@"
