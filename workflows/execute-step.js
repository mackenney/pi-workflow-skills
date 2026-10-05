// args: { stepFile: "/abs/plans/x/step-07-name.md", planDir: "/abs/plans/x", baseCommit?: "abc123", stageDir?: "/abs/run/NN-execute",
//         tier?: "deep"|"standard"|"fast", worker?: "<agent name>", pr?: 123, maxFixRounds?: 2, ledgerFile?: "PROGRESS.md" }
// Returns the stage envelope {stage, status, summary, actionables, artifacts} (skills/coordinator/SKILL.md); the full
// result goes to <stageDir>/result.json and the envelope to <stageDir>/brief.json.
// Ledger: once the review passes, this workflow applies the typed verdict to <planDir>/<ledgerFile> through the
// ledger-apply host script (step-contract grammar). Neither the parent nor a model edits ledger rows.
// Sandbox rules: top-level await only, no nested async fns, no fs. Everything file-based goes through children.

// Tier -> agent. Models are NOT named here; each agent's model comes from the generated agentOverrides (§3.2).
const WORKER_BY_TIER = {
  deep: { agent: "wf-structural-worker" },
  standard: { agent: "worker", skill: "step-contract" }, // per-run skill override, documented for runs.run
  fast: { agent: "wf-flash-worker" }
};

const STEP_VERDICT = {
  type: "object", additionalProperties: false,
  required: ["verdict", "step", "gates", "coverage", "proxies_used", "deferred", "decisions_taken", "pending_decisions", "residual_risks"],
  properties: {
    verdict: { enum: ["PASS", "FAIL", "BLOCKED"] },
    step: { type: "string" }, commit: { type: "string" },
    gates: {
      type: "array", items: {
        type: "object", required: ["id", "class", "result"], properties: {
          id: { type: "string" }, class: { enum: ["build", "static", "unit", "integ", "e2e-smoke", "regress"] },
          cmd: { type: "string" }, result: { enum: ["pass", "fail", "proxy", "deferred", "n/a"] }, note: { type: "string" }
        }
      }
    },
    coverage: { type: "array", items: { type: "object", required: ["row", "gate"], properties: { row: { type: "string" }, gate: { type: "string" } } } },
    proxies_used: { type: "array", items: { type: "object", required: ["gate", "proxy_cmd", "real_gate"] } },
    deferred: { type: "array", items: { type: "object", required: ["gate", "owed_by", "reason"] } }, // each becomes an `open` ledger row
    decisions_taken: { type: "array", items: { type: "string" } },
    pending_decisions: { type: "array", items: { type: "string" } },
    residual_risks: { type: "array", items: { type: "string" } }
  }
};
const REVIEW_VERDICT = {
  type: "object", additionalProperties: false, required: ["verdict", "step", "gates", "findings", "ledger_gaps"],
  properties: {
    verdict: { enum: ["PASS", "FAIL"] }, step: { type: "string" }, commit: { type: "string" },
    gates: STEP_VERDICT.properties.gates,
    findings: { type: "array", items: { type: "object", required: ["severity", "class", "location", "evidence", "smallest_fix"] } },
    ledger_gaps: { type: "array", items: { type: "string" } }
  }
};

const ledgerPath = args.planDir + "/" + (args.ledgerFile ?? "PROGRESS.md");
const sidecar = args.stepFile.replace(/\.md$/, ".gates.json");
const stepName = (args.stepFile.split("/").pop() || "step").replace(/\.md$/, "");
const stageDir = args.stageDir ?? (args.planDir + "/runs/" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + stepName);

