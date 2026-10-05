// Returns the stage envelope; full result in <stageDir>/result.json (stageDir defaults under <planDir>/runs/).
// args: { spec: "/abs/spec.md", planDir: "/abs/plans/x", stageDir?: "/abs/run/NN-plan", tier?: "deep"|"standard"|"fast" (planning effort; step tiers are validated separately),
//         mode?: "structural"|"simple", angles?: number|[] (default 3 unless mode "simple"), maxSynthRounds?: 3,
//         plannerModel?/synthModel?/factcheckModel?/fixModel?: "<provider/id[:thinking]>", notes?: "<user intent, appended to every child task>",
//         fixScope?: "clear"|"trivial"|"all"|"none" (default "clear"; same meaning as in review-factcheck-fix.js) }
// Unknown args return a blocked envelope: a misspelled or invented arg must not be dropped silently.
// Sandbox rules: top-level await only, no nested async fns, no fs. Everything file-based goes through children.
// Gate commands run through the host shell, so the env override expands there (isolated test installs set it).
// A failed child makes runs.run reject and would end the workflow with no envelope/brief. Convert the rejection into a
// failed result so every exit path reports (runs.all already returns per-child failures).
const safe = (p) => p.then((r) => r, (e) => ({ ok: false, error: String((e && e.message) || e) }));
const SKILLS = "${PI_WORKFLOW_SKILLS_DIR:-/home/ignacio/pr/pi-workflow-skills}";
const ALLOWED_ARGS = ["spec", "planDir", "stageDir", "tier", "mode", "angles", "maxSynthRounds", "plannerModel", "synthModel", "factcheckModel", "fixModel", "fixScope", "notes"];
const FIX_SCOPES = ["clear", "trivial", "all", "none"];
const badArgs = Object.keys(args ?? {}).filter((k) => !ALLOWED_ARGS.includes(k));
const badScope = args.fixScope !== undefined && !FIX_SCOPES.includes(args.fixScope);
if (badArgs.length || badScope || !args.planDir || !args.spec) {
  const why = badArgs.length ? "unknown args: " + badArgs.join(", ") + " (allowed: " + ALLOWED_ARGS.join(", ") + ")" : badScope ? "fixScope must be one of " + FIX_SCOPES.join("|") : "spec and planDir are required";
  const env = { stage: "plan", status: "blocked", summary: why.slice(0, 400), actionables: [{ what: why.slice(0, 300), kind: "fix", ref: "workflows/plan-factcheck-fix.js" }], artifacts: { primary: "workflows/plan-factcheck-fix.js" } };
  if (args.stageDir) await safe(runs.run("persist-args", { agent: "wf-host-command", label: "Persist plan arg error",
    task: JSON.stringify({ script: "write-artifact", path: args.stageDir + "/brief.json", json: env }) }));
  return env;
}
const notesLine = args.notes ? "User notes for this stage: " + args.notes : "";
const fixScope = args.fixScope ?? "clear";
// Escalated plan defects go to PROGRESS.md Open Decisions (the user's, per the planner skill), never silently dropped.
const PLAN_SCOPE_TEXT = {
  all: "Fix every REFUTED/PARTIAL claim.",
  clear: "Fix a REFUTED/PARTIAL claim only if its fix is unambiguous (one obviously right correction, no design choice). Record every other one as an Open Decision in PROGRESS.md (claim, why it needs the user) instead of fixing it.",
  trivial: "Fix only trivial REFUTED/PARTIAL claims: typos, stale paths/names/commands, doc drift, one-line mechanical corrections. Record every other one as an Open Decision in PROGRESS.md (claim, why it needs the user) instead of fixing it."
};
const pick = (m) => (m ? { model: m } : {});
// The coordinator's table documents 3 angles as the default; only mode "simple" (or angles: 0) skips them.
const angleCount = args.mode === "simple" ? 0 : (args.angles ?? 3);
const angles = Array.isArray(angleCount) ? angleCount : Array.from({ length: angleCount }, (_, i) => i + 1);
const tier = args.tier ?? "deep";
const simple = args.mode === "simple" || angles.length === 0;

let result = null;
main: {
// 1. Planning angles (skipped in simple mode).
let angleOutputs = [];
if (!simple) {
  const planRuns = await runs.all(
    angles.map((n) => ({
      key: "angle-" + n,
      agent: "wf-planner",
      label: "Plan angle " + n,
      task: [
        "Spec/investigation: " + args.spec,
        "Executor tier: " + tier,
        "Angle " + n + " of " + angles.length + " - propose an independent structural decomposition.",
        "Write your plan-summary and step files under " + args.planDir + "/angle-" + n + "/",
        notesLine
      ].filter(Boolean).join("\n"),
      ...pick(args.plannerModel),
      output: args.planDir + "/angle-" + n + "/plan-summary.md"
    }))
  );
  // Pass paths, never child text: the synthesizer reads the files (r.output is the child's final message).
  angleOutputs = planRuns.map((r, i) => ({ angle: angles[i], ok: r.ok, output: args.planDir + "/angle-" + angles[i] + "/plan-summary.md", runId: r.runId, error: r.error }));
  if (!angleOutputs.some((a) => a.ok)) { result = { state: "FAIL", stage: "angles", errors: angleOutputs.map((a) => a.error) }; break main; }
}

const VALIDATE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["ok", "errors"],
  properties: { ok: { type: "boolean" }, errors: { type: "array", items: { type: "string" } } }
};

