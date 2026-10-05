#!/usr/bin/env node
// {"planDir": "/abs/plans/x", "ledgerFile"?: "PROGRESS.md", "pr"?: 123, "repo"?: "/abs/dir"} on stdin ->
// {"ok": bool, "openSteps": [...], "openDeferred": [...], "openDisabled": [...], "errors": [...], "ci"?: {...}}.
// Fail closed: any row in "Tech debt / deferred gates" or "Disabled/softened checks" whose Status
// (last column) is not `discharged <commit>` or `waived by <name> <YYYY-MM-DD>: <reason>` is open.
// Also fails on a missing/empty "## Steps" checklist or any unchecked `- [ ]` item.
// No significance judgement. Grammar: skills/step-contract/SKILL.md. Always exits 0.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const done = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
let task;
try { task = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { done({ ok: false, errors: ["bad task JSON: " + e.message] }); }
if (!task.planDir) done({ ok: false, errors: ["missing planDir"] });
const file = path.join(task.planDir, task.ledgerFile || "PROGRESS.md");
if (!fs.existsSync(file)) done({ ok: false, errors: ["ledger not found: " + file] });

const DISCHARGED = /^discharged\s+[0-9a-f]{7,40}\b/i;
const WAIVED = /^waived by\s+\S.*?\s+\d{4}-\d{2}-\d{2}\s*:\s*\S/i;
const STEPS = /^##\s+Steps\s*$/i;
const SECTIONS = { deferred: /^##\s+Tech debt\s*\/\s*deferred gates\s*$/i, disabled: /^##\s+Disabled\s*\/\s*softened checks\s*$/i };

const rows = { deferred: [], disabled: [] };
const seen = { deferred: false, disabled: false, steps: false };
const openSteps = [];
let doneSteps = 0;
let current = null;
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (/^##\s/.test(line)) {
    if (STEPS.test(line.trim())) { current = "steps"; seen.steps = true; continue; }
    current = Object.keys(SECTIONS).find((k) => SECTIONS[k].test(line.trim())) ?? null;
    if (current) seen[current] = true;
    continue;
  }
  if (current === "steps") {
    // Unchecked step = plan not finished, regardless of debt tables.
    const m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s*(.*)$/);
    if (m) { if (m[1] === " ") openSteps.push(m[2].trim()); else doneSteps += 1; }
    continue;
  }
  if (!current || !line.trim().startsWith("|")) continue;
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
  if (/^(gate|check)$/i.test(cells[0]) && /^status$/i.test(cells[cells.length - 1])) continue; // header row
  rows[current].push({ item: cells[0], status: cells[cells.length - 1], row: line.trim() });
}

const isClosed = (s) => DISCHARGED.test(s) || WAIVED.test(s);
const openDeferred = rows.deferred.filter((r) => !isClosed(r.status));
const openDisabled = rows.disabled.filter((r) => !isClosed(r.status));
const errors = [];
if (!seen.deferred) errors.push("missing section: ## Tech debt / deferred gates");
if (!seen.disabled) errors.push("missing section: ## Disabled/softened checks");
if (!seen.steps) errors.push("missing section: ## Steps");
else if (openSteps.length === 0 && doneSteps === 0) errors.push("## Steps has no checklist items");

let ci;
if (task.pr !== undefined) {
  const r = spawnSync(path.join(path.dirname(new URL(import.meta.url).pathname), "ci-gate.sh"),
    { input: JSON.stringify({ pr: task.pr, repo: task.repo, waitSeconds: task.waitSeconds ?? 0 }), encoding: "utf8" });
  try { ci = JSON.parse(r.stdout); } catch { ci = { state: "unknown", error: "ci-gate output unparseable" }; }
}

const ok = errors.length === 0 && openSteps.length === 0 && openDeferred.length === 0 && openDisabled.length === 0 && (!ci || ci.state === "green");
done({ ok, ledger: file, openSteps, openDeferred, openDisabled, errors, ...(ci ? { ci } : {}) });
