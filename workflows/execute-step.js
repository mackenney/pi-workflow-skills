// args: { stepFile: "/abs/plans/x/step-07-name.md", planDir: "/abs/plans/x", baseCommit: "abc123",
//         tier?: "deep"|"standard"|"fast", worker?: "<agent name>", pr?: 123, maxFixRounds?: 2, ledgerFile?: "PROGRESS.md" }
// Sandbox rules: top-level await only, no nested async fns, no fs. Everything file-based goes through children.
// Ledger authority: the parent session applies the returned `ledger` to <planDir>/<ledgerFile>. Mission state is a mirror.

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

// 1. Load the planner-authored gate sidecar mechanically (typed step; no LLM transcription).
const loaded = await runs.run("gates", { agent: "wf-host-command", label: "Load step gates", task: JSON.stringify({ script: "step-loader", stepFile: args.stepFile }) });
if (!loaded.ok) return { state: "BLOCKED", reason: "gate sidecar unreadable", error: loaded.error };
let contract = null; // { step, tier, base_commit?, gates:[{id,class,cmd,timeoutMs,proxy?,result?}], coverage:[...], hard_splits_declared:[...] }
try { contract = JSON.parse(loaded.output); } catch (e) { contract = null; }
if (!contract || contract.error || !Array.isArray(contract.gates)) return { state: "BLOCKED", reason: "gate sidecar unusable", error: contract?.error ?? "no gates array in " + sidecar };

const tier = args.tier ?? contract.tier ?? "deep"; // deep is the trial default (RECOMMENDATIONS-v2 R1)
const lane = WORKER_BY_TIER[tier];
if (!lane) return { state: "BLOCKED", reason: "no worker lane for tier " + tier + " (lanes: " + Object.keys(WORKER_BY_TIER).join(", ") + "; frontier-sized steps must be split or planned as deep)" };
const workerAgent = args.worker ?? lane.agent;
const verify = contract.gates
  .filter((g) => g.cmd && g.result !== "n/a" && g.result !== "deferred") // deferred gates are owed by a later step and ledgered, not run here
  .map((g) => ({ id: g.id, command: g.cmd, timeoutMs: g.timeoutMs ?? 900000 })); // default verify timeout is 120 s; builds need more

const workerTask = [
  "Implement plan step " + contract.step + ".",
  "Step file: " + args.stepFile,
  "Gate sidecar: " + sidecar,
  "Ledger (read-only for you): " + ledgerPath + " — report ledger rows in your verdict; the parent writes the file.",
  "Base commit for fails-before checks: " + (args.baseCommit ?? contract.base_commit ?? "HEAD"),
  // Without this the worker leaves changes uncommitted ("parent controls commits") and burns a fix round.
  "Commit your work (scoped to the step's files) and report the sha in STEP-VERDICT.commit. The parent writes the ledger, not commits.",
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
if (!impl.ok || !verdict || verdict.verdict !== "PASS") {
  return { state: verdict?.verdict ?? "FAIL", stage: "implement", runId: impl.runId, verdict, error: impl.error, acceptance: impl.acceptance };
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
    return { state: "FAIL", stage: "review", round, review: rv, error: review.error, workerRunId: impl.runId };
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
    return { state: verdict?.verdict ?? "FAIL", stage: "fix", round, runId: impl.runId, verdict, error: impl.error };
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

// 5. Ledger delta. AUTHORITATIVE write: the parent session applies this object to <ledgerPath> (step-contract row grammar)
//    before dispatching the next step. Every `deferred` entry becomes an `open` row that blocks the terminal gate until a
//    human writes `discharged <commit>` or `waived by <name> <date>: <reason>`.
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
return { state: finalState, ...(finalState === "PASS" ? {} : { stage: "ci" }), ledger, workerRunId: impl.runId, reviewRunId: review.runId };
