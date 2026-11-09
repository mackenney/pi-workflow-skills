// args: { stepFile: "/abs/plans/x/step-07-name.md", planDir: "/abs/plans/x", baseCommit?: "abc123", reviewBase?: "<sha>", sidecarSha?: "<sha256>", stageDir?: "/abs/run/NN-execute",
//         tier?: "deep"|"standard"|"fast", worker?: "<agent name>", pr?: 123, maxFixRounds?: 2, ledgerFile?: "PROGRESS.md", notes?: "<user intent, appended to the worker task>",
//         resume?: { from: "gates"|"review"|"fix"|"ci"|"ledger", commit: "<sha>", workerRunId?, guidance?, resultPath?: "<prior stageDir>/result.json" } }
// baseCommit (else the sidecar's base_commit, else HEAD on a fresh run) only proves a resume commit's ancestry. reviewBase
// is the tree the step's own change is measured against (scope, fails-before): the arg, else HEAD at a fresh start (the
// integrated tree), else baseCommit. The sidecar's base_commit is the plan's original base: measuring a later step
// against it would put earlier steps in its scope. sidecarSha (required with resume) is the sidecar's sha256 at first
// dispatch; tree-check (scripts/tree-check.mjs) blocks a dirty tree before dispatch, and after every worker PASS a
// change to the plan files, uncommitted work, or a HEAD that is not the verdict commit on a branch.
// Resume continues a stopped step from its commit instead of re-implementing it. Every non-PASS result records
// `resumePoint: {from, commit, workerRunId, args}` in result.json and a `fix` actionable carrying the resume args.
// Returns the stage envelope {stage, status, summary, actionables, artifacts} (skills/coordinator/SKILL.md); the full
// result goes to <stageDir>/result.json and the envelope to <stageDir>/brief.json.
// Ledger: once the review passes, this workflow applies the typed verdict to <planDir>/<ledgerFile> through the
// ledger-apply host script (step-contract grammar). Neither the parent nor a model edits ledger rows.
// Sandbox rules: top-level await only, no nested async fns, no fs. Everything file-based goes through children.
// A failed child makes runs.run reject and would end the workflow with no envelope/brief. Convert the rejection into a
// failed result so every exit path reports (runs.all already returns per-child failures).
const safe = (p) => p.then((r) => r, (e) => ({ ok: false, error: String((e && e.message) || e) }));
// runs.run's rejection carries only a message: a failed worker's STEP-VERDICT (its commit) and runId would be lost, and
// resume needs both. runs.all with a config object returns the full failed result; safe() still catches launch errors.
const one = (key, params) => safe(runs.all([{ key, ...params }]).then((rs) => rs[0]));
const ALLOWED_ARGS = ["stepFile", "planDir", "baseCommit", "reviewBase", "sidecarSha", "stageDir", "tier", "worker", "pr", "maxFixRounds", "ledgerFile", "notes", "resume"];
const badArgs = Object.keys(args ?? {}).filter((k) => !ALLOWED_ARGS.includes(k));
if (badArgs.length) {
  // A misspelled or invented arg must not be dropped silently.
  const why = "unknown args: " + badArgs.join(", ") + " (allowed: " + ALLOWED_ARGS.join(", ") + ")";
  const env = { stage: "execute-step", status: "blocked", summary: why.slice(0, 400), actionables: [{ what: why.slice(0, 300), kind: "fix", ref: "workflows/execute-step.js" }], artifacts: { primary: "workflows/execute-step.js" } };
  if (args.stageDir) await safe(runs.run("persist-args", { agent: "wf-host-command", label: "Persist arg error",
    task: JSON.stringify({ script: "write-artifact", path: args.stageDir + "/brief.json", json: env }) }));
  return env;
}

// Tier -> agent. Models are NOT named here; each agent's model comes from the generated agentOverrides (§3.2).
const WORKER_BY_TIER = {
  deep: { agent: "wf-structural-worker" },
  standard: { agent: "worker", skill: "step-contract" }, // per-run skill override, documented for runs.run
  fast: { agent: "wf-flash-worker" }
};

// Empty allowed: a FAIL verdict may have no commit. PASS without one is rejected in code (fixPassless).
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

