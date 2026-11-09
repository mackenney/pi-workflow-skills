#!/usr/bin/env node
// {"planDir": "/abs", "repo"?: "/abs", "stageDir"?: "/abs", "wtdir"?: "/abs", "ignoreSha"?: "<64 hex>",
//  "hashFiles"?: ["/abs", ...], "drift"?: {"sidecar": "/abs", "planJson": "/abs"} | [{...}, ...]} on stdin ->
// {"ok", "clean", "paths", "byproducts", "allByproducts", "ignoreSha", "head", "branch", "hashes", "planSha", "drift", "error"?, "hint"?}.
// The workflows' integrity check around a worker. execute-step.js runs it before dispatch and after every worker PASS:
// - clean: no untracked, modified or staged file outside the plan dir (scripts/lib/clean.mjs, the definition Claude
//   Code's gates.sh shares). acceptance.verify runs gates in the checkout, so a stray file could pass a gate the commit
//   fails. ignoreSha from the first call, passed back, makes a worker that ignores its own files fail closed.
// - head/branch: the commit the next gate or review would see, and whether HEAD is on a branch (null when detached).
// - hashes/planSha: sha256 of each hashFiles entry and of all of them in order ("missing" for an absent file). The
//   workflow compares planSha before and after a worker, so an edit to the step file, sidecar, plan.json or ledger fails
//   closed even though the plan dir is untracked.
// - drift: a sidecar's gates, coverage or tier differ from its step's plan.json entry, as one message per sidecar joined
//   with "; " (null when all match).
// ok only when there is no error, the tree is clean and nothing drifted. Always exits 0.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirtyPaths } from "./lib/clean.mjs";

const done = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
// Key order must not count as drift (jq == semantics).
const canon = (x) => Array.isArray(x) ? "[" + x.map(canon).join(",") + "]"
  : isObj(x) ? "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + canon(x[k])).join(",") + "}" : JSON.stringify(x ?? null);

function main() {
  let task;
  try { task = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { return { ok: false, error: "bad task JSON: " + e.message }; }
  if (!isObj(task)) return { ok: false, error: "task must be a JSON object" };
  const repo = task.repo || process.cwd();
  for (const k of ["planDir", "repo", "stageDir", "wtdir"]) {
    if (task[k] !== undefined && (typeof task[k] !== "string" || !path.isAbsolute(task[k]))) return { ok: false, error: k + " must be an absolute path" };
  }
  if (!task.planDir) return { ok: false, error: "planDir is required" };
  if (task.ignoreSha !== undefined && !/^[0-9a-f]{64}$/.test(String(task.ignoreSha))) return { ok: false, error: "ignoreSha must be the 64-hex value from an earlier tree-check" };
  const files = task.hashFiles ?? [];
  if (!Array.isArray(files) || files.some((f) => typeof f !== "string" || !path.isAbsolute(f))) return { ok: false, error: "hashFiles must be an array of absolute paths" };

  const hashes = {}; const all = crypto.createHash("sha256");
  for (const f of files) {
    let b = null;
    try { b = fs.readFileSync(f); } catch { b = null; }
    hashes[f] = b ? sha256(b) : "missing";
    all.update(f + "\0" + hashes[f] + "\n");
  }
  const planSha = files.length ? all.digest("hex") : null;

  const drifts = [];
  for (const d of task.drift === undefined ? [] : [].concat(task.drift)) {
    if (!isObj(d) || typeof d.sidecar !== "string" || typeof d.planJson !== "string") return { ok: false, error: "drift must be {sidecar, planJson} or an array of them" };
    let c, p;
    try { c = JSON.parse(fs.readFileSync(d.sidecar, "utf8")); p = JSON.parse(fs.readFileSync(d.planJson, "utf8")); } catch (e) { return { ok: false, error: "drift check cannot read: " + e.message }; }
    const hits = isObj(p) && Array.isArray(p.steps) ? p.steps.filter((s) => isObj(s) && isObj(c) && s.id === c.step) : [];
    const name = path.basename(d.sidecar);
    if (hits.length !== 1) { drifts.push(name + ": plan.json has " + hits.length + " entries for step " + (isObj(c) ? c.step : "?")); continue; }
    const s = hits[0]; const diff = [];
    if (canon(s.gates) !== canon(c.gates)) diff.push("gates");
    if (canon(s.coverage ?? []) !== canon(c.coverage ?? [])) diff.push("coverage");
    if (canon(s.tier) !== canon(c.tier)) diff.push("tier");
    if (diff.length) drifts.push(name + ": differs from plan.json in " + diff.join(", "));
  }
  const drift = drifts.length ? drifts.join("; ") : null;

  const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  const h = git("rev-parse", "--verify", "-q", "HEAD");
  const head = h.status === 0 ? h.stdout.trim() : null;
  const b = git("symbolic-ref", "-q", "HEAD");
  const branch = b.status === 0 ? b.stdout.trim() : null;

  const d = dirtyPaths(repo, task.planDir, { stage: task.stageDir, wtdir: task.wtdir, ignoreSha: task.ignoreSha });
  const base = { head, branch, hashes, planSha, drift };
  if (d.error) return { ok: false, clean: false, paths: [], error: d.error, ...(d.ignoreSha ? { ignoreSha: d.ignoreSha } : {}), ...base };
  const clean = d.paths.length === 0;
  return { ok: clean && !drift, clean, paths: d.paths.slice(0, 50), byproducts: d.byproducts, allByproducts: d.allByproducts,
    ignoreSha: d.ignoreSha, ...base, ...(d.hint ? { hint: d.hint } : {}) };
}

try { done(main()); } catch (e) { done({ ok: false, error: "internal error: " + (e && e.message) }); }
