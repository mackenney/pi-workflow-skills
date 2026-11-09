#!/usr/bin/env node
// gates.mjs <abs step-file.md> <commit> <sidecar-sha256> [repo] [--stage <dir>] [--wtdir <dir>] [--ignore-sha <hex>]
//   -> run-gates JSON {ok, head, results[{id, pass, exitCode, timedOut, ms, tail}], skipped[]}
//      (or {ok:false, error, skipped?, paths?, byproducts?, allByproducts?, hint?}) on stdout.
// gates.mjs --clean <abs planDir> [repo] [--stage <dir>] [--wtdir <dir>] [--ignore-sha <hex>]
//   -> {ok, paths[], byproducts[], allByproducts, ignoreSha, error?, hint?}
// Always exits 0.
// Claude Code stand-in for pi's acceptance.verify: reads the step's .gates.json sidecar (same rule as
// scripts/step-loader.sh), keeps every gate with a cmd that is not n/a or deferred, and runs them through
// scripts/run-gates.sh in repo (default: cwd), whose HEAD must be <commit>.
// run-gates checks only HEAD, so an untracked or modified file could make a gate pass that the commit fails: the
// working tree must be clean. "Clean" is defined once, in scripts/lib/clean.mjs (shared with pi's tree-check);
// --clean exposes it to the executor, so the procedure and the gate run cannot disagree.
// pi loaded the contract once, before the worker ran; here the sidecar is re-read after the worker, so the caller
// passes the sha256 it recorded before dispatch and any change fails closed. No runnable gate -> ok:false
// (validate-plan rejects such a step, so an empty set means the sidecar was emptied).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirtyPaths } from "../../scripts/lib/clean.mjs";

const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stage" || a === "--wtdir") { if (i + 1 >= argv.length) return { err: a + " needs a directory" }; opt[a.slice(2)] = argv[++i]; }
    else if (a === "--ignore-sha") { if (i + 1 >= argv.length || !/^[0-9a-f]{64}$/.test(argv[i + 1])) return { err: "--ignore-sha needs the 64-hex ignoreSha from gates.sh --clean" }; opt.ignoreSha = argv[++i]; }
    else if (a === "--clean") opt.clean = true;
    else pos.push(a);
  }
  for (const k of ["stage", "wtdir"]) if (opt[k] !== undefined && !path.isAbsolute(opt[k])) return { err: "--" + k + " must be an absolute path: " + opt[k] };
  return { pos, opt };
}

function clean(pos, opt) {
  const [planDir, repo = process.cwd()] = pos;
  if (!planDir || pos.length > 2) return { ok: false, error: "usage: gates.sh --clean <abs planDir> [repo] [--stage <dir>] [--wtdir <dir>] [--ignore-sha <hex>]" };
  if (!path.isAbsolute(planDir)) return { ok: false, error: "plan dir must be an absolute path: " + planDir };
  const d = dirtyPaths(repo, planDir, opt);
  if (d.error) return { ok: false, error: d.error, paths: [], ...(d.ignoreSha ? { ignoreSha: d.ignoreSha } : {}) };
  return { ok: d.paths.length === 0, paths: d.paths.slice(0, 50), byproducts: d.byproducts, allByproducts: d.allByproducts, ignoreSha: d.ignoreSha, ...(d.hint ? { hint: d.hint } : {}) };
}

function main() {
  const { pos, opt, err } = parse(process.argv.slice(2));
  if (err) return { ok: false, error: err };
  if (opt.clean) return clean(pos, opt);
  const [step, commit, sha, repo = process.cwd()] = pos;
  if (!step || !commit || !sha || pos.length > 4) return { ok: false, error: "usage: gates.sh <abs step-file.md> <commit> <sidecar-sha256> [repo] [--stage <dir>] [--wtdir <dir>] [--ignore-sha <hex>]" };
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
  if (dirty.paths.length) return { ok: false, error: "working tree not clean (commit or remove): " + dirty.paths.slice(0, 20).join(", "), skipped,
    paths: dirty.paths.slice(0, 50), byproducts: dirty.byproducts, allByproducts: dirty.allByproducts, ...(dirty.hint ? { hint: dirty.hint } : {}) };
  const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
  const r = spawnSync(path.join(here, "..", "..", "scripts", "run-gates.sh"),
    { input: JSON.stringify({ commit, repo, gates }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let res;
  try { res = JSON.parse(r.stdout); } catch { return { ok: false, error: "run-gates output unparseable: " + (r.stderr || r.stdout || (r.error && r.error.message) || "").slice(0, 300), skipped }; }
  return { ...res, skipped };
}

try { out(main()); } catch (e) { out({ ok: false, error: "internal error: " + (e && e.message) }); }