// 2. Synthesis loop: up to maxSynthRounds rounds, each a FRESH wf-synthesizer launch (plan mode).
// A typed gate is rejected on `resume` (sa:src/workflows/scripted-workflow.js:661,2492), so re-validation
// after a failed round needs a fresh launch, not `resume`.
const maxSynth = args.maxSynthRounds ?? 3;
const planOutputPath = args.planDir + "/plan.json";
let synth, validation, round = 0;
while (true) {
  const roundTask = round === 0
    ? [
        "Mode: plan.",
        simple ? "Simple mode: single-pass structural plan from the spec directly (no angles)." : "Reconcile these angle plans into one unified structural plan:",
        ...(simple ? [] : angleOutputs.filter((a) => a.ok).map((a) => "Angle " + a.angle + " output: " + a.output)),
        "Spec/investigation: " + args.spec,
        "Executor tier: " + tier,
        "Write the unified plan (step files + *.gates.json sidecars) under " + args.planDir + "/, and a single machine-readable index at " + planOutputPath + " (schema: {steps:[{id,tier,files,gates,coverage,hard_splits_declared}]}), and PROGRESS.md (step-contract ledger sections + ## Steps checklist).",
        notesLine
      ].filter(Boolean).join("\n")
    : [
        "Mode: plan. Fix round " + round + ".",
        "Spec/investigation: " + args.spec,
        ...(simple ? [] : angleOutputs.filter((a) => a.ok).map((a) => "Angle " + a.angle + " output: " + a.output)),
        "Your previous plan output: " + planOutputPath,
        "validate-plan.sh errors to fix:", JSON.stringify(validation?.errors ?? []),
        "Rewrite " + planOutputPath + " (and the affected step files/sidecars) to resolve every listed error.",
        notesLine
      ].filter(Boolean).join("\n");

  synth = await safe(runs.run("synth-" + round, {
    agent: "wf-synthesizer", label: "Synthesize plan round " + round, ...pick(args.synthModel),
    task: roundTask, skill: "planner, step-contract",
    // Only round 0 binds planOutputPath: the runtime rejects two children resolving output to the same file.
    // Fix rounds rewrite it in place (task text); the gate re-validates that path either way.
    ...(round === 0 ? { output: planOutputPath } : {}),
    gate: {
      command: SKILLS + "/scripts/validate-plan.sh '" + planOutputPath + "'",
      output: "json", schema: VALIDATE_SCHEMA, timeoutMs: 120000
    }
  }));
  validation = synth.structuredOutput; // typed gate's parsed stdout lands in result.structuredOutput
  if (validation && validation.ok === true) break;
  round += 1;
  if (round >= maxSynth) {
    { result = { state: "FAIL", stage: "synth", round, validation, error: synth.error }; break main; }
  }
}

// 3. Fact-check the plan.
const CLASSIFY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["refuted", "partial", "disputed", "total"],
  properties: { refuted: { type: "integer" }, partial: { type: "integer" }, disputed: { type: "integer" }, unverifiable: { type: "integer" }, total: { type: "integer" }, error: { type: "string" } }
};
// One report path per round: the runtime rejects two children resolving output to the same file.
let factcheckPath = args.planDir + "/factcheck-0.json";
let fc = await safe(runs.run("factcheck-0", {
  agent: "wf-fact-checker", label: "Fact-check plan", output: factcheckPath, ...pick(args.factcheckModel),
  task: "Fact-check the plan at " + planOutputPath + " against the repo: verify every gate command exists and is runnable, and every cited fact is real. Write a JSON report to your output path: {claims:[{claim, verdict: CONFIRMED|REFUTED|PARTIAL|DISPUTED|UNVERIFIABLE, evidence}]}." + (notesLine ? "\n" + notesLine : ""),
  gate: {
    command: SKILLS + "/scripts/classify-factcheck.sh '" + factcheckPath + "'",
    output: "json", schema: CLASSIFY_SCHEMA, timeoutMs: 60000
  }
}));
let fcClass = fc.structuredOutput; // typed gate's parsed stdout
// Fail closed: an unusable report (classifier error, no claims, failed run) is not a clean fact-check.
const fcUnusable = (run, cls) => !run.ok || !cls || cls.error || !(cls.total > 0);
if (fcUnusable(fc, fcClass)) { result = { state: "FAIL", stage: "factcheck", planPath: planOutputPath, factcheckPath, factcheckClass: fcClass, error: fcClass?.error ?? fc.error }; break main; }

