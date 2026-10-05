#!/usr/bin/env node
// {"pr": 123 | "branch": "...", "repo"?: "/abs/dir", "waitSeconds"?: 0} on stdin ->
// {"state":"green|red|pending|none|unknown","failing":[...],"pending":[...],"checkCount":N}.
// Reads `gh pr checks --json` only (never text output). Lists only non-passing checks to stay
// far below wf-host-command's 64 KiB stdout cap. Always exits 0; errors are state "unknown".
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const done = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
let task;
try { task = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { done({ state: "unknown", error: "bad task JSON: " + e.message }); }
const target = task.pr !== undefined ? String(task.pr) : task.branch;
if (!target) done({ state: "unknown", error: "need pr or branch" });
const deadline = Date.now() + (Number(task.waitSeconds) || 0) * 1000;
const cwd = task.repo || process.cwd();

function read() {
  // gh exits 8 when checks are pending and 1 when any fail; JSON is still on stdout in both cases.
  const r = spawnSync("gh", ["pr", "checks", target, "--json", "name,state,bucket,link,workflow"], { cwd, encoding: "utf8" });
  const out = (r.stdout || "").trim();
  if (!out.startsWith("[")) return { error: (r.stderr || out || "gh failed").trim().slice(0, 500) };
  try { return { checks: JSON.parse(out) }; } catch (e) { return { error: "gh JSON parse: " + e.message }; }
}

while (true) {
  const r = read();
  if (r.error) {
    // "no checks reported" is its own state: the repo has no CI for this PR. Never green.
    if (/no checks reported/i.test(r.error)) done({ state: "none", failing: [], pending: [], checkCount: 0, note: r.error });
    done({ state: "unknown", error: r.error });
  }
  const slim = (c) => ({ name: c.name, workflow: c.workflow, state: c.state, link: c.link });
  const failing = r.checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel").map(slim);
  const pending = r.checks.filter((c) => c.bucket === "pending").map(slim);
  const state = failing.length ? "red" : pending.length ? "pending" : "green";
  if (state !== "pending" || Date.now() >= deadline) done({ state, failing, pending, checkCount: r.checks.length });
  spawnSync("sleep", ["30"]);
}
