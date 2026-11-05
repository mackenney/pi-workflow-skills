#!/usr/bin/env node
// gates.mjs <abs step-file.md> <commit> <sidecar-sha256> [repo] [--stage <dir>] [--wtdir <dir>]
//   -> run-gates JSON {ok, head, results[{id, pass, exitCode, timedOut, ms, tail}], skipped[]}
//      (or {ok:false, error, skipped?, hint?}) on stdout.
// gates.mjs --clean <abs planDir> [repo] [--stage <dir>] [--wtdir <dir>] -> {ok, paths[], error?, hint?}
// Always exits 0.
// Claude Code stand-in for pi's acceptance.verify: reads the step's .gates.json sidecar (same rule as
// scripts/step-loader.sh), keeps every gate with a cmd that is not n/a or deferred, and runs them through
// scripts/run-gates.sh in repo (default: cwd), whose HEAD must be <commit>.
// run-gates checks only HEAD, so an untracked or modified file could make a gate pass that the commit fails: the
// working tree must be clean. The one definition of "clean" lives here (--clean exposes it to the executor) so the
// procedure and the gate run cannot disagree. Untracked files are listed per file whatever the user's
// status.showUntrackedFiles, and submodules are never ignored, because either config would otherwise hide dirt.
// Not dirty: the plan dir; its parent when nothing under the parent is tracked (sibling untracked plan dirs such as
// plans/<other>/, .agent-plans/<other>/); --stage; and registered worktrees under --wtdir (lane worktrees). Only
// worktrees under --wtdir: a worker can register a worktree anywhere, and one inside src/ must still count.
// Ignored files are never checked (gitignore gate by-products; stale ignored files are outside this guard).
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
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const why = (r) => ((r.stderr || "").trim() || (r.error && r.error.message) || "exit " + r.status);
const BYPRODUCT = /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|htmlcov|coverage|node_modules|\.venv|dist|build|target|[^/]+\.egg-info)(\/|$)|\.(pyc|pyo|coverage|log)$|(^|\/)\.coverage(\.|$)/;

function dirtyPaths(repo, planDir, { stage, wtdir } = {}) {
  const git = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const t = git(["rev-parse", "--show-toplevel"]);
  if (t.status !== 0) return { error: "git rev-parse failed in " + repo + ": " + why(t) };
  const top = real(t.stdout.trim());
  const inside = (abs) => { const r = path.relative(top, real(abs)); return r !== "" && !r.startsWith("..") && !path.isAbsolute(r) ? r : null; };
  if (real(planDir) === top) return { error: "plan dir is the repo root (" + top + "): it must be a subdirectory, or every file would count as plan state" };
  const ex = new Set();
  const planRel = inside(planDir);
  if (planRel) {
    ex.add(planRel);
    const parent = path.dirname(planRel);
    if (parent !== ".") {
      const tracked = git(["ls-files", "--", ":(top,literal)" + parent]);
      if (tracked.status !== 0) return { error: "git ls-files failed in " + repo + ": " + why(tracked) };
      if (tracked.stdout.trim() === "") ex.add(parent);
    }
  }
  if (stage) { const r = inside(stage); if (r) ex.add(r); }
  if (wtdir) {
    const wl = git(["worktree", "list", "--porcelain"]);
    if (wl.status !== 0) return { error: "git worktree list failed in " + repo + ": " + why(wl) };
    const root = real(wtdir);
    for (const line of wl.stdout.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const w = real(line.slice(9));
      const under = path.relative(root, w);
      if (under === "" || under.startsWith("..") || path.isAbsolute(under)) continue;
      const r = inside(w); if (r) ex.add(r);
    }
  }
  const spec = [":(top)", ...[...ex].map((r) => ":(top,literal,exclude)" + r)];
  const st = spawnSync("git", ["-C", repo, "-c", "status.showUntrackedFiles=all", "status", "--porcelain",
    "--untracked-files=all", "--ignore-submodules=none", "--", ...spec], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (st.status !== 0) return { error: "git status failed in " + repo + " (not treated as clean): " + why(st) };
  const paths = st.stdout.split("\n").filter(Boolean);
  const by = paths.filter((p) => BYPRODUCT.test(p.slice(3)));
  return { paths, hint: by.length ? "likely gate or tool by-products, gitignore them: " + by.slice(0, 10).join(", ") : undefined };
}

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stage" || a === "--wtdir") { if (i + 1 >= argv.length) return { err: a + " needs a directory" }; opt[a.slice(2)] = argv[++i]; }
    else if (a === "--clean") opt.clean = true;
    else pos.push(a);
  }
  for (const k of ["stage", "wtdir"]) if (opt[k] !== undefined && !path.isAbsolute(opt[k])) return { err: "--" + k + " must be an absolute path: " + opt[k] };
  return { pos, opt };
}

function clean(pos, opt) {
  const [planDir, repo = process.cwd()] = pos;
  if (!planDir || pos.length > 2) return { ok: false, error: "usage: gates.sh --clean <abs planDir> [repo] [--stage <dir>] [--wtdir <dir>]" };
  if (!path.isAbsolute(planDir)) return { ok: false, error: "plan dir must be an absolute path: " + planDir };
  const d = dirtyPaths(repo, planDir, opt);
  if (d.error) return { ok: false, error: d.error, paths: [] };
  return { ok: d.paths.length === 0, paths: d.paths.slice(0, 50), ...(d.hint ? { hint: d.hint } : {}) };
}

function main() {
  const { pos, opt, err } = parse(process.argv.slice(2));
  if (err) return { ok: false, error: err };
  if (opt.clean) return clean(pos, opt);
  const [step, commit, sha, repo = process.cwd()] = pos;
  if (!step || !commit || !sha || pos.length > 4) return { ok: false, error: "usage: gates.sh <abs step-file.md> <commit> <sidecar-sha256> [repo] [--stage <dir>] [--wtdir <dir>]" };
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
  const dirty = dirtyPaths(repo, path.dirname(sidecar), opt);
  if (dirty.error) return { ok: false, error: dirty.error, skipped };
  if (dirty.paths.length) return { ok: false, error: "working tree not clean (commit or remove): " + dirty.paths.slice(0, 20).join(", "), skipped, ...(dirty.hint ? { hint: dirty.hint } : {}) };
  const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
  const r = spawnSync(path.join(here, "..", "..", "scripts", "run-gates.sh"),
    { input: JSON.stringify({ commit, repo, gates }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let res;
  try { res = JSON.parse(r.stdout); } catch { return { ok: false, error: "run-gates output unparseable: " + (r.stderr || r.stdout || (r.error && r.error.message) || "").slice(0, 300), skipped }; }
  // run-gates (shared with pi) says "check the commit out"; here that would detach HEAD in the main checkout.
  if (typeof res.error === "string") res.error = res.error.replace(/; check the commit out before resuming from gates$/, "; HEAD in " + repo + " must be the step commit: move the branch there (never check out a bare sha in the main checkout, it detaches HEAD)");
  return { ...res, skipped };
}

try { out(main()); } catch (e) { out({ ok: false, error: "internal error: " + (e && e.message) }); }
