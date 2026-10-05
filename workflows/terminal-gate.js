// args: { planDir: "/abs/plans/x", ledgerFile?: "PROGRESS.md", pr?: 123, repo?: "/abs/repo", waitSeconds?: 0, expectSha?: "<commit>", stageDir?: "/abs/run/NN-done-check" }
// Fails closed (scripts/terminal-gate.mjs): unchecked steps, open or malformed ledger rows, non-table lines in the debt
// sections, non-green CI when `pr` is set. The plan is complete only when this returns status "done".
// Returns the stage envelope; the raw gate JSON goes to <stageDir>/result.json.
// A failed child makes runs.run reject and would end the workflow with no envelope/brief. Convert the rejection into a
// failed result so every exit path reports (runs.all already returns per-child failures).
const safe = (p) => p.then((r) => r, (e) => ({ ok: false, error: String((e && e.message) || e) }));
const run = await safe(runs.run("terminal-gate", {
  agent: "wf-host-command", label: "Terminal gate " + args.planDir,
  task: JSON.stringify({ script: "terminal-gate", planDir: args.planDir, ledgerFile: args.ledgerFile, pr: args.pr, repo: args.repo, waitSeconds: args.waitSeconds ?? 0, expectSha: args.expectSha })
}));
let result;
try { result = JSON.parse(run.output); } catch (e) { result = { ok: false, errors: ["unparseable terminal-gate output: " + (run.error ?? e.message)] }; }
// Mission state is a best-effort mirror; PROGRESS.md stays authoritative.
if (typeof state !== "undefined" && state && typeof state.set === "function") {
  try { await state.set("terminalGate", { ok: result.ok, at: new Date().toISOString() }); } catch (e) { /* mirror only */ }
}

const ledger = result.ledger ?? (args.planDir + "/" + (args.ledgerFile ?? "PROGRESS.md"));
const stageDir = args.stageDir ?? (args.planDir + "/runs/" + new Date().toISOString().replace(/[:.]/g, "-") + "-done-check");
const actionables = [];
for (const s of result.openSteps ?? []) actionables.push({ what: "unfinished step: " + s, kind: "fix", ref: ledger + "#steps" });
for (const r of [...(result.openDeferred ?? []), ...(result.openDisabled ?? [])]) actionables.push({ what: "open row: " + r.item + " (discharge, or the human waives it)", kind: "decision", ref: ledger });
for (const e of result.errors ?? []) actionables.push({ what: e, kind: "fix", ref: ledger });
if (result.ci && result.ci.state !== "green") actionables.push({ what: "CI " + result.ci.state + (result.ci.failing?.length ? ": " + result.ci.failing.map((c) => c.name).join(", ") : ""), kind: result.ci.state === "red" ? "fix" : "info", ref: stageDir + "/result.json" });
// Unfinished work or a malformed ledger is the executor's to fix; open rows are the human's; CI not yet green blocks.
const status = result.ok ? "done"
  : (result.openSteps ?? []).length || (result.errors ?? []).length || result.ci?.state === "red" ? "failed"
  : (result.openDeferred ?? []).length || (result.openDisabled ?? []).length ? "needs-decision"
  : "blocked";
const summary = result.ok ? "plan complete: all steps checked, no open ledger rows" + (result.ci ? ", CI green" : "") + "."
  : "plan NOT complete: " + (result.openSteps ?? []).length + " open step(s), " + ((result.openDeferred ?? []).length + (result.openDisabled ?? []).length) + " open row(s), " + (result.errors ?? []).length + " error(s)" + (result.ci ? ", CI " + result.ci.state : "") + ".";
const envelope = { stage: "done-check", status, summary, actionables, artifacts: { primary: ledger, details: [stageDir + "/result.json"] } };
await safe(runs.run("persist", { agent: "wf-host-command", label: "Persist terminal gate",
  task: JSON.stringify({ script: "write-artifact", files: [{ path: stageDir + "/result.json", json: result }, { path: stageDir + "/brief.json", json: envelope }] }) }));
return envelope;
