#!/usr/bin/env bash
# {"stepFile": "/abs/step-07.md"} on stdin -> the .gates.json sidecar's contents on stdout.
set -euo pipefail

input="$(cat)"
stepFile="$(printf '%s' "$input" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  try {
    const obj = JSON.parse(s);
    process.stdout.write(String(obj.stepFile ?? ""));
  } catch (e) {
    process.stdout.write("");
  }
});
')"

if [ -z "$stepFile" ]; then
  echo '{"error":"missing stepFile"}'
  exit 0
fi

sidecar="${stepFile%.md}.gates.json"

if [ ! -f "$sidecar" ]; then
  printf '{"error":"gates sidecar not found: %s"}\n' "$sidecar"
  exit 0
fi

if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$sidecar" 2>/dev/null; then
  printf '{"error":"gates sidecar is not valid JSON: %s"}\n' "$sidecar"
  exit 0
fi

cat "$sidecar"