const ledgerPath = args.planDir + "/" + (args.ledgerFile ?? "PROGRESS.md");
const sidecar = args.stepFile.replace(/\.md$/, ".gates.json");
const stepName = (args.stepFile.split("/").pop() || "step").replace(/\.md$/, "");
const stageDir = args.stageDir ?? (args.planDir + "/runs/" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + stepName);
const R = args.resume;
const RESUME_FROM = ["gates", "review", "fix", "ci", "ledger"];
const RESUME_KEYS = ["from", "commit", "workerRunId", "guidance", "resultPath"];
// Where a stopped step can continue without redoing finished work; null when nothing reusable exists (no commit).
const resumeAt = (from, commit, workerRunId) => (commit ? { from, commit, workerRunId: workerRunId ?? null } : null);
// A worker FAIL may be environmental, so the human is offered the other resume point too; the workflow never picks.
const altResume = (from, commit, workerRunId) => (commit ? [resumeAt(from, commit, workerRunId)] : []);
// A worker PASS the runtime's acceptance rejected is a FAIL; returning "PASS" here would reach the tail with no ledger.
const failState = (v) => (v?.verdict === "BLOCKED" ? "BLOCKED" : "FAIL");
const failedIds = (gs) => (Array.isArray(gs) ? gs.filter((g) => g && g.result === "fail").map((g) => g.id) : []);
// A PASS that contradicts itself (no commit, or its own gates failed) is a FAIL; outputSchema cannot express either.
const fixPassless = (v) => {
  if (!v || v.verdict !== "PASS") return v;
  const why = !v.commit ? "PASS without a commit sha" : failedIds(v.gates).length ? "contradictory PASS: gate(s) " + failedIds(v.gates).join(", ") + " failed" : null;
  return why ? { ...v, verdict: "FAIL", residual_risks: [...(v.residual_risks ?? []), why] } : v;
};
// Same rule for a review: a PASS with failed gates, P0/P1 findings or ledger gaps is routed as a FAIL with its findings.
const reviewContradiction = (rv) => {
  if (!rv || rv.verdict !== "PASS") return null;
  const why = [];
  if (failedIds(rv.gates).length) why.push("gate(s) " + failedIds(rv.gates).join(", ") + " failed");
  const blocking = (rv.findings ?? []).filter((f) => f && f.severity !== "P2").length;
  if (blocking) why.push(blocking + " P0/P1 finding(s)");
  if ((rv.ledger_gaps ?? []).length) why.push(rv.ledger_gaps.length + " ledger gap(s)");
  return why.length ? "contradictory PASS: " + why.join("; ") : null;
};
const parseOut = (r) => { try { return r && r.ok ? JSON.parse(r.output) : null; } catch (e) { return null; } };

