#!/usr/bin/env node
// {"pr": 123 | "branch": "...", "repo"?: "/abs/dir", "waitSeconds"?: 0, "expectSha"?: "<commit>"} on stdin ->
// {"state":"green|red|pending|none|stale|unknown","failing":[...],"pending":[...],"checkCount":N,"headSha"?}.
// Reads `gh ... --json` only (never text output). Lists only non-passing checks to stay far below
// wf-host-command's 64 KiB stdout cap. Always exits 0; errors are state "unknown".
// Fail closed: green only when there is at least one check and every bucket is `pass` or `skipping`;
// an unrecognised bucket is "unknown"; zero checks is "none". With expectSha, a PR head that is not
// that commit (or a descendant of it, prefix match on the sha) is "stale": its checks say nothing about the step.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const done = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
let task;
try { task = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { done({ state: "unknown", error: "bad task JSON: " + e.message }); }
const target = task.pr !== undefined ? String(task.pr) : task.branch;
if (!target) done({ state: "unknown", error: "need pr or branch" });
const deadline = Date.now() + (Number(task.waitSeconds) || 0) * 1000;
const cwd = task.repo || process.cwd();
const gh = process.env.PI_WF_GH || "gh"; // test seam: a stub gh

if (task.expectSha) {
  const r = spawnSync(gh, ["pr", "view", target, "--json", "headRefOid"], { cwd, encoding: "utf8" });
  let head;
  try { head = JSON.parse(r.stdout || "").headRefOid; } catch { head = undefined; }
  if (!head) done({ state: "unknown", error: "cannot read PR head sha: " + (r.stderr || r.stdout || "").trim().slice(0, 300) });
  const want = String(task.expectSha).toLowerCase();
  if (!head.toLowerCase().startsWith(want) && !want.startsWith(head.toLowerCase())) {
    done({ state: "stale", headSha: head, expectSha: task.expectSha, note: "PR head is not the step commit; push it before reading CI" });
  }
}

function read() {
  // gh exits 8 when checks are pending and 1 when any fail; JSON is still on stdout in both cases.
  const r = spawnSync(gh, ["pr", "checks", target, "--json", "name,state,bucket,link,workflow"], { cwd, encoding: "utf8" });
  const out = (r.stdout || "").trim();
  if (!out.startsWith("[")) return { error: (r.stderr || out || "gh failed").trim().slice(0, 500) };
  try { return { checks: JSON.parse(out) }; } catch (e) { return { error: "gh JSON parse: " + e.message }; }
}

const KNOWN = new Set(["pass", "fail", "cancel", "pending", "skipping"]);
while (true) {
  const r = read();
  if (r.error) {
    // "no checks reported" is its own state: the repo has no CI for this PR. Never green.
    if (/no checks reported/i.test(r.error)) done({ state: "none", failing: [], pending: [], checkCount: 0, note: r.error });
    done({ state: "unknown", error: r.error });
  }
  const slim = (c) => ({ name: c.name, workflow: c.workflow, state: c.state, bucket: c.bucket, link: c.link });
  const checks = r.checks;
  if (checks.length === 0) done({ state: "none", failing: [], pending: [], checkCount: 0 });
  const failing = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel").map(slim);
  const pending = checks.filter((c) => c.bucket === "pending").map(slim);
  const unknown = checks.filter((c) => !KNOWN.has(c.bucket)).map(slim);
  const passed = checks.filter((c) => c.bucket === "pass").length;
  const state = failing.length ? "red" : unknown.length ? "unknown" : pending.length ? "pending" : passed > 0 ? "green" : "none";
  if (state !== "pending" || Date.now() >= deadline) done({ state, failing, pending, ...(unknown.length ? { unknown } : {}), checkCount: checks.length });
  spawnSync("sleep", ["30"]);
}
