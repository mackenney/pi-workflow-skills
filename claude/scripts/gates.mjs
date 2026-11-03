#!/usr/bin/env node
// gates.mjs <step-file.md> <commit> [repo] -> run-gates JSON {ok, head, results[]} (or {ok:false, error}) on stdout.
// Claude Code stand-in for pi's acceptance.verify: reads the step's .gates.json sidecar (same rule as
// scripts/step-loader.sh), keeps every gate with a cmd that is not n/a or deferred, and runs them through
// scripts/run-gates.sh in repo (default: cwd), whose HEAD must be <commit>. No runnable gate -> {ok:true, results:[]}.
// Always exits 0.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
const [step, commit, repo = process.cwd()] = process.argv.slice(2);
if (!step || !commit) out({ ok: false, error: "usage: gates.sh <step-file.md> <commit> [repo]" });
const sidecar = step.replace(/\.md$/, "") + ".gates.json";
let c;
try { c = JSON.parse(fs.readFileSync(sidecar, "utf8")); } catch (e) { out({ ok: false, error: "gates sidecar unreadable: " + sidecar + " (" + e.message + ")" }); }
if (!Array.isArray(c.gates)) out({ ok: false, error: "no gates array in " + sidecar });
const gates = c.gates.filter((g) => g.cmd && g.result !== "n/a" && g.result !== "deferred")
  .map((g) => ({ id: g.id, command: g.cmd, timeoutMs: g.timeoutMs ?? 900000 }));
if (gates.length === 0) out({ ok: true, results: [] });
const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const r = spawnSync(path.join(here, "..", "..", "scripts", "run-gates.sh"),
  { input: JSON.stringify({ commit, repo, gates }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
try { out(JSON.parse(r.stdout)); } catch { out({ ok: false, error: "run-gates output unparseable: " + (r.stderr || r.stdout || "").slice(0, 300) }); }
