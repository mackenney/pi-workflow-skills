// args: { planDir: "/abs/plans/x", stepFiles: ["/abs/plans/x/step-03-a.md", ...] (independent atomic steps of one wave),
//         baseCommit?: "abc123", tier?: "standard"|"deep"|"fast", ledgerFile?: "PROGRESS.md" }
// One lane per independent step, each worker in its own managed git worktree (source checkout must be clean).
// No fix rounds here: a failed lane is re-run by the parent through execute-step.js.
// Integration is the PARENT's job: committed lanes are retained on branches `pi-subagents/<key>-...`, recorded in
// <lane.asyncDir>/handoff.json (groups[0].children[0].patch.branch). Merge them, then re-run the wave's gates on the
// merged tree before applying ledgers. Sandbox rules: top-level await only, no nested async fns, no fs.

const WORKER_BY_TIER = {
  deep: { agent: "wf-structural-worker" },
  standard: { agent: "worker", skill: "step-contract" },
  fast: { agent: "wf-flash-worker" }
};

// Keep in sync with execute-step.js (the sandbox cannot import shared modules).
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

if (!Array.isArray(args.stepFiles) || args.stepFiles.length === 0) return { state: "BLOCKED", reason: "args.stepFiles must be a non-empty array" };
const ledgerPath = args.planDir + "/" + (args.ledgerFile ?? "PROGRESS.md");
const keyOf = (f) => (f.split("/").pop() || f).replace(/\.md$/, "").replace(/[^A-Za-z0-9._-]/g, "-");

// 1. Load every sidecar mechanically.
const loaded = await runs.all(args.stepFiles.map((f) => ({
  key: "gates-" + keyOf(f), agent: "wf-host-command", label: "Load gates " + keyOf(f),
  task: JSON.stringify({ script: "step-loader", stepFile: f })
})));
const contracts = [];
for (let i = 0; i < loaded.length; i += 1) {
  let c = null;
  try { c = loaded[i].ok ? JSON.parse(loaded[i].output) : null; } catch (e) { c = null; }
  if (!c || c.error || !Array.isArray(c.gates)) return { state: "BLOCKED", reason: "gate sidecar unusable for " + args.stepFiles[i], error: c?.error ?? loaded[i].error ?? "no gates array" };
  // Same tier resolution and default as execute-step.js; an unknown tier blocks the wave instead of silently downgrading.
  const tier = args.tier ?? c.tier ?? "deep";
  if (!WORKER_BY_TIER[tier]) return { state: "BLOCKED", reason: "no worker lane for tier " + tier + " in " + args.stepFiles[i] + " (lanes: " + Object.keys(WORKER_BY_TIER).join(", ") + ")" };
  contracts.push({ ...c, _tier: tier });
}

// 2. Workers in parallel, isolated worktrees, runtime-executed gates.
const workers = await runs.all(contracts.map((c, i) => {
  const tier = c._tier;
  const lane = WORKER_BY_TIER[tier];
  return {
    key: "impl-" + keyOf(args.stepFiles[i]), agent: lane.agent, label: "Implement " + c.step, worktree: true,
    ...(lane.skill ? { skill: lane.skill } : {}),
    task: [
      "Implement plan step " + c.step + " (atomic, independent of the other steps in this wave).",
      "Step file: " + args.stepFiles[i], "Gate sidecar: " + args.stepFiles[i].replace(/\.md$/, ".gates.json"),
      "Ledger (read-only for you): " + ledgerPath + " - report ledger rows in your verdict; the parent writes the file.",
      "Base commit for fails-before checks: " + (args.baseCommit ?? c.base_commit ?? "HEAD"),
      "You are in an isolated git worktree. Commit your work there; report the commit sha in STEP-VERDICT.commit.",
      "Executor tier: " + tier + ". Follow the step-contract skill exactly."
    ].join("\n"),
    outputSchema: STEP_VERDICT,
    acceptance: {
      level: "verified",
      criteria: ["Every non-n/a gate in the sidecar passes", "No undeclared proxy; no scope outside the step"],
      evidence: ["changed-files", "commands-run", "residual-risks", "no-staged-files", "diff-summary"],
      verify: c.gates.filter((g) => g.cmd && g.result !== "n/a" && g.result !== "deferred").map((g) => ({ id: g.id, command: g.cmd, timeoutMs: g.timeoutMs ?? 900000 })),
      report: "on"
    }
  };
}));

// 3. Independent typed review of each PASSing lane. The reviewer runs in the main checkout, so it re-runs gates in a
//    throwaway detached worktree of the lane commit (lane branches share the object store).
const passing = workers.map((w, i) => ({ w, i })).filter(({ w }) => w.ok && w.structuredOutput && w.structuredOutput.verdict === "PASS" && w.structuredOutput.commit);
const reviews = passing.length === 0 ? [] : await runs.all(passing.map(({ w, i }) => ({
  key: "review-" + keyOf(args.stepFiles[i]), agent: "wf-step-reviewer", label: "Review " + contracts[i].step,
  task: [
    "Review plan step " + contracts[i].step + ", commit " + w.structuredOutput.commit + " (on a lane branch, not checked out here).",
    "Inspect with `git show`/`git diff <base>..<commit>`. To re-run gates: `git worktree add --detach /tmp/wf-review-" + keyOf(args.stepFiles[i]) + " " + w.structuredOutput.commit + "`, run them there, then `git worktree remove --force` it. Do not edit anything.",
    "Step file: " + args.stepFiles[i], "Ledger: " + ledgerPath, "Base commit: " + (args.baseCommit ?? contracts[i].base_commit ?? "HEAD"),
    "Worker STEP-VERDICT JSON:", JSON.stringify(w.structuredOutput)
  ].join("\n"),
  outputSchema: REVIEW_VERDICT
})));

// 4. Board: one ledger object per lane. Parent merges PASS lanes, re-gates the merged tree, then applies ledgers.
const board = contracts.map((c, i) => {
  const w = workers[i]; const v = w.structuredOutput;
  const pIdx = passing.findIndex((p) => p.i === i);
  const r = pIdx >= 0 ? reviews[pIdx] : null; const rv = r ? r.structuredOutput : null;
  const state = !w.ok || !v ? "FAIL" : v.verdict !== "PASS" ? v.verdict : (r && r.ok && rv && rv.verdict === "PASS" ? "PASS" : "FAIL");
  return {
    step: c.step, stepFile: args.stepFiles[i], state, stage: state === "PASS" ? null : (pIdx >= 0 ? "review" : "implement"),
    commit: v?.commit ?? null, workerRunId: w.runId, asyncDir: w.asyncDir, error: w.error ?? r?.error ?? null,
    ledger: v ? { step: c.step, commit: v.commit, ledgerPath, gates: v.gates, deferred: v.deferred, proxies_used: v.proxies_used,
                  decisions_taken: v.decisions_taken, pending_decisions: v.pending_decisions, residual_risks: v.residual_risks, review: rv } : null
  };
});
return { state: board.every((l) => l.state === "PASS") ? "PASS" : "PARTIAL", board };
