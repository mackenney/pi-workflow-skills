#!/usr/bin/env node
// {"planDir": "/abs/plans/x", "ledgerFile"?: "PROGRESS.md", "pr"?: 123, "repo"?: "/abs/dir", "expectSha"?: "<commit>"} on stdin ->
// {"ok": bool, "openSteps": [...], "openDeferred": [...], "openDisabled": [...], "errors": [...], "ci"?: {...}}.
// Fail closed (parser: lib/ledger.mjs): a missing ledger or section, an empty or unchecked "## Steps" checklist,
// any debt-table row whose Status (last column) is not `discharged <commit>` or
// `waived by <name> <YYYY-MM-DD>: <reason>`, any non-table line inside a debt section, and CI that is not green.
// No significance judgement. Grammar: skills/step-contract/SKILL.md. Always exits 0.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseLedger, isClosed } from "./lib/ledger.mjs";

const done = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
let task;
try { task = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { done({ ok: false, errors: ["bad task JSON: " + e.message] }); }
if (!task.planDir) done({ ok: false, errors: ["missing planDir"] });
const file = path.join(task.planDir, task.ledgerFile || "PROGRESS.md");
if (!fs.existsSync(file)) done({ ok: false, errors: ["ledger not found: " + file] });

const L = parseLedger(fs.readFileSync(file, "utf8"));
const openSteps = L.steps.filter((s) => !s.done).map((s) => s.text);
const openDeferred = L.rows.deferred.filter((r) => !isClosed(r.status));
const openDisabled = L.rows.disabled.filter((r) => !isClosed(r.status));

let ci;
if (task.pr !== undefined) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const r = spawnSync(path.join(here, "ci-gate.sh"),
    { input: JSON.stringify({ pr: task.pr, repo: task.repo, waitSeconds: task.waitSeconds ?? 0, expectSha: task.expectSha }), encoding: "utf8" });
  try { ci = JSON.parse(r.stdout); } catch { ci = { state: "unknown", error: "ci-gate output unparseable" }; }
}

const ok = L.errors.length === 0 && openSteps.length === 0 && openDeferred.length === 0 && openDisabled.length === 0 && (!ci || ci.state === "green");
done({ ok, ledger: file, openSteps, openDeferred, openDisabled, errors: L.errors, ...(ci ? { ci } : {}) });