// Every exit sets `result` and leaves the block; the tail applies the ledger, persists details and returns the envelope.
let result = null;
// Set inside main once known; the tail writes them into result.json and every resume point's args.
let baseOutRec = null; let reviewBaseRec = null; let sidecarShaRec = args.sidecarSha ?? null; let ignoreShaRec = null;
main: {

// 1. Load the planner-authored gate sidecar mechanically (typed step; no LLM transcription).
const loaded = await safe(runs.run("gates", { agent: "wf-host-command", label: "Load step gates", task: JSON.stringify({ script: "step-loader", stepFile: args.stepFile }) }));
if (!loaded.ok) { result = { state: "BLOCKED", stage: "contract", reason: "gate sidecar unreadable", error: loaded.error }; break main; }
let contract = null; // { step, tier, base_commit?, gates:[{id,class,cmd,timeoutMs,proxy?,result?}], coverage:[...], hard_splits_declared:[...] }
try { contract = JSON.parse(loaded.output); } catch (e) { contract = null; }
if (!contract || contract.error || !Array.isArray(contract.gates)) { result = { state: "BLOCKED", stage: "contract", reason: "gate sidecar unusable", error: contract?.error ?? "no gates array in " + sidecar }; break main; }

const tier = args.tier ?? contract.tier ?? "deep"; // deep is the trial default (RECOMMENDATIONS-v2 R1)
const lane = WORKER_BY_TIER[tier];
if (!lane) { result = { state: "BLOCKED", stage: "contract", reason: "no worker lane for tier " + tier + " (lanes: " + Object.keys(WORKER_BY_TIER).join(", ") + "; frontier-sized steps must be split or planned as deep)" }; break main; }
const workerAgent = args.worker ?? lane.agent;
const baseRef = args.baseCommit ?? contract.base_commit;
const verify = contract.gates
  .filter((g) => g.cmd && g.result !== "n/a" && g.result !== "deferred") // deferred gates are owed by a later step and ledgered, not run here
  .map((g) => ({ id: g.id, command: g.cmd, timeoutMs: g.timeoutMs ?? 900000 })); // default verify timeout is 120 s; builds need more
// An empty set would let acceptance pass on the worker's word; validate-plan rejects such a step, so it means a bad sidecar.
if (verify.length === 0) { result = { state: "BLOCKED", stage: "contract", reason: "no runnable gates in " + sidecar + " (every gate is n/a, deferred or has no cmd)" }; break main; }

// 1a. Tree and plan integrity before any model runs (fail closed). planSha covers the files a worker must not edit.
const hashFiles = [args.stepFile, sidecar, args.planDir + "/plan.json", ledgerPath];
const treeTask = (extra) => JSON.stringify({ script: "tree-check", planDir: args.planDir, stageDir, hashFiles, ...extra });
const pre = parseOut(await safe(runs.run("tree-pre", { agent: "wf-host-command", label: "Check tree before " + contract.step,
  task: treeTask({ drift: { sidecar, planJson: args.planDir + "/plan.json" } }) })));
// A block before the resume guard keeps the incoming resume so the next attempt can start from this brief.
const keepResume = R && typeof R === "object" && R.commit ? { from: R.from, commit: R.commit, workerRunId: R.workerRunId ?? null } : null;
if (!pre || (pre.error && !pre.planSha)) { result = { state: "BLOCKED", stage: "contract", reason: "tree-check failed: " + (pre?.error ?? "output unparseable"), resumePoint: keepResume }; break main; }
if (pre.drift) { result = { state: "BLOCKED", stage: "contract", reason: "sidecar drifted from plan.json: " + pre.drift, resumePoint: keepResume }; break main; }
if (pre.error || !pre.clean) { result = { state: "BLOCKED", stage: "contract", reason: pre.error ?? "tree not clean before dispatch: " + pre.paths.slice(0, 10).join(", ") + (pre.hint ? " (" + pre.hint + ")" : ""), resumePoint: keepResume }; break main; }
const sidecarSha = pre.hashes[sidecar];
if (R !== undefined && !args.sidecarSha) { result = { state: "BLOCKED", stage: "contract", reason: "resume needs sidecarSha (the sidecar hash recorded at first dispatch; it is in the stopped run's resumePoint.args)", resumePoint: keepResume }; break main; }
if (args.sidecarSha && args.sidecarSha !== sidecarSha) { result = { state: "BLOCKED", stage: "contract", reason: "sidecar changed since the stopped run; restore it, or have the human approve the new hash " + sidecarSha + " and pass it as sidecarSha", resumePoint: keepResume }; break main; }
const baseOut = baseRef ?? pre.head;
const reviewBase = args.reviewBase ?? (R === undefined ? pre.head : baseRef) ?? "HEAD";
baseOutRec = baseOut ?? null; reviewBaseRec = reviewBase; sidecarShaRec = sidecarSha; ignoreShaRec = pre.ignoreSha;
// After a worker PASS: the plan files are untouched, HEAD is the verdict commit on a branch, and nothing is left
// uncommitted. Returns the failing result, or null. ignoreSha from the first check makes a self-ignoring worker fail.
const afterWorker = (chk, commit, stage, workerRunId) => {
  if (!chk || !chk.planSha) return { state: "BLOCKED", stage: "gates", reason: "tree-check failed: " + (chk?.error ?? "output unparseable"), resumePoint: resumeAt("gates", commit, workerRunId) };
  if (chk.planSha !== pre.planSha) return { state: "BLOCKED", stage, reason: "plan files changed during the run (step file, sidecar, plan.json or ledger): restore them, then resume", resumePoint: resumeAt("gates", commit, workerRunId) };
  if (chk.error) return { state: "BLOCKED", stage: "gates", reason: chk.error, resumePoint: resumeAt("gates", commit, workerRunId) };
  if (!chk.branch || !String(chk.head ?? "").toLowerCase().startsWith(String(commit).toLowerCase())) return { state: "BLOCKED", stage: "gates", reason: "HEAD is not the step commit on the working branch (HEAD " + String(chk.head).slice(0, 12) + (chk.branch ? "" : ", detached") + "): move the branch to it, never check out a bare sha", resumePoint: resumeAt("gates", commit, workerRunId) };
  if (!chk.clean && chk.allByproducts) return { state: "BLOCKED", stage: "gates", reason: "gate by-products in the tree: " + chk.hint + "; ignore them (.git/info/exclude), then resume", resumePoint: resumeAt("gates", commit, workerRunId) };
  if (!chk.clean) return { state: "FAIL", stage, reason: "worker left uncommitted work: " + chk.paths.slice(0, 10).join(", "), resumePoint: resumeAt("fix", commit, workerRunId), resumeAlternatives: altResume("gates", commit, workerRunId) };
  return null;
};
const treePost = (key, label) => safe(runs.run(key, { agent: "wf-host-command", label, task: treeTask({ ignoreSha: pre.ignoreSha }) }));

// 1b. Resume: prove the commit is real work on this step's base before any model or ledger touches it (fail closed).
let prior = null; let resumeCommit = null;
if (R !== undefined) {
  const badKeys = R && typeof R === "object" ? Object.keys(R).filter((k) => !RESUME_KEYS.includes(k)) : [];
  if (!R || typeof R !== "object" || !RESUME_FROM.includes(R.from) || !/^[0-9a-f]{7,40}$/i.test(String(R.commit ?? "")) || badKeys.length) {
    result = { state: "BLOCKED", stage: "resume", reason: "resume must be {from: " + RESUME_FROM.join("|") + ", commit: <7-40 hex>, workerRunId?, guidance?, resultPath?}" + (badKeys.length ? "; unknown keys: " + badKeys.join(", ") : "") }; break main;
  }
  if (!baseRef) { result = { state: "BLOCKED", stage: "resume", reason: "resume needs baseCommit (or the sidecar's base_commit) to prove the commit descends from the step's base" }; break main; }
  const cc = await safe(runs.run("resume-check", { agent: "wf-host-command", label: "Check resume commit " + String(R.commit).slice(0, 7),
    task: JSON.stringify({ script: "commit-check", commit: R.commit, base: baseRef }) }));
  let chk = null;
  try { chk = cc.ok ? JSON.parse(cc.output) : null; } catch (e) { chk = null; }
  if (!chk || !chk.ok) { result = { state: "BLOCKED", stage: "resume", reason: "resume commit rejected: " + (chk?.error ?? cc.error ?? "commit-check output unparseable") }; break main; }
  resumeCommit = chk.commit;
  // gates and review judge the checkout, so it must already be this commit on a branch; checking out the sha would
  // detach HEAD and drop whatever was integrated after it.
  if ((R.from === "gates" || R.from === "review") && (!pre.branch || pre.head !== resumeCommit)) {
    result = { state: "BLOCKED", stage: "resume", reason: "HEAD " + String(pre.head).slice(0, 12) + (pre.branch ? "" : " (detached)") + " is not the resume commit on the working branch: move the branch to " + resumeCommit.slice(0, 12) + " (never check out a bare sha)", resumePoint: keepResume }; break main;
  }
  if (R.resultPath) {
    const rd = await safe(runs.run("resume-read", { agent: "wf-host-command", label: "Read prior result", task: JSON.stringify({ script: "write-artifact", read: R.resultPath }) }));
    let got = null;
    try { got = rd.ok ? JSON.parse(rd.output) : null; } catch (e) { got = null; }
    if (!got || !got.ok) { result = { state: "BLOCKED", stage: "resume", reason: "cannot read resultPath: " + (got?.error ?? rd.error ?? "unparseable") }; break main; }
    prior = got.json;
  }
  if ((R.from === "ledger") && !prior?.ledger) { result = { state: "BLOCKED", stage: "resume", reason: "resume from ledger needs resultPath to a result.json holding the passed step's ledger" }; break main; }
  // A prior ledger for another commit would tick this step with the wrong sha.
  const priorCommit = prior?.ledger?.commit ?? prior?.verdict?.commit;
  if ((R.from === "ledger" || R.from === "ci") && priorCommit && !String(priorCommit).toLowerCase().startsWith(String(R.commit).toLowerCase()) && !String(R.commit).toLowerCase().startsWith(String(priorCommit).toLowerCase())) {
    result = { state: "BLOCKED", stage: "resume", reason: "resultPath ledger is for commit " + priorCommit + ", not " + R.commit }; break main;
  }
  if (R.from === "ci" && args.pr === undefined) { result = { state: "BLOCKED", stage: "resume", reason: "resume from ci needs pr" }; break main; }
}
const from = R?.from ?? null;

const workerTask = [
  "Implement plan step " + contract.step + ".",
  "Step file: " + args.stepFile,
  "Gate sidecar: " + sidecar,
  "Ledger (read-only for you): " + ledgerPath + " — report ledger rows in your verdict; a script writes the file from it.",
  "Base commit for fails-before checks: " + reviewBase,
  // Without this the worker leaves changes uncommitted ("parent controls commits") and burns a fix round.
  "Commit your work (scoped to the step's files) and report the sha in STEP-VERDICT.commit. Do not edit the ledger.",
  // Observed 2026-10-05: a worker "fixed" an impossible gate by editing the sidecar. The runtime still failed it (verify is
  // loaded before launch), but the plan must stay untouched: a wrong gate is the human's call.
  "Never edit the step file, its gate sidecar, plan.json or PROGRESS.md. If a gate is wrong or cannot pass with a correct implementation, return FAIL and explain it under pending_decisions.",
  "Executor tier: " + tier + ". Follow the step-contract skill exactly.",
  args.notes ? "User notes for this step: " + args.notes : ""
].filter(Boolean).join("\n");

// 2. Worker. The runtime executes every gate command itself (acceptance.verify); the model's claims are evidence, not verdict.
//    If the fast lane is still disabled, this launch fails with an unknown-agent error: enable wf-flash-worker for a measured plan first.
const ACCEPTANCE = {
  level: "verified",
  criteria: ["Every runnable gate (not n/a, not deferred) in the sidecar passes", "Every coverage-matrix row is exercised by a ran gate", "No undeclared proxy; no scope outside the step"],
  evidence: ["changed-files", "commands-run", "residual-risks", "no-staged-files", "diff-summary"],
  verify,
  report: "on"
};
// Resumes that skip the worker review a verdict rebuilt from the prior result (if given) and the sidecar; the reviewer
// re-checks everything, so these fields are context, not authority.
const pv = prior?.verdict ?? prior?.ledger ?? {};
const resumedVerdict = (gates) => ({
  verdict: "PASS", step: contract.step, commit: resumeCommit, gates,
  coverage: pv.coverage ?? contract.coverage ?? [], proxies_used: pv.proxies_used ?? [],
  deferred: pv.deferred ?? contract.gates.filter((g) => g.result === "deferred").map((g) => ({ gate: g.id, owed_by: g.owed_by ?? "?", reason: g.reason ?? "" })),
  decisions_taken: pv.decisions_taken ?? [], pending_decisions: pv.pending_decisions ?? [],
  residual_risks: [...(pv.residual_risks ?? []), "resumed from " + from + " at " + String(resumeCommit).slice(0, 12) + ": no fresh worker verdict"]
});
let impl = { ok: true, runId: R?.workerRunId };
let verdict = null;
if (!R) {
  impl = await one("implement", {
    agent: workerAgent, label: "Implement " + contract.step, task: workerTask,
    ...(lane.skill ? { skill: lane.skill } : {}),
    outputSchema: STEP_VERDICT,
    acceptance: ACCEPTANCE
  });
  verdict = fixPassless(impl.structuredOutput);
  if (!impl.ok || !verdict || verdict.verdict !== "PASS") {
    // A commit the runtime's gates rejected while the worker claimed PASS points at the environment: re-run gates once it
    // is fixed. A worker that itself reported FAIL/BLOCKED left real work: continue it with guidance.
    const rejected = impl.structuredOutput?.verdict === "PASS" && !impl.ok;
    const rp = resumeAt(rejected ? "gates" : "fix", verdict?.commit, impl.runId);
    result = { state: failState(verdict), stage: "implement", runId: impl.runId, verdict, error: impl.error, acceptance: impl.acceptance, resumePoint: rp, resumeAlternatives: altResume(rejected ? "fix" : "gates", verdict?.commit, impl.runId) }; break main;
  }
  const bad = afterWorker(parseOut(await treePost("tree-implement", "Check tree after " + contract.step)), verdict.commit, "implement", impl.runId);
  if (bad) { result = { ...bad, runId: impl.runId, verdict }; break main; }
} else if (from === "gates") {
  const tmo = verify.reduce((s, g) => s + g.timeoutMs, 0) + 60000;
  const rg = await safe(runs.run("resume-gates", { agent: "wf-host-command", label: "Re-run gates for " + contract.step, timeoutMs: tmo,
      task: JSON.stringify({ script: "run-gates", commit: resumeCommit, gates: verify }) }));
  let gr = null;
  try { gr = rg.ok ? JSON.parse(rg.output) : null; } catch (e) { gr = null; }
  if (!gr || (gr.error && !Array.isArray(gr.results))) { result = { state: "BLOCKED", stage: "gates", reason: "gate re-run failed: " + (gr?.error ?? rg.error ?? "run-gates output unparseable"), resumePoint: resumeAt("gates", resumeCommit, R.workerRunId) }; break main; }
  const byId = new Map(gr.results.map((x) => [x.id, x]));
  const gates = contract.gates.map((g) => {
    const x = byId.get(g.id);
    return { id: g.id, class: g.class, ...(g.cmd ? { cmd: g.cmd } : {}), result: x ? (x.pass ? "pass" : "fail") : (g.result ?? "n/a"), ...(x && !x.pass ? { note: (x.timedOut ? "timed out; " : "exit " + x.exitCode + "; ") + x.tail.slice(-200) } : {}) };
  });
  verdict = resumedVerdict(gates);
  if (!gr.ok) {
    // The environment was meant to be fixed; gates still failing on this commit means the work itself needs changes.
    result = { state: "FAIL", stage: "gates", verdict: { ...verdict, verdict: "FAIL" }, reason: "gates still fail: " + gates.filter((g) => g.result === "fail").map((g) => g.id).join(", "), resumePoint: resumeAt("fix", resumeCommit, R.workerRunId) }; break main;
  }
} else if (from === "review") {
  verdict = resumedVerdict(pv.gates ?? []);
} else if (from === "fix") {
  const findings = prior?.review ? "\nLast REVIEW-VERDICT (verbatim JSON):\n" + JSON.stringify(prior.review) : "";
  const guidance = R.guidance ? "\nUser guidance: " + R.guidance : "";
  if (R.workerRunId) {
    impl = await one("resume-fix", {
      resume: R.workerRunId, label: "Resume fix " + contract.step,
      task: "Resuming this step from commit " + resumeCommit + "." + guidance + findings + "\nAddress it, commit, re-run all gates, emit a new STEP-VERDICT.",
      outputSchema: STEP_VERDICT, acceptance: ACCEPTANCE // not inherited on resume; see the fix round below
    });
  }
  // A missing or expired retained worker must not strand the step: a fresh worker picks up from the commit.
  if (!R.workerRunId || (!impl.ok && !impl.structuredOutput)) {
    impl = await one("resume-fresh", {
      agent: workerAgent, label: "Continue " + contract.step,
      task: workerTask + "\nResuming: commit " + resumeCommit + " already holds earlier work on this step. Continue on the current branch; do not check out another commit and do not start over." + guidance + findings,
      ...(lane.skill ? { skill: lane.skill } : {}),
      outputSchema: STEP_VERDICT, acceptance: ACCEPTANCE
    });
  }
  verdict = fixPassless(impl.structuredOutput);
  if (!impl.ok || !verdict || verdict.verdict !== "PASS") {
    result = { state: failState(verdict), stage: "fix", runId: impl.runId, verdict, error: impl.error, acceptance: impl.acceptance, resumePoint: resumeAt("fix", verdict?.commit ?? resumeCommit, impl.runId), resumeAlternatives: altResume("gates", verdict?.commit ?? resumeCommit, impl.runId) }; break main;
  }
  const bad = afterWorker(parseOut(await treePost("tree-resume-fix", "Check tree after " + contract.step)), verdict.commit, "fix", impl.runId);
  if (bad) { result = { ...bad, runId: impl.runId, verdict }; break main; }
}

// 3. Independent review with typed verdict, then bounded fix rounds on the retained worker.
let review = null; let rv = null;
if (from !== "ci" && from !== "ledger") {
  const maxFix = args.maxFixRounds ?? 2;
  let round = 0;
  while (true) {
    const reviewItem = {
      agent: "wf-step-reviewer", label: "Review " + contract.step,
      task: [
        "Review plan step " + contract.step + ", commit " + verdict.commit + ".",
        "Step file: " + args.stepFile, "Gate sidecar: " + sidecar,
        "Ledger: " + ledgerPath, "Base commit: " + reviewBase + " (the step's change is " + reviewBase + ".." + verdict.commit + ")",
        "Worker STEP-VERDICT JSON:", JSON.stringify(verdict)
      ].join("\n"),
      outputSchema: REVIEW_VERDICT
    };
    review = await one("review-" + round, reviewItem);
    // A reviewer crash says nothing about the work: retry once, and never spend a fix round on it.
    if (!review.ok || !review.structuredOutput) review = await one("review-" + round + "-retry", reviewItem);
    rv = review.structuredOutput;
    const contradiction = reviewContradiction(rv);
    if (contradiction) rv = { ...rv, verdict: "FAIL", contradiction };
    if (!review.ok || !rv) {
      result = { state: "BLOCKED", stage: "review", round, reason: "reviewer failed twice (infrastructure): " + String(review.error ?? "no REVIEW-VERDICT"), verdict, workerRunId: impl.runId, resumePoint: resumeAt("review", verdict.commit, impl.runId) }; break main;
    }
    if (rv.verdict === "PASS") break;
    if (round >= maxFix || !impl.runId) {
      result = { state: "FAIL", stage: "review", round, review: rv, verdict, error: review.error, workerRunId: impl.runId, resumePoint: resumeAt("fix", verdict.commit, impl.runId) }; break main;
    }
    round += 1;
    const lastCommit = verdict.commit;
    impl = await one("fix-" + round, {
      resume: impl.runId, label: "Fix " + contract.step + " round " + round,
      task: "Reviewer findings (verbatim JSON). Address each, re-run all gates, emit a new STEP-VERDICT:\n" + JSON.stringify(rv),
      // Confirmed live (2026-09-24, toy step-01-hello): `resume` does NOT re-capture `outputSchema`
      // from the retained contract (R-a in ORCHESTRATION-ENCODING.md \u00a76.3 resolves to "not inherited") --
      // the fix round returned prose with no structured_output call and the workflow correctly failed-safe
      // rather than claim a false PASS. Passing outputSchema explicitly on the resume call fixes this.
      outputSchema: STEP_VERDICT,
      // Same reason as outputSchema: resume resolves per-launch fields from the request first, so the host-run gates
      // must be passed again or a fix commit could pass on the worker's own claims.
      acceptance: ACCEPTANCE
    });
    verdict = fixPassless(impl.structuredOutput);
    if (!impl.ok || !verdict || verdict.verdict !== "PASS") {
      result = { state: failState(verdict), stage: "fix", round, runId: impl.runId, verdict, review: rv, error: impl.error, resumePoint: resumeAt("fix", verdict?.commit ?? lastCommit, impl.runId), resumeAlternatives: altResume("gates", verdict?.commit ?? lastCommit, impl.runId) }; break main;
    }
    const badFix = afterWorker(parseOut(await treePost("tree-fix-" + round, "Check tree after fix " + round)), verdict.commit, "fix", impl.runId);
    if (badFix) { result = { ...badFix, round, runId: impl.runId, verdict, review: rv }; break main; }
  }
  // The reviewer has bash too: the ledger is applied only if the plan files are still the ones this run started from.
  const postReview = parseOut(await treePost("tree-review", "Check plan files after review"));
  if (!postReview || postReview.planSha !== pre.planSha) {
    result = { state: "BLOCKED", stage: "review", reason: postReview ? "plan files changed during the review: restore them, then resume" : "tree-check failed after review", verdict, review: rv, workerRunId: impl.runId, resumePoint: resumeAt("review", verdict.commit, impl.runId) }; break main;
  }
}

// 4. Optional CI gate from structured gh output (never tail/truncated text). Resuming from ledger keeps the prior CI read.
const commit = verdict?.commit ?? resumeCommit;
let ci = from === "ledger" ? (prior.ledger.ci ?? null) : null;
if (args.pr !== undefined && from !== "ledger") {
  // expectSha binds the checks to this step's commit (a green PR head for an older commit is "stale", not green).
  // timeoutMs stays above the 30-minute CI wait so a slow CI cannot kill the runner.
  const ciRun = await safe(runs.run("ci", { agent: "wf-host-command", label: "Read CI for PR " + args.pr, timeoutMs: 2100000,
    task: JSON.stringify({ script: "ci-gate", pr: args.pr, waitSeconds: 1800, expectSha: commit }) }));
  try { ci = ciRun.ok ? JSON.parse(ciRun.output) : { state: "unknown", error: ciRun.error }; } catch (e) { ci = { state: "unknown", error: "ci-gate output unparseable" }; }
}

// 5. Ledger delta, applied below by ledger-apply. Every `deferred`/proxy entry becomes an `open` row that blocks the
//    terminal gate until a human writes `discharged <commit>` or `waived by <name> <date>: <reason>`.
//    ci/ledger resumes reuse the prior ledger; without one (ci only) the step's rows were already applied when its review
//    passed, so a bare {step, commit} only ticks it.
const pl = (from === "ci" || from === "ledger") ? (prior?.ledger ?? { step: contract.step, gates: [] }) : null;
const ledger = pl ? { ...pl, step: contract.step, commit, ledgerPath, ci } : {
  step: contract.step, commit, ledgerPath, gates: verdict.gates.length ? verdict.gates : (rv?.gates ?? []),
  deferred: verdict.deferred, proxies_used: verdict.proxies_used,
  decisions_taken: verdict.decisions_taken, pending_decisions: verdict.pending_decisions,
  residual_risks: verdict.residual_risks, review: rv, ci
};
// Optional, best-effort mirror only (mission state is subject to retention cleanup and is never read as authority).
if (typeof state !== "undefined") { try { await state.set("ledger." + contract.step, ledger); } catch (_) { /* mirror failure is not a step failure */ } }
// Only green CI (or no PR) is PASS. red -> FAIL; pending/none/stale/unknown -> BLOCKED for the parent to resolve.
const finalState = !ci || ci.state === "green" ? "PASS" : ci.state === "red" ? "FAIL" : "BLOCKED";
const workerRunId = impl.runId ?? prior?.workerRunId;
result = { state: finalState, ...(finalState === "PASS" ? {} : { stage: "ci", resumePoint: resumeAt("ci", commit, workerRunId) }), ledger, workerRunId, reviewRunId: review?.runId ?? prior?.reviewRunId, ...(from ? { resumedFrom: from } : {}) };
}

