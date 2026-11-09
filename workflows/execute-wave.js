// args: { planDir: "/abs/plans/x", stepFiles: ["/abs/plans/x/step-03-a.md", ...] (independent atomic steps of one wave),
//         baseCommit?: "abc123", tier?: "standard"|"deep"|"fast", ledgerFile?: "PROGRESS.md", stageDir?: "/abs/run/NN-execute", notes?: "<user intent, appended to worker tasks>" }
// Returns the stage envelope; the lane board goes to <stageDir>/result.json (read by ledger-apply's fromResult).
// One lane per independent step, each worker in its own managed git worktree (source checkout must be clean; tree-check
// blocks a dirty one, sidecar drift from plan.json, and a step with no runnable gate before any worker runs).
// baseCommit (fails-before and review base) defaults to HEAD at the start of the wave, not the sidecar's base_commit:
// the plan's original base would put earlier waves in each step's scope.
// No fix rounds here: a failed lane is re-run by the parent through execute-step.js.
// Integration is the PARENT's job: committed lanes are retained on branches `pi-subagents/<key>-...`, recorded in
// <lane.asyncDir>/handoff.json (groups[0].children[0].patch.branch). Merge them, then re-run the wave's gates on the
// merged tree, then apply the lane ledgers with ledger-apply {"planDir", "fromResult": "<stageDir>/result.json"}. Sandbox rules: top-level await only, no nested async fns, no fs.
// A failed child makes runs.run reject and would end the workflow with no envelope/brief. Convert the rejection into a
// failed result so every exit path reports (runs.all already returns per-child failures).
const safe = (p) => p.then((r) => r, (e) => ({ ok: false, error: String((e && e.message) || e) }));
const ALLOWED_ARGS = ["stepFiles", "planDir", "baseCommit", "stageDir", "tier", "ledgerFile", "notes"];
const badArgs = Object.keys(args ?? {}).filter((k) => !ALLOWED_ARGS.includes(k));
if (badArgs.length) {
  // A misspelled or invented arg must not be dropped silently.
  const why = "unknown args: " + badArgs.join(", ") + " (allowed: " + ALLOWED_ARGS.join(", ") + ")";
  const env = { stage: "execute-wave", status: "blocked", summary: why.slice(0, 400), actionables: [{ what: why.slice(0, 300), kind: "fix", ref: "workflows/execute-wave.js" }], artifacts: { primary: "workflows/execute-wave.js" } };
  if (args.stageDir) await safe(runs.run("persist-args", { agent: "wf-host-command", label: "Persist arg error",
    task: JSON.stringify({ script: "write-artifact", path: args.stageDir + "/brief.json", json: env }) }));
  return env;
}

const WORKER_BY_TIER = {
  deep: { agent: "wf-structural-worker" },
  standard: { agent: "worker", skill: "step-contract" },
  fast: { agent: "wf-flash-worker" }
};

// Keep in sync with execute-step.js (the sandbox cannot import shared modules).
// Empty allowed: a FAIL verdict may have no commit. PASS without one is rejected in code (the board).
const COMMIT = { type: "string", pattern: "^([0-9a-f]{7,40})?$" };
const STEP_VERDICT = {
  type: "object", additionalProperties: false,
  required: ["verdict", "step", "gates", "coverage", "proxies_used", "deferred", "decisions_taken", "pending_decisions", "residual_risks"],
  properties: {
    verdict: { enum: ["PASS", "FAIL", "BLOCKED"] },
    step: { type: "string" }, commit: COMMIT,
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
    verdict: { enum: ["PASS", "FAIL"] }, step: { type: "string" }, commit: COMMIT,
    gates: STEP_VERDICT.properties.gates,
    findings: { type: "array", items: { type: "object", required: ["severity", "class", "location", "evidence", "smallest_fix"] } },
    ledger_gaps: { type: "array", items: { type: "string" } }
  }
};