// Every exit sets `result` and leaves the block; the tail applies the ledger, persists details and returns the envelope.
let result = null;
main: {

// 1. Load the planner-authored gate sidecar mechanically (typed step; no LLM transcription).
const loaded = await runs.run("gates", { agent: "wf-host-command", label: "Load step gates", task: JSON.stringify({ script: "step-loader", stepFile: args.stepFile }) });
if (!loaded.ok) { result = { state: "BLOCKED", reason: "gate sidecar unreadable", error: loaded.error }; break main; }
let contract = null; // { step, tier, base_commit?, gates:[{id,class,cmd,timeoutMs,proxy?,result?}], coverage:[...], hard_splits_declared:[...] }
try { contract = JSON.parse(loaded.output); } catch (e) { contract = null; }
if (!contract || contract.error || !Array.isArray(contract.gates)) { result = { state: "BLOCKED", reason: "gate sidecar unusable", error: contract?.error ?? "no gates array in " + sidecar }; break main; }

const tier = args.tier ?? contract.tier ?? "deep"; // deep is the trial default (RECOMMENDATIONS-v2 R1)
const lane = WORKER_BY_TIER[tier];
if (!lane) { result = { state: "BLOCKED", reason: "no worker lane for tier " + tier + " (lanes: " + Object.keys(WORKER_BY_TIER).join(", ") + "; frontier-sized steps must be split or planned as deep)" }; break main; }
const workerAgent = args.worker ?? lane.agent;
const verify = contract.gates
  .filter((g) => g.cmd && g.result !== "n/a" && g.result !== "deferred") // deferred gates are owed by a later step and ledgered, not run here
  .map((g) => ({ id: g.id, command: g.cmd, timeoutMs: g.timeoutMs ?? 900000 })); // default verify timeout is 120 s; builds need more

const workerTask = [
  "Implement plan step " + contract.step + ".",
  "Step file: " + args.stepFile,
  "Gate sidecar: " + sidecar,
  "Ledger (read-only for you): " + ledgerPath + " — report ledger rows in your verdict; a script writes the file from it.",
  "Base commit for fails-before checks: " + (args.baseCommit ?? contract.base_commit ?? "HEAD"),
  // Without this the worker leaves changes uncommitted ("parent controls commits") and burns a fix round.
  "Commit your work (scoped to the step's files) and report the sha in STEP-VERDICT.commit. Do not edit the ledger.",
  "Executor tier: " + tier + ". Follow the step-contract skill exactly."
].join("\n");

// 2. Worker. The runtime executes every gate command itself (acceptance.verify); the model's claims are evidence, not verdict.
//    If the fast lane is still disabled, this launch fails with an unknown-agent error: enable wf-flash-worker for a measured plan first.
const ACCEPTANCE = {
  level: "verified",
  criteria: ["Every non-n/a gate in the sidecar passes", "Every coverage-matrix row is exercised by a ran gate", "No undeclared proxy; no scope outside the step"],
  evidence: ["changed-files", "commands-run", "residual-risks", "no-staged-files", "diff-summary"],
  verify,
  report: "on"
};
let impl = await runs.run("implement", {
  agent: workerAgent, label: "Implement " + contract.step, task: workerTask,
  ...(lane.skill ? { skill: lane.skill } : {}),
  outputSchema: STEP_VERDICT,
  acceptance: ACCEPTANCE
});
let verdict = impl.structuredOutput;
if (impl.ok && verdict && verdict.verdict === "PASS" && !verdict.commit) verdict = { ...verdict, verdict: "FAIL", residual_risks: [...(verdict.residual_risks ?? []), "PASS without a commit sha"] };
if (!impl.ok || !verdict || verdict.verdict !== "PASS") {
  { result = { state: verdict?.verdict ?? "FAIL", stage: "implement", runId: impl.runId, verdict, error: impl.error, acceptance: impl.acceptance }; break main; }
}

// 3. Independent review with typed verdict, then bounded fix rounds on the retained worker.
const maxFix = args.maxFixRounds ?? 2;
let review; let round = 0;
while (true) {
  review = await runs.run("review-" + round, {
    agent: "wf-step-reviewer", label: "Review " + contract.step,
    task: [
      "Review plan step " + contract.step + ", commit " + verdict.commit + ".",
      "Step file: " + args.stepFile, "Gate sidecar: " + sidecar,
      "Ledger: " + ledgerPath, "Base commit: " + (args.baseCommit ?? contract.base_commit ?? "HEAD"),
      "Worker STEP-VERDICT JSON:", JSON.stringify(verdict)
    ].join("\n"),
    outputSchema: REVIEW_VERDICT
  });
  const rv = review.structuredOutput;
  if (review.ok && rv && rv.verdict === "PASS") break;
  if (round >= maxFix || !impl.runId) {
    { result = { state: "FAIL", stage: "review", round, review: rv, error: review.error, workerRunId: impl.runId }; break main; }
  }
  round += 1;
  impl = await runs.run("fix-" + round, {
    resume: impl.runId, label: "Fix " + contract.step + " round " + round,
    task: "Reviewer findings (verbatim JSON). Address each, re-run all gates, emit a new STEP-VERDICT:\n" + JSON.stringify(rv ?? review.error),
    // Confirmed live (2026-09-24, toy step-01-hello): `resume` does NOT re-capture `outputSchema`
    // from the retained contract (R-a in ORCHESTRATION-ENCODING.md \u00a76.3 resolves to "not inherited") --
    // the fix round returned prose with no structured_output call and the workflow correctly failed-safe
    // rather than claim a false PASS. Passing outputSchema explicitly on the resume call fixes this.
    outputSchema: STEP_VERDICT,
    // Same reason as outputSchema: resume resolves per-launch fields from the request first, so the host-run gates
    // must be passed again or a fix commit could pass on the worker's own claims.
    acceptance: ACCEPTANCE
  });
  verdict = impl.structuredOutput;
  if (!impl.ok || !verdict || verdict.verdict !== "PASS") {
    { result = { state: verdict?.verdict ?? "FAIL", stage: "fix", round, runId: impl.runId, verdict, error: impl.error }; break main; }
  }
}

// 4. Optional CI gate from structured gh output (never tail/truncated text).
let ci = null;
if (args.pr !== undefined) {
  // expectSha binds the checks to this step's commit (a green PR head for an older commit is "stale", not green).
  // timeoutMs stays above the 30-minute CI wait so a slow CI cannot kill the runner.
  const ciRun = await runs.run("ci", { agent: "wf-host-command", label: "Read CI for PR " + args.pr, timeoutMs: 2100000,
    task: JSON.stringify({ script: "ci-gate", pr: args.pr, waitSeconds: 1800, expectSha: verdict.commit }) });
  try { ci = ciRun.ok ? JSON.parse(ciRun.output) : { state: "unknown", error: ciRun.error }; } catch (e) { ci = { state: "unknown", error: "ci-gate output unparseable" }; }
}

// 5. Ledger delta, applied below by ledger-apply. Every `deferred`/proxy entry becomes an `open` row that blocks the
//    terminal gate until a human writes `discharged <commit>` or `waived by <name> <date>: <reason>`.
const ledger = {
  step: contract.step, commit: verdict.commit, ledgerPath, gates: verdict.gates,
  deferred: verdict.deferred, proxies_used: verdict.proxies_used,
  decisions_taken: verdict.decisions_taken, pending_decisions: verdict.pending_decisions,
  residual_risks: verdict.residual_risks, review: review.structuredOutput, ci
};
// Optional, best-effort mirror only (mission state is subject to retention cleanup and is never read as authority).
if (typeof state !== "undefined") { try { await state.set("ledger." + contract.step, ledger); } catch (_) { /* mirror failure is not a step failure */ } }
// Only green CI (or no PR) is PASS. red -> FAIL; pending/none/stale/unknown -> BLOCKED for the parent to resolve.
const finalState = !ci || ci.state === "green" ? "PASS" : ci.state === "red" ? "FAIL" : "BLOCKED";
result = { state: finalState, ...(finalState === "PASS" ? {} : { stage: "ci" }), ledger, workerRunId: impl.runId, reviewRunId: review.runId };
}

