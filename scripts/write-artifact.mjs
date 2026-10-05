#!/usr/bin/env node
// Lets a sandboxed workflow (no fs) persist its full result next to the run: {"path": "/abs/x.json", "json": {...}},
// {"path": "/abs/x.md", "text": "..."}, or {"files": [ {path, json|text}, ... ]} on stdin -> {"ok": true, "paths": [...]}.
// Always exits 0.
// Only absolute .json/.md paths without ".." segments; the parent directory is created.
import fs from "node:fs";
import path from "node:path";

const done = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
let task;
try { task = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { done({ ok: false, error: "bad task JSON: " + e.message }); }
const files = Array.isArray(task.files) ? task.files : [task];
const plan = [];
for (const f of files) {
  const p = f?.path;
  if (typeof p !== "string" || !path.isAbsolute(p) || p.split(/[\\/]/).includes("..") || !/\.(json|md)$/.test(p)) done({ ok: false, error: "path must be absolute, end in .json or .md, and contain no '..': " + p });
  const body = f.json !== undefined ? JSON.stringify(f.json, null, 2) + "\n" : typeof f.text === "string" ? f.text : null;
  if (body === null) done({ ok: false, error: "need json or text for " + p });
  plan.push([p, body]);
}
try {
  for (const [p, body] of plan) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); }
} catch (e) { done({ ok: false, error: e.message }); }
done({ ok: true, paths: plan.map(([p]) => p), ...(plan.length === 1 ? { path: plan[0][0] } : {}) });