const stageDir = args.stageDir ?? (args.planDir + "/runs/" + new Date().toISOString().replace(/[:.]/g, "-") + "-wave");
const parseOut = (r) => { try { return r && r.ok ? JSON.parse(r.output) : null; } catch (e) { return null; } };
const failedIds = (gs) => (Array.isArray(gs) ? gs.filter((g) => g && g.result === "fail").map((g) => g.id) : []);
// Same contradiction rules as execute-step.js: a self-contradicting PASS is a FAIL.
const fixPassless = (v) => {
  if (!v || v.verdict !== "PASS") return v;
  const why = !v.commit ? "PASS without a commit sha" : failedIds(v.gates).length ? "contradictory PASS: gate(s) " + failedIds(v.gates).join(", ") + " failed" : null;
  return why ? { ...v, verdict: "FAIL", residual_risks: [...(v.residual_risks ?? []), why] } : v;
};
const reviewContradiction = (rv) => {
  if (!rv || rv.verdict !== "PASS") return null;
  const why = [];
  if (failedIds(rv.gates).length) why.push("gate(s) " + failedIds(rv.gates).join(", ") + " failed");
  const blocking = (rv.findings ?? []).filter((f) => f && f.severity !== "P2").length;
  if (blocking) why.push(blocking + " P0/P1 finding(s)");
  if ((rv.ledger_gaps ?? []).length) why.push(rv.ledger_gaps.length + " ledger gap(s)");
  return why.length ? "contradictory PASS: " + why.join("; ") : null;
};
let result = null;
main: {
if (!Array.isArray(args.stepFiles) || args.stepFiles.length === 0) { result = { state: "BLOCKED", reason: "args.stepFiles must be a non-empty array" }; break main; }
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
  if (!c || c.error || !Array.isArray(c.gates)) { result = { state: "BLOCKED", reason: "gate sidecar unusable for " + args.stepFiles[i], error: c?.error ?? loaded[i].error ?? "no gates array" }; break main; }
  // Same tier resolution and default as execute-step.js; an unknown tier blocks the wave instead of silently downgrading.
  const tier = args.tier ?? c.tier ?? "deep";
  if (!WORKER_BY_TIER[tier]) { result = { state: "BLOCKED", reason: "no worker lane for tier " + tier + " in " + args.stepFiles[i] + " (lanes: " + Object.keys(WORKER_BY_TIER).join(", ") + ")" }; break main; }
  const verify = c.gates.filter((g) => g.cmd && g.result !== "n/a" && g.result !== "deferred").map((g) => ({ id: g.id, command: g.cmd, timeoutMs: g.timeoutMs ?? 900000 }));
  if (verify.length === 0) { result = { state: "BLOCKED", reason: "no runnable gates in " + args.stepFiles[i].replace(/\.md$/, ".gates.json") }; break main; }
  contracts.push({ ...c, _tier: tier, _verify: verify });
}
const sidecars = args.stepFiles.map((f) => f.replace(/\.md$/, ".gates.json"));
const planJson = args.planDir + "/plan.json";
const treeTask = (extra) => JSON.stringify({ script: "tree-check", planDir: args.planDir, stageDir, hashFiles: [...args.stepFiles, ...sidecars, planJson, ledgerPath], ...extra });
const pre = parseOut(await safe(runs.run("tree-pre", { agent: "wf-host-command", label: "Check tree before the wave",
  task: treeTask({ drift: sidecars.map((sc) => ({ sidecar: sc, planJson })) }) })));
if (!pre || (pre.error && !pre.planSha)) { result = { state: "BLOCKED", reason: "tree-check failed: " + (pre?.error ?? "output unparseable") }; break main; }
if (pre.drift) { result = { state: "BLOCKED", reason: "sidecar drifted from plan.json: " + pre.drift }; break main; }
if (pre.error || !pre.clean) { result = { state: "BLOCKED", reason: pre.error ?? "source checkout not clean: " + pre.paths.slice(0, 10).join(", ") + (pre.hint ? " (" + pre.hint + ")" : "") }; break main; }
const base = args.baseCommit ?? pre.head;

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
      "Ledger (read-only for you): " + ledgerPath + " - report ledger rows in your verdict; a script writes the file from it after integration.",
      "Base commit for fails-before checks: " + base,
      "You are in an isolated git worktree. Commit your work there; report the commit sha in STEP-VERDICT.commit.",
      "Never edit the step file, its gate sidecar, plan.json or PROGRESS.md. If a gate is wrong or cannot pass with a correct implementation, return FAIL and explain it under pending_decisions.",
      "Executor tier: " + tier + ". Follow the step-contract skill exactly.",
      args.notes ? "User notes for this wave: " + args.notes : ""
    ].filter(Boolean).join("\n"),
    outputSchema: STEP_VERDICT,
    acceptance: {
      level: "verified",
      criteria: ["Every runnable gate (not n/a, not deferred) in the sidecar passes", "No undeclared proxy; no scope outside the step"],
      evidence: ["changed-files", "commands-run", "residual-risks", "no-staged-files", "diff-summary"],
      verify: c._verify,
      report: "on"
    }
  };
}));

