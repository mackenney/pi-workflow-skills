#!/usr/bin/env node
// gates.mjs <abs step-file.md> <commit> <sidecar-sha256> [repo]
//   -> run-gates JSON {ok, head, results[], skipped[]} (or {ok:false, error, skipped?}) on stdout. Always exits 0.
// Claude Code stand-in for pi's acceptance.verify: reads the step's .gates.json sidecar (same rule as
// scripts/step-loader.sh), keeps every gate with a cmd that is not n/a or deferred, and runs them through
// scripts/run-gates.sh in repo (default: cwd), whose HEAD must be <commit>.
// run-gates checks only HEAD, so an untracked or modified file could make a gate pass that the commit fails: the
// working tree must be clean except for the plan dir (the sidecar's dir; the whole `plans` root when it is
// plans/<name>/, since sibling untracked plan dirs collapse into `?? plans/`). A failing `git status` is not clean.
// pi loaded the contract once, before the worker ran; here the sidecar is re-read after the worker, so the caller
// passes the sha256 it recorded before dispatch and any change fails closed. No runnable gate -> ok:false
// (validate-plan rejects such a step, so an empty set means the sidecar was emptied).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

function dirtyPaths(repo, planDir) {
  const git = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return { error: "git rev-parse failed in " + repo + ": " + (top.stderr || "").trim() };
  const rel = path.relative(fs.realpathSync(top.stdout.trim()), fs.realpathSync(planDir));
  const spec = [":(top)"];
  if (rel && rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel)) spec.push(":(top,exclude)" + (/^plans\/[^/]+$/.test(rel) ? "plans" : rel));
  const st = git(["status", "--porcelain", "--", ...spec]);
  if (st.status !== 0) return { error: "git status failed in " + repo + " (not treated as clean): " + (st.stderr || "").trim() };
  return { paths: st.stdout.split("\n").filter(Boolean) };
}

function main() {
  const [step, commit, sha, repo = process.cwd()] = process.argv.slice(2);
  if (!step || !commit || !sha) return { ok: false, error: "usage: gates.sh <abs step-file.md> <commit> <sidecar-sha256> [repo]" };
  // A relative path would resolve against the caller's cwd, which differs between the main checkout and lane worktrees.
  if (!path.isAbsolute(step)) return { ok: false, error: "step file must be an absolute path: " + step };
  if (!/^[0-9a-f]{64}$/.test(sha)) return { ok: false, error: "sidecar-sha256 must be 64 lowercase hex (sha256sum of the sidecar recorded before dispatch)" };
  const sidecar = step.replace(/\.md$/, "") + ".gates.json";
  let raw, c;
  try { raw = fs.readFileSync(sidecar); c = JSON.parse(raw.toString("utf8")); } catch (e) { return { ok: false, error: "gates sidecar unreadable: " + sidecar + " (" + e.message + ")" }; }
  const actual = crypto.createHash("sha256").update(raw).digest("hex");
  if (actual !== sha) return { ok: false, error: "gate sidecar changed since it was recorded: " + sidecar + " (sha256 " + actual + ", expected " + sha + ")" };
  if (!isObj(c) || !Array.isArray(c.gates)) return { ok: false, error: "no gates array in " + sidecar };
  const runnable = (g) => isObj(g) && typeof g.cmd === "string" && g.cmd !== "" && g.result !== "n/a" && g.result !== "deferred";
  const skipped = c.gates.filter((g) => !runnable(g)).map((g) => (isObj(g) ? g.id ?? null : null));
  const gates = c.gates.filter(runnable).map((g) => ({ id: g.id, command: g.cmd, timeoutMs: g.timeoutMs ?? 900000 }));
  if (gates.length === 0) return { ok: false, error: "no runnable gates in " + sidecar, skipped };
  const dirty = dirtyPaths(repo, path.dirname(sidecar));
  if (dirty.error) return { ok: false, error: dirty.error, skipped };
  if (dirty.paths.length) return { ok: false, error: "working tree not clean outside the plan dir (commit or remove): " + dirty.paths.slice(0, 20).join(", "), skipped };
  const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
  const r = spawnSync(path.join(here, "..", "..", "scripts", "run-gates.sh"),
    { input: JSON.stringify({ commit, repo, gates }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  try { return { ...JSON.parse(r.stdout), skipped }; } catch { return { ok: false, error: "run-gates output unparseable: " + (r.stderr || r.stdout || "").slice(0, 300), skipped }; }
}

try { out(main()); } catch (e) { out({ ok: false, error: "internal error: " + (e && e.message) }); }
