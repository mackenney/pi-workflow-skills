#!/usr/bin/env node
// {"commit": "<sha>", "gates": [{"id", "command", "timeoutMs"?}], "repo"?: "/abs/dir"} on stdin ->
// {"ok", "head", "results": [{"id", "pass", "exitCode", "timedOut", "ms", "tail"}], "error"?}.
// Re-runs a step's sidecar gates without a model when a step resumes from "gates" (the worker's commit exists but the
// runtime's acceptance.verify failed, e.g. on an environment problem since fixed). Gates run in the checkout like
// acceptance.verify does, so HEAD must be the resume commit: running them on any other tree would prove nothing. The
// fix is to move the working branch there, never to check out the bare sha (that detaches HEAD and drops later work).
// ok only when every gate exits 0. Output tails stay short to keep stdout far below the runner's 64 KiB cap. Always exits 0.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const done = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
let task;
try { task = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { done({ ok: false, error: "bad task JSON: " + e.message }); }
const cwd = task.repo || process.cwd();
if (!Array.isArray(task.gates) || task.gates.length === 0) done({ ok: false, error: "gates must be a non-empty array" });
if (!/^[0-9a-f]{7,40}$/i.test(String(task.commit ?? ""))) done({ ok: false, error: "commit must be 7-40 hex chars" });
const h = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
const head = h.status === 0 ? h.stdout.trim() : null;
if (!head || !head.toLowerCase().startsWith(String(task.commit).toLowerCase())) done({ ok: false, head, error: "HEAD is " + (head ?? "unreadable") + ", not " + task.commit + " in " + cwd + "; move the branch there (never check out a bare sha: it detaches HEAD)" });

const results = [];
for (const g of task.gates) {
  if (!g || typeof g.command !== "string" || !g.id) { results.push({ id: g?.id ?? "?", pass: false, exitCode: null, timedOut: false, ms: 0, tail: "gate needs id and command" }); continue; }
  const t0 = Date.now();
  const r = spawnSync("bash", ["-c", g.command], { cwd, encoding: "utf8", timeout: Number(g.timeoutMs) || 900000, maxBuffer: 64 * 1024 * 1024 });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  const timedOut = r.error?.code === "ETIMEDOUT";
  results.push({ id: g.id, pass: r.status === 0 && !timedOut, exitCode: r.status, timedOut, ms: Date.now() - t0, tail: out.slice(-400) });
}
done({ ok: results.every((r) => r.pass), head, results });