// Workers get absolute paths into the main checkout's plan dir: an edit there voids every lane of this wave.
const post = parseOut(await safe(runs.run("tree-post", { agent: "wf-host-command", label: "Check plan files after the wave", task: treeTask({}) })));
const planChanged = !post || post.planSha !== pre.planSha
  ? (post ? "plan files changed during the wave (step files, sidecars, plan.json or ledger): restore them" : "tree-check failed after the wave (output unparseable)")
  : null;
const verdicts = workers.map((w) => fixPassless(w.structuredOutput));

// 3. Independent typed review of each PASSing lane. The reviewer runs in the main checkout, so it re-runs gates in a
//    throwaway detached worktree of the lane commit (lane branches share the object store).
const passing = planChanged ? [] : workers.map((w, i) => ({ w, i })).filter(({ w, i }) => w.ok && verdicts[i] && verdicts[i].verdict === "PASS");
const reviewItems = passing.map(({ w, i }) => ({
  key: "review-" + keyOf(args.stepFiles[i]), agent: "wf-step-reviewer", label: "Review " + contracts[i].step,
  task: [
    "Review plan step " + contracts[i].step + ", commit " + w.structuredOutput.commit + " (on a lane branch, not checked out here).",
    "Inspect with `git show`/`git diff <base>..<commit>`. To re-run gates: `git worktree add --detach " + stageDir + "/review-" + keyOf(args.stepFiles[i]) + " " + w.structuredOutput.commit + "`, run them there, then `git worktree remove --force` it. Do not edit anything.",
    "Step file: " + args.stepFiles[i], "Ledger: " + ledgerPath, "Base commit: " + base + " (the step's change is " + base + ".." + w.structuredOutput.commit + ")",
    "Worker STEP-VERDICT JSON:", JSON.stringify(w.structuredOutput)
  ].join("\n"),
  outputSchema: REVIEW_VERDICT
}));
const reviews = reviewItems.length === 0 ? [] : await runs.all(reviewItems);
// A reviewer crash says nothing about the lane's work: retry those reviews once; a lane whose review still crashes is
// BLOCKED (re-review it), not FAIL (which would send it back to a worker).
const crashed = (r) => !r || !r.ok || !r.structuredOutput;
const retryIdx = reviews.map((r, j) => (crashed(r) ? j : -1)).filter((j) => j >= 0);
if (retryIdx.length) {
  const again = await runs.all(retryIdx.map((j) => ({ ...reviewItems[j], key: reviewItems[j].key + "-retry" })));
  retryIdx.forEach((j, k) => { reviews[j] = again[k]; });
}

// 4. Board: one ledger object per lane. Parent merges PASS lanes, re-gates the merged tree, then applies ledgers.
const board = contracts.map((c, i) => {
  const w = workers[i]; const v = verdicts[i];
  const pIdx = passing.findIndex((p) => p.i === i);
  const r = pIdx >= 0 ? reviews[pIdx] : null; const raw = r ? r.structuredOutput : null;
  const contradiction = reviewContradiction(raw);
  const rv = contradiction ? { ...raw, verdict: "FAIL", contradiction } : raw;
  const noCommit = w.structuredOutput?.verdict === "PASS" && !w.structuredOutput.commit;
  // planChanged: no lane is reviewed; a lane the worker passed is BLOCKED until the plan files are restored.
  const held = planChanged && w.ok && v?.verdict === "PASS";
  const state = held ? "BLOCKED" : !w.ok || !v || noCommit ? "FAIL" : v.verdict !== "PASS" ? v.verdict : pIdx >= 0 && crashed(r) ? "BLOCKED" : (rv?.verdict === "PASS" ? "PASS" : "FAIL");
  return {
    step: c.step, stepFile: args.stepFiles[i], state, stage: state === "PASS" ? null : held ? "contract" : (pIdx >= 0 ? "review" : "implement"),
    commit: v?.commit ?? null, workerRunId: w.runId, asyncDir: w.asyncDir, sidecarSha: pre.hashes[sidecars[i]],
    // Same rule as execute-step.js: a claimed PASS the runtime gates rejected re-runs gates; a worker FAIL continues the work.
    resumeFrom: state === "PASS" || !v?.commit ? null : held ? "review" : pIdx >= 0 ? (crashed(r) ? "review" : "fix") : (v.verdict === "PASS" && !w.ok ? "gates" : "fix"),
    // The human chooses (fix the environment then re-run gates, or spend the worker again); the workflow never infers which.
    resumeAlternative: state === "PASS" || !v?.commit || pIdx >= 0 ? null : (v.verdict === "PASS" && !w.ok ? "fix" : "gates"),
    error: (held ? planChanged : null) ?? w.error ?? (noCommit ? "PASS without a commit sha" : null) ?? (v && v !== w.structuredOutput ? v.residual_risks.at(-1) : null) ?? (pIdx >= 0 && crashed(r) ? "reviewer failed twice (infrastructure): " + (r?.error ?? "no REVIEW-VERDICT") : r?.error) ?? contradiction ?? null,
    ledger: v ? { step: c.step, commit: v.commit, ledgerPath, gates: v.gates, deferred: v.deferred, proxies_used: v.proxies_used,
                  decisions_taken: v.decisions_taken, pending_decisions: v.pending_decisions, residual_risks: v.residual_risks, review: rv } : null
  };
});
result = { state: board.every((l) => l.state === "PASS") ? "PASS" : "PARTIAL", board };
}

