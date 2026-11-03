#!/usr/bin/env node
// check-block.mjs <kind> <file.json> -> {"ok", "errors": [...]} on stdout. Always exits 0.
// kind: step-verdict | review-verdict | envelope | fix-report.
// Claude Code has no outputSchema: an agent's final fenced block is copied into a file by the main session and checked
// here instead. Mirrors the STEP_VERDICT / REVIEW_VERDICT / ENVELOPE / FIX_REPORT schemas of workflows/*.js; fail closed.
import fs from "node:fs";

const [kind, file] = process.argv.slice(2);
const out = (errors) => { process.stdout.write(JSON.stringify({ ok: errors.length === 0, errors }) + "\n"); process.exit(0); };
let v;
try { v = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { out(["cannot read JSON from " + file + ": " + e.message]); }
if (!v || typeof v !== "object" || Array.isArray(v)) out(["block must be a JSON object"]);

const errors = [];
const isArr = (k) => Array.isArray(v[k]) || errors.push(k + " must be an array");
const isStr = (k, o = v) => typeof o[k] === "string" || errors.push(k + " must be a string");
const oneOf = (k, vals, o = v, where = "") => vals.includes(o[k]) || errors.push(where + k + " must be one of " + vals.join("|") + " (got " + JSON.stringify(o[k]) + ")");
const noExtra = (allowed) => { for (const k of Object.keys(v)) if (!allowed.includes(k)) errors.push("unknown key: " + k); };
const COMMIT = /^([0-9a-f]{7,40})?$/;
const CLASSES = ["build", "static", "unit", "integ", "e2e-smoke", "regress"];
const RESULTS = ["pass", "fail", "proxy", "deferred", "n/a"];
const gates = () => {
  if (!isArr("gates")) return;
  v.gates.forEach((g, i) => {
    const w = "gates[" + i + "].";
    if (!g || typeof g !== "object") { errors.push(w + " must be an object"); return; }
    if (typeof g.id !== "string") errors.push(w + "id must be a string");
    oneOf("class", CLASSES, g, w); oneOf("result", RESULTS, g, w);
  });
};
const req = (keys) => { for (const k of keys) if (!(k in v)) errors.push("missing key: " + k); };

if (kind === "step-verdict") {
  const keys = ["verdict", "step", "commit", "gates", "coverage", "proxies_used", "deferred", "decisions_taken", "pending_decisions", "residual_risks"];
  noExtra(keys); req(keys.filter((k) => k !== "commit"));
  oneOf("verdict", ["PASS", "FAIL", "BLOCKED"]); isStr("step");
  if (v.commit !== undefined && !COMMIT.test(String(v.commit))) errors.push("commit must be 7-40 lowercase hex or empty");
  if (v.verdict === "PASS" && !v.commit) errors.push("PASS without a commit sha");
  gates();
  for (const k of ["coverage", "proxies_used", "deferred", "decisions_taken", "pending_decisions", "residual_risks"]) isArr(k);
  (v.deferred ?? []).forEach((d, i) => { for (const k of ["gate", "owed_by", "reason"]) if (!d || !(k in d)) errors.push("deferred[" + i + "] missing " + k); });
  (v.proxies_used ?? []).forEach((p, i) => { for (const k of ["gate", "proxy_cmd", "real_gate"]) if (!p || !(k in p)) errors.push("proxies_used[" + i + "] missing " + k); });
  const proxied = (v.gates ?? []).filter((g) => g?.result === "proxy").map((g) => g.id);
  for (const id of proxied) if (!(v.proxies_used ?? []).some((p) => p?.gate === id)) errors.push("gate " + id + " is proxy but has no proxies_used entry");
} else if (kind === "review-verdict") {
  const keys = ["verdict", "step", "commit", "gates", "findings", "ledger_gaps"];
  noExtra(keys); req(keys.filter((k) => k !== "commit"));
  oneOf("verdict", ["PASS", "FAIL"]); isStr("step");
  if (v.commit !== undefined && !COMMIT.test(String(v.commit))) errors.push("commit must be 7-40 lowercase hex or empty");
  gates(); isArr("ledger_gaps");
  if (isArr("findings") === true) v.findings.forEach((f, i) => { for (const k of ["severity", "class", "location", "evidence", "smallest_fix"]) if (!f || !(k in f)) errors.push("findings[" + i + "] missing " + k); });
} else if (kind === "envelope") {
  const keys = ["stage", "status", "summary", "actionables", "artifacts"];
  noExtra(keys); req(keys);
  isStr("stage"); oneOf("status", ["done", "needs-decision", "failed", "blocked"]);
  if (typeof v.summary !== "string" || v.summary.length > 400) errors.push("summary must be a string of at most 400 chars");
  if (!Array.isArray(v.actionables) || v.actionables.length > 12) errors.push("actionables must be an array of at most 12");
  else v.actionables.forEach((a, i) => {
    if (!a || typeof a.what !== "string" || a.what.length > 300) errors.push("actionables[" + i + "].what must be a string of at most 300 chars");
    if (!a || !["decision", "fix", "info"].includes(a.kind)) errors.push("actionables[" + i + "].kind must be decision|fix|info");
    if (!a || typeof a.ref !== "string") errors.push("actionables[" + i + "].ref must be a string");
  });
  if (!v.artifacts || typeof v.artifacts.primary !== "string") errors.push("artifacts.primary must be a string");
} else if (kind === "fix-report") {
  req(["fixed", "escalated", "skipped"]);
  isArr("fixed");
  for (const k of ["escalated", "skipped"]) if (isArr(k) === true) v[k].forEach((e, i) => { if (!e || typeof e.title !== "string" || typeof e.why !== "string") errors.push(k + "[" + i + "] needs title and why"); });
} else {
  out(["unknown kind " + JSON.stringify(kind) + " (step-verdict|review-verdict|envelope|fix-report)"]);
}
out(errors);