// Tail: ledger, persisted details, envelope.
const verdictOut = result.ledger ? null : result.verdict;
let ledgerApply = null;
if (result.ledger) {
  // The review passed: record decisions/deferred rows; tick the step only when the step is PASS (CI included).
  const la = await runs.run("ledger", { agent: "wf-host-command", label: "Apply ledger " + result.ledger.step,
    task: JSON.stringify({ script: "ledger-apply", planDir: args.planDir, ledgerFile: args.ledgerFile, ledgers: [{ ...result.ledger, tick: result.state === "PASS" }] }) });
  try { ledgerApply = la.ok ? JSON.parse(la.output) : { ok: false, errors: [la.error] }; } catch (e) { ledgerApply = { ok: false, errors: ["ledger-apply output unparseable"] }; }
  if (!ledgerApply.ok && result.state === "PASS") result = { ...result, state: "BLOCKED", stage: "ledger" };
}
const L = result.ledger;
const actionables = [];
for (const p of L?.pending_decisions ?? []) actionables.push({ what: p, kind: "decision", ref: ledgerPath + "#pending-decisions-human" });
for (const d of L?.deferred ?? []) actionables.push({ what: "deferred " + d.gate + " (owed by " + d.owed_by + ")", kind: "info", ref: ledgerPath + "#tech-debt--deferred-gates" });
for (const e of ledgerApply?.errors ?? []) actionables.push({ what: "ledger-apply: " + e, kind: "fix", ref: ledgerPath });
if (result.state !== "PASS") actionables.push({ what: (result.stage ?? "step") + ": " + (result.reason ?? result.error ?? (result.review?.findings?.[0]?.evidence) ?? (verdictOut?.residual_risks?.[0]) ?? (L?.ci ? "CI " + L.ci.state : "see result.json")), kind: "fix", ref: stageDir + "/result.json" });
for (const rk of (L?.residual_risks ?? []).slice(0, 3)) actionables.push({ what: rk, kind: "info", ref: stageDir + "/result.json" });
const status = result.state === "PASS" ? (actionables.some((a) => a.kind === "decision") ? "needs-decision" : "done") : result.state === "BLOCKED" ? "blocked" : "failed";
const stepId = L?.step ?? stepName;
const summary = result.state === "PASS"
  ? stepId + " PASS @" + String(L.commit).slice(0, 7) + "; " + (L.gates ?? []).filter((g) => g.result === "pass").length + " gates passed; ledger " + (ledgerApply?.ok ? "applied" : "NOT applied") + "."
  : stepId + " " + result.state + " at " + (result.stage ?? "?") + ".";
const envelope = { stage: "execute-step", status, summary, actionables, artifacts: { primary: result.state === "PASS" ? ledgerPath : stageDir + "/result.json", details: [stageDir + "/result.json"] } };
await runs.run("persist", { agent: "wf-host-command", label: "Persist " + stepId,
  task: JSON.stringify({ script: "write-artifact", files: [{ path: stageDir + "/result.json", json: { ...result, ledgerApply } }, { path: stageDir + "/brief.json", json: envelope }] }) });
return envelope;