// Tail: persist the board, return the envelope. Ledgers are applied by the parent through ledger-apply after
// merge + integrated re-gate (lanes passed in isolation only).
const lanes = result.board ?? [];
const actionables = [];
for (const l of lanes.filter((x) => x.state === "PASS")) actionables.push({ what: "merge " + l.step + " @" + String(l.commit).slice(0, 7) + " (branch in handoff.json)", kind: "info", ref: l.asyncDir + "/handoff.json" });
// The resume commit is HEAD after the merge (the lane commit only on a fast-forward), never the bare lane commit: checking
// that out would detach HEAD and drop the integrated wave. reviewBase keeps the step's scope to its own change.
const how = "; pass reviewBase = HEAD before the merge and the lane's sidecarSha (result.json board)";
for (const l of lanes.filter((x) => x.state !== "PASS")) actionables.push({ what: l.step + " " + l.state + " at " + l.stage + ": " + (l.resumeFrom ? (l.stage === "review" && l.resumeFrom === "review" ? "reviewer crashed; " : "") + "merge the lane branch, then execute-step.js resume {from: \"" + l.resumeFrom + "\", commit: <HEAD after the merge, " + String(l.commit).slice(0, 12) + " if fast-forward>, workerRunId: \"" + l.workerRunId + "\"}" + (l.resumeFrom === "review" ? " (from gates if not a fast-forward)" : "") + how : "re-run through execute-step.js"), kind: "fix", ref: stageDir + "/result.json" });
for (const l of lanes.filter((x) => x.state !== "PASS" && x.resumeAlternative)) actionables.push({ what: l.step + ": alternatively resume from " + l.resumeAlternative + " (after fixing the environment): execute-step.js resume {from: \"" + l.resumeAlternative + "\", commit: <HEAD after the merge>, workerRunId: \"" + l.workerRunId + "\"}" + how, kind: "fix", ref: stageDir + "/result.json" });
for (const l of lanes) for (const p of l.ledger?.pending_decisions ?? []) actionables.push({ what: l.step + ": " + p, kind: "decision", ref: stageDir + "/result.json" });
if (!lanes.length) actionables.push({ what: result.reason ?? result.error ?? "wave blocked", kind: "fix", ref: stageDir + "/result.json" });
const passN = lanes.filter((x) => x.state === "PASS").length;
const status = result.state === "BLOCKED" ? "blocked" : passN === 0 ? "failed" : actionables.some((a) => a.kind === "decision") ? "needs-decision" : result.state === "PASS" ? "done" : "failed";
const summary = result.state === "BLOCKED" ? "wave BLOCKED: " + (result.reason ?? "") : passN + "/" + lanes.length + " lanes PASS. Next: merge PASS lanes in step order, re-run their gates on the merged tree, then ledger-apply fromResult.";
const envelope = { stage: "execute-wave", status, summary, actionables, artifacts: { primary: stageDir + "/result.json", details: [] } };
await safe(runs.run("persist", { agent: "wf-host-command", label: "Persist wave",
  task: JSON.stringify({ script: "write-artifact", files: [{ path: stageDir + "/result.json", json: result }, { path: stageDir + "/brief.json", json: envelope }] }) }));
return envelope;