// Tail: ledger, persisted details, envelope.
result = { ...result, ...(sidecarShaRec ? { sidecarSha: sidecarShaRec } : {}), ...(ignoreShaRec ? { ignoreSha: ignoreShaRec } : {}) };
const verdictOut = result.ledger ? null : result.verdict;
let ledgerApply = null;
if (result.ledger) {
  // The review passed: record decisions/deferred rows; tick the step only when the step is PASS (CI included).
  const la = await safe(runs.run("ledger", { agent: "wf-host-command", label: "Apply ledger " + result.ledger.step,
    task: JSON.stringify({ script: "ledger-apply", planDir: args.planDir, ledgerFile: args.ledgerFile, ledgers: [{ ...result.ledger, tick: result.state === "PASS" }] }) }));
  try { ledgerApply = la.ok ? JSON.parse(la.output) : { ok: false, errors: [la.error] }; } catch (e) { ledgerApply = { ok: false, errors: ["ledger-apply output unparseable"] }; }
  if (!ledgerApply.ok && result.state === "PASS") result = { ...result, state: "BLOCKED", stage: "ledger", resumePoint: resumeAt("ledger", result.ledger.commit, result.workerRunId) };
}
// The exact args that continue this step; resultPath lets the resumed run reuse this run's verdict/ledger, and a fresh
// stageDir keeps this run's result.json intact.
const withArgs = (pt) => {
  const { resume: _old, ...rest } = args;
  return { ...pt, args: { ...rest, ...(baseOutRec ? { baseCommit: baseOutRec } : {}), ...(reviewBaseRec ? { reviewBase: reviewBaseRec } : {}), ...(sidecarShaRec ? { sidecarSha: sidecarShaRec } : {}), stageDir: stageDir + "-resume-" + pt.from, resume: { from: pt.from, commit: pt.commit, ...(pt.workerRunId ? { workerRunId: pt.workerRunId } : {}), resultPath: stageDir + "/result.json" } } };
};
const rp = result.state !== "PASS" && result.resumePoint ? withArgs(result.resumePoint) : null;
const alts = rp ? (result.resumeAlternatives ?? []).map(withArgs) : [];
if (rp) result = { ...result, resumePoint: rp, ...(alts.length ? { resumeAlternatives: alts } : {}) };
const L = result.ledger;
const actionables = [];
// Failure and resume first: the envelope caps actionables at 12 and these are the ones the parent must act on.
if (result.state !== "PASS") actionables.push({ what: (result.stage ?? "step") + ": " + (result.reason ?? result.error ?? (result.review?.findings?.[0]?.evidence) ?? (verdictOut?.residual_risks?.[0]) ?? (L?.ci ? "CI " + L.ci.state : "see result.json")), kind: "fix", ref: stageDir + "/result.json" });
if (rp) {
  const full = "resume from " + rp.from + " at " + rp.commit + (rp.from === "fix" ? " (add resume.guidance)" : "") + ": args.resume=" + JSON.stringify(rp.args.resume);
  actionables.push({ what: full.length <= 300 ? full : "resume from " + rp.from + " at " + rp.commit + ": pass result.json resumePoint.args", kind: "fix", ref: stageDir + "/result.json#resumePoint" });
}
for (const a of alts) {
  const full = "resume from " + a.from + " at " + a.commit + (a.from === "gates" ? " (after fixing the environment)" : " (add resume.guidance)") + ": args.resume=" + JSON.stringify(a.args.resume);
  actionables.push({ what: full.length <= 300 ? full : "resume from " + a.from + " at " + a.commit + ": pass result.json resumeAlternatives args", kind: "fix", ref: stageDir + "/result.json#resumeAlternatives" });
}
for (const p of L?.pending_decisions ?? []) actionables.push({ what: p, kind: "decision", ref: ledgerPath + "#pending-decisions-human" });
for (const d of L?.deferred ?? []) actionables.push({ what: "deferred " + d.gate + " (owed by " + d.owed_by + ")", kind: "info", ref: ledgerPath + "#tech-debt--deferred-gates" });
for (const e of ledgerApply?.errors ?? []) actionables.push({ what: "ledger-apply: " + e, kind: "fix", ref: ledgerPath });
for (const rk of (L?.residual_risks ?? []).slice(0, 3)) actionables.push({ what: rk, kind: "info", ref: stageDir + "/result.json" });
const status = result.state === "PASS" ? (actionables.some((a) => a.kind === "decision") ? "needs-decision" : "done") : result.state === "BLOCKED" ? "blocked" : "failed";
const stepId = L?.step ?? stepName;
const summary = result.state === "PASS"
  ? stepId + " PASS @" + String(L.commit).slice(0, 7) + "; " + (L.gates ?? []).filter((g) => g.result === "pass").length + " gates passed; ledger " + (ledgerApply?.ok ? "applied" : "NOT applied") + (result.resumedFrom ? " (resumed from " + result.resumedFrom + ")" : "") + "."
  : stepId + " " + result.state + (result.stage ? " at " + result.stage : "") + ": " + String(result.reason ?? result.error ?? "see result.json").split("\n").filter((l) => l && !/^Run fan-out/.test(l)).slice(0, 2).join(" ").slice(0, 200) + ".";
const envelope = { stage: "execute-step", status, summary, actionables: actionables.slice(0, 12), artifacts: { primary: result.state === "PASS" ? ledgerPath : stageDir + "/result.json", details: [stageDir + "/result.json"] } };
await safe(runs.run("persist", { agent: "wf-host-command", label: "Persist " + stepId,
  task: JSON.stringify({ script: "write-artifact", files: [{ path: stageDir + "/result.json", json: { ...result, ledgerApply } }, { path: stageDir + "/brief.json", json: envelope }] }) }));
return envelope;
