#!/usr/bin/env node
// check-block.mjs <kind> <file.json> -> {"ok", "errors": [...]} on stdout. Always exits 0.
// kind: step-verdict | review-verdict | envelope | fix-report.
// Claude Code has no outputSchema: an agent's final fenced block is copied into a file by the main session and checked
// here instead. Mirrors the STEP_VERDICT / REVIEW_VERDICT / ENVELOPE / FIX_REPORT schemas of workflows/*.js, plus the
// verdict rules those schemas leave to prose (a PASS must not contradict its own gates/findings); fail closed.
import fs from "node:fs";

const out = (errors) => { process.stdout.write(JSON.stringify({ ok: errors.length === 0, errors }) + "\n"); process.exit(0); };
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

function check(kind, file) {
  let v;
  try { v = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return ["cannot read JSON from " + file + ": " + e.message]; }
  if (!isObj(v)) return ["block must be a JSON object"];

  const errors = [];
  // Each helper returns true only when the check passed, so `if (!isArr(k))` is safe to guard on.
  const fail = (msg) => { errors.push(msg); return false; };
  const isArr = (k, o = v, where = "") => Array.isArray(o[k]) || fail(where + k + " must be an array");
  const isStr = (k, o = v, where = "") => typeof o[k] === "string" || fail(where + k + " must be a string");
  const oneOf = (k, vals, o = v, where = "") => vals.includes(o[k]) || fail(where + k + " must be one of " + vals.join("|") + " (got " + JSON.stringify(o[k]) + ")");
  const noExtra = (allowed, o = v, where = "") => { for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push("unknown key: " + where + k); };
  const req = (keys) => { for (const k of keys) if (!(k in v)) errors.push("missing key: " + k); };
  const strArr = (k) => { if (isArr(k)) v[k].forEach((s, i) => { if (typeof s !== "string") errors.push(k + "[" + i + "] must be a string"); }); };
  // objArr(k, keys): every item is an object holding string values for `keys`; returns the valid items.
  const objArr = (k, keys) => {
    if (!isArr(k)) return [];
    return v[k].filter((d, i) => {
      const w = k + "[" + i + "]";
      if (!isObj(d)) return fail(w + " must be an object");
      let ok = true;
      for (const key of keys) if (typeof d[key] !== "string") ok = fail(w + "." + key + " must be a string");
      return ok;
    });
  };
  const COMMIT = /^([0-9a-f]{7,40})?$/;
  const commit = () => { if (v.commit !== undefined && (typeof v.commit !== "string" || !COMMIT.test(v.commit))) errors.push("commit must be a string of 7-40 lowercase hex, or empty"); };
  const CLASSES = ["build", "static", "unit", "integ", "e2e-smoke", "regress"];
  const RESULTS = ["pass", "fail", "proxy", "deferred", "n/a"];
  const gates = () => {
    if (!isArr("gates")) return [];
    return v.gates.filter((g, i) => {
      const w = "gates[" + i + "].";
      if (!isObj(g)) return fail("gates[" + i + "] must be an object");
      const a = isStr("id", g, w), b = oneOf("class", CLASSES, g, w), c = oneOf("result", RESULTS, g, w);
      return a && b && c;
    });
  };
  const failedGates = (gs) => gs.filter((g) => g.result === "fail").map((g) => g.id);

  if (kind === "step-verdict") {
    const keys = ["verdict", "step", "commit", "gates", "coverage", "proxies_used", "deferred", "decisions_taken", "pending_decisions", "residual_risks"];
    noExtra(keys); req(keys.filter((k) => k !== "commit"));
    oneOf("verdict", ["PASS", "FAIL", "BLOCKED"]); isStr("step"); commit();
    if (v.verdict === "PASS" && !v.commit) errors.push("PASS without a commit sha");
    const gs = gates();
    objArr("coverage", ["row", "gate"]);
    objArr("deferred", ["gate", "owed_by", "reason"]);
    const proxies = objArr("proxies_used", ["gate", "proxy_cmd", "real_gate"]);
    for (const k of ["decisions_taken", "pending_decisions", "residual_risks"]) strArr(k);
    for (const g of gs) if (g.result === "proxy" && !proxies.some((p) => p.gate === g.id)) errors.push("gate " + g.id + " is proxy but has no proxies_used entry");
    const failed = failedGates(gs);
    if (v.verdict === "PASS" && failed.length) errors.push("contradictory PASS: gate(s) " + failed.join(", ") + " failed");
  } else if (kind === "review-verdict") {
    const keys = ["verdict", "step", "commit", "gates", "findings", "ledger_gaps"];
    noExtra(keys); req(keys.filter((k) => k !== "commit"));
    oneOf("verdict", ["PASS", "FAIL"]); isStr("step"); commit();
    const gs = gates(); strArr("ledger_gaps");
    const findings = objArr("findings", ["class", "location", "evidence", "smallest_fix"])
      .filter((f, i) => oneOf("severity", ["P0", "P1", "P2"], f, "findings[" + i + "]."));
    if (v.verdict === "PASS") {
      const why = [];
      const failed = failedGates(gs);
      if (failed.length) why.push("gate(s) " + failed.join(", ") + " failed");
      const blocking = findings.filter((f) => f.severity !== "P2").length;
      if (blocking) why.push(blocking + " P0/P1 finding(s)");
      if (Array.isArray(v.ledger_gaps) && v.ledger_gaps.length) why.push(v.ledger_gaps.length + " ledger gap(s)");
      if (why.length) errors.push("contradictory PASS: " + why.join("; "));
    }
  } else if (kind === "envelope") {
    const keys = ["stage", "status", "summary", "actionables", "artifacts"];
    noExtra(keys); req(keys);
    isStr("stage"); oneOf("status", ["done", "needs-decision", "failed", "blocked"]);
    if (typeof v.summary !== "string" || v.summary.length > 400) errors.push("summary must be a string of at most 400 chars");
    if (!Array.isArray(v.actionables) || v.actionables.length > 12) errors.push("actionables must be an array of at most 12");
    else v.actionables.forEach((a, i) => {
      const w = "actionables[" + i + "]";
      if (!isObj(a)) { errors.push(w + " must be an object"); return; }
      noExtra(["what", "kind", "ref"], a, w + ".");
      if (typeof a.what !== "string" || a.what.length > 300) errors.push(w + ".what must be a string of at most 300 chars");
      if (!["decision", "fix", "info"].includes(a.kind)) errors.push(w + ".kind must be decision|fix|info");
      if (typeof a.ref !== "string") errors.push(w + ".ref must be a string");
    });
    if (!isObj(v.artifacts)) errors.push("artifacts must be an object");
    else {
      noExtra(["primary", "details"], v.artifacts, "artifacts.");
      if (typeof v.artifacts.primary !== "string") errors.push("artifacts.primary must be a string");
      if (v.artifacts.details !== undefined && !(Array.isArray(v.artifacts.details) && v.artifacts.details.every((d) => typeof d === "string")))
        errors.push("artifacts.details must be an array of strings");
    }
  } else if (kind === "fix-report") {
    // pi's FIX_REPORT allows extra keys; only the listed ones are typed.
    req(["fixed", "escalated", "skipped"]);
    strArr("fixed");
    for (const k of ["escalated", "skipped"]) objArr(k, ["title", "why"]);
  } else {
    return ["unknown kind " + JSON.stringify(kind) + " (step-verdict|review-verdict|envelope|fix-report)"];
  }
  return errors;
}

try { out(check(...process.argv.slice(2))); } catch (e) { out(["internal error: " + (e && e.message)]); }
