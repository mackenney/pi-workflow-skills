#!/usr/bin/env node
// {"planDir": "/abs/plans/x", "ledgerFile"?: "PROGRESS.md", "pr"?: 123, "repo"?: "/abs/dir", "expectSha"?: "<commit>"} on stdin ->
// {"ok": bool, "openSteps": [...], "openDeferred": [...], "openDisabled": [...], "errors": [...], "ci"?: {...}}.
// Fail closed (parser: lib/ledger.mjs): a missing ledger or section, an empty or unchecked "## Steps" checklist,
// any debt-table row whose Status (last column) is not `discharged <commit>` or
// `waived by <name> <YYYY-MM-DD>: <reason>`, any non-table line inside a debt section, and CI that is not green.
// With `pr` and no `expectSha`, CI is bound to `git rev-parse HEAD` in repo (default planDir); unresolvable HEAD fails closed.
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
const ciErrors = [];
if (task.pr !== undefined) {
  // Without a pin, a green PR head for an older commit would pass the gate; bind to the local HEAD unless told otherwise.
  let expectSha = task.expectSha;
  if (!expectSha) {
    const g = spawnSync("git", ["-C", task.repo || task.planDir, "rev-parse", "HEAD"], { encoding: "utf8" });
    expectSha = g.status === 0 ? g.stdout.trim() : "";
    if (!expectSha) ciErrors.push("cannot resolve HEAD in " + (task.repo || task.planDir) + " to bind CI (pass expectSha or repo)");
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const r = !expectSha ? {} : spawnSync(path.join(here, "ci-gate.sh"),
    { input: JSON.stringify({ pr: task.pr, repo: task.repo, waitSeconds: task.waitSeconds ?? 0, expectSha: expectSha || undefined }), encoding: "utf8" });
  if (!expectSha) ci = { state: "unknown", error: "no commit to bind CI to" };
  else try { ci = JSON.parse(r.stdout); } catch { ci = { state: "unknown", error: "ci-gate output unparseable" }; }
}

const ok = L.errors.length === 0 && ciErrors.length === 0 && openSteps.length === 0 && openDeferred.length === 0 && openDisabled.length === 0 && (!ci || ci.state === "green");
done({ ok, ledger: file, openSteps, openDeferred, openDisabled, errors: [...L.errors, ...ciErrors], ...(ci ? { ci } : {}) });