// 4. If refuted+partial > 0: one builtin-worker fix pass, then a second fact-check round.
if (fixScope !== "none" && fcClass && (fcClass.refuted > 0 || fcClass.partial > 0)) {
  // The fix pass rewrites plan.json, step files and sidecars, so it runs under the same validate-plan gate as synthesis.
  const fix = await safe(runs.run("plan-fix-0", {
    agent: "worker", skill: "step-contract", label: "Fix plan per fact-check", ...pick(args.fixModel),
    task: "Fix the plan at " + planOutputPath + " (and affected step files/sidecars/PROGRESS.md) per the REFUTED/PARTIAL claims in the fact-check report at " + factcheckPath + " (counts: " + JSON.stringify(fcClass) + "). " + PLAN_SCOPE_TEXT[fixScope] + " Keep plan.json and every sidecar identical where they overlap." + (notesLine ? "\n" + notesLine : ""),
    gate: {
      command: SKILLS + "/scripts/validate-plan.sh '" + planOutputPath + "'",
      output: "json", schema: VALIDATE_SCHEMA, timeoutMs: 120000
    }
  }));
  if (!fix.ok || !fix.structuredOutput || fix.structuredOutput.ok !== true) {
    { result = { state: "FAIL", stage: "plan-fix", planPath: planOutputPath, factcheckPath, validation: fix.structuredOutput, error: fix.error }; break main; }
  }
  factcheckPath = args.planDir + "/factcheck-1.json";
  fc = await safe(runs.run("factcheck-1", {
    agent: "wf-fact-checker", label: "Re-fact-check plan", output: factcheckPath, ...pick(args.factcheckModel),
    task: "Re-verify the plan at " + planOutputPath + " after fixes. Same report schema.",
    gate: {
      command: SKILLS + "/scripts/classify-factcheck.sh '" + factcheckPath + "'",
      output: "json", schema: CLASSIFY_SCHEMA, timeoutMs: 60000
    }
  }));
  fcClass = fc.structuredOutput;
  if (fcUnusable(fc, fcClass)) { result = { state: "FAIL", stage: "factcheck", planPath: planOutputPath, factcheckPath, factcheckClass: fcClass, error: fcClass?.error ?? fc.error }; break main; }
}

// DISPUTED claims are not defects the worker can fix; they go to the human (step-contract "Pending decisions").
const pendingDecisions = (fcClass && fcClass.disputed > 0) ? [fcClass.disputed + " disputed fact-check claim(s) - see " + factcheckPath] : [];
const clean = fcClass && fcClass.refuted === 0 && fcClass.partial === 0;
// Outside fixScope "all", remaining defects are ones the scope told the worker to leave: the user's call, not a failure.
if (!clean && fixScope !== "all") pendingDecisions.push((fcClass.refuted + fcClass.partial) + " refuted/partial claim(s) left by fixScope " + fixScope + " - see " + factcheckPath + " and PROGRESS.md Open Decisions");

result = {
  state: clean || fixScope !== "all" ? "PASS" : "FAIL",
  planPath: planOutputPath, factcheckPath, factcheckClass: fcClass, pendingDecisions, angles: angleOutputs
};
}

// Tail: persist, return the envelope. Open Decisions written by the planners/synthesizer live in PROGRESS.md.
const stageDir = args.stageDir ?? (args.planDir + "/runs/" + new Date().toISOString().replace(/[:.]/g, "-") + "-plan");
const actionables = [];
for (const p of result.pendingDecisions ?? []) actionables.push({ what: p, kind: "decision", ref: result.factcheckPath });
if (result.state === "PASS") actionables.push({ what: "check PROGRESS.md Open Decisions before executing", kind: "info", ref: args.planDir + "/PROGRESS.md#open-decisions" });
else actionables.push({ what: (result.stage ?? "plan") + ": " + (result.error ?? (result.validation?.errors ?? []).slice(0, 3).join("; ") ?? "see result.json"), kind: "fix", ref: stageDir + "/result.json" });
for (const a of (result.angles ?? []).filter((a) => !a.ok)) actionables.push({ what: "plan angle " + a.angle + " failed: " + a.error, kind: "info", ref: stageDir + "/result.json" });
const fcC = result.factcheckClass;
const summary = result.state === "PASS"
  ? "plan PASS: validate-plan ok; fact-check " + (fcC ? fcC.total + " claims, " + fcC.refuted + " refuted, " + fcC.partial + " partial, " + fcC.disputed + " disputed" : "n/a") + "."
  : "plan FAIL at " + (result.stage ?? "?") + ".";
const status = result.state !== "PASS" ? "failed" : (result.pendingDecisions ?? []).length ? "needs-decision" : "done";
const envelope = { stage: "plan", status, summary, actionables, artifacts: { primary: result.planPath ?? planOutputPath, details: [stageDir + "/result.json", ...(result.factcheckPath ? [result.factcheckPath] : [])] } };
await safe(runs.run("persist", { agent: "wf-host-command", label: "Persist plan result",
  task: JSON.stringify({ script: "write-artifact", files: [{ path: stageDir + "/result.json", json: result }, { path: stageDir + "/brief.json", json: envelope }] }) }));
return envelope;
