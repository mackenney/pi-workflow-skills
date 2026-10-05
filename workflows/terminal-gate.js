// args: { planDir: "/abs/plans/x", ledgerFile?: "PROGRESS.md", pr?: 123, repo?: "/abs/repo", waitSeconds?: 0 }
// Fails closed on any `open` (or malformed) deferred-gate / disabled-check row and on non-green CI when
// `pr` is set. The executor must not report plan completion unless this returns ok: true.
const run = await runs.run("terminal-gate", {
  agent: "wf-host-command", label: "Terminal gate " + args.planDir,
  task: JSON.stringify({ script: "terminal-gate", planDir: args.planDir, ledgerFile: args.ledgerFile, pr: args.pr, repo: args.repo, waitSeconds: args.waitSeconds ?? 0 })
});
let result;
try { result = JSON.parse(run.output); } catch (e) { result = { ok: false, errors: ["unparseable terminal-gate output: " + (run.error ?? e.message)] }; }
// Mission state is a best-effort mirror; PROGRESS.md stays authoritative.
if (typeof state !== "undefined" && state && typeof state.set === "function") {
  try { await state.set("terminalGate", { ok: result.ok, at: new Date().toISOString() }); } catch (e) { /* mirror only */ }
}
return result;
