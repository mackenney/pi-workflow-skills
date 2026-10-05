#!/usr/bin/env bash
# wf-host-command's runner. external-cli agents receive the combined
# "<System instructions>\n...\n\n<Task>\n{task}" prompt on stdin, never raw JSON
# (sa:src/runs/shared/external-cli-runner.js:19-21). Strip everything up to and
# including the "<Task>" marker line, then parse the remainder as one JSON object
# with a "script" field naming an allow-listed sibling script.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOWED=("step-loader" "ci-gate" "terminal-gate" "ledger-apply" "write-artifact")

raw="$(cat)"
# Everything after the "<Task>" marker line is the child's prompt. The runtime may append
# further ambient text after the JSON task (e.g. an "## Acceptance Contract" footer for
# children without an explicit acceptanceRole) -- extract only the leading JSON object,
# balancing braces/strings, and ignore anything after its matching close brace.
after_task="$(printf '%s\n' "$raw" | awk 'f{print} /^<Task>$/{f=1}')"

if [ -z "$after_task" ]; then
  echo '{"error":"no <Task> marker found in stdin envelope"}'
  exit 1
fi

task_json="$(printf '%s' "$after_task" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  const start = s.indexOf("{");
  if (start === -1) { process.stdout.write(""); return; }
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === "\"") inStr = false;
      continue;
    }
    if (c === "\"") { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) { process.stdout.write(""); return; }
  process.stdout.write(s.slice(start, end + 1));
});
')"

if [ -z "$task_json" ]; then
  echo '{"error":"no JSON object found after <Task> marker"}'
  exit 1
fi

script="$(printf '%s' "$task_json" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  try {
    const obj = JSON.parse(s);
    process.stdout.write(String(obj.script ?? ""));
  } catch (e) {
    process.stdout.write("");
  }
});
')"

allowed_match=""
for a in "${ALLOWED[@]}"; do
  if [ "$a" = "$script" ]; then
    allowed_match="$a"
    break
  fi
done

if [ -z "$allowed_match" ]; then
  echo '{"error":"unknown script"}'
  exit 1
fi

exec "$DIR/${allowed_match}.sh" <<< "$task_json"
