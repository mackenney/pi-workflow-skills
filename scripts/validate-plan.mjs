#!/usr/bin/env node
// Typed-gate validator for wf-synthesizer's plan-mode output. Always exits 0; reports
// {ok, errors[]} on stdout. Schema: skills/step-contract/SKILL.md. Checks are mechanical only;
// whether a coverage matrix is adequate is judged by the fact-checker and reviewer, not here.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseLedger, isValidStatus, mentionsId } from "./lib/ledger.mjs";

const VALID_CLASSES = new Set(["build", "static", "unit", "integ", "e2e-smoke", "regress"]);
const VALID_RESULTS = new Set(["n/a", "deferred", undefined]);
// Executor tiers that have a worker lane in execute-step.js / execute-wave.js. `frontier` is a planning/synthesis
// tier only until a frontier worker exists; a step sized for it must be split or planned as deep.
const EXECUTOR_TIERS = new Set(["fast", "standard", "deep"]);
const ARTIFACT_HINTS = /(^|\/)(dockerfile|containerfile)|docker-compose|compose\.ya?ml|packaging|package\.json|pyproject\.toml|setup\.(py|cfg)|requirements[^/]*\.txt|go\.(mod|sum)|cargo\.toml|lockfile|\.lock$|bundle.?spec|buildx|bake/i;

function report(ok, errors) {
  process.stdout.write(JSON.stringify({ ok, errors }) + "\n");
  process.exit(0);
}

const planPath = process.argv[2];
if (!planPath) report(false, ["usage: validate-plan.mjs <plan.json>"]);
if (!fs.existsSync(planPath)) report(false, [`plan file not found: ${planPath}`]);

let plan;
try {
  plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
} catch (e) {
  report(false, [`plan file is not valid JSON: ${e.message}`]);
}

const errors = [];
const steps = Array.isArray(plan.steps) ? plan.steps : null;
if (!steps) report(false, ["plan.steps must be an array"]);
if (steps.length === 0) errors.push("plan.steps is empty");

const planDir = path.dirname(path.resolve(planPath));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; } };
const runnable = (g) => g && g.cmd && g.result !== "n/a" && g.result !== "deferred";

const stepIds = new Set();
let firstArtifactStepSeen = false;
const deferredOrProxy = []; // {step, gate} that need an open ledger row

for (const step of steps) {
  const label = step.id ?? "(missing id)";
  if (!step.id) errors.push("a step is missing an id");
  else if (stepIds.has(step.id)) errors.push(`duplicate step id ${step.id}`);
  else stepIds.add(step.id);
  if (!EXECUTOR_TIERS.has(step.tier)) errors.push(`${label}: tier "${step.tier}" has no executor lane (expected ${[...EXECUTOR_TIERS].join("|")}; plan frontier-sized work as deep or split it)`);
  if (!Array.isArray(step.files) || step.files.length === 0) errors.push(`${label}: files must be a non-empty array of the paths the step touches`);
  if (!Array.isArray(step.gates)) { errors.push(`${label}: gates must be an array`); continue; }

  const gateIds = new Set();
  for (const g of step.gates) {
    const gl = `${label}.${g?.id ?? "?"}`;
    if (!g?.id) errors.push(`${label}: a gate is missing an id`);
    else if (gateIds.has(g.id)) errors.push(`${label}: duplicate gate id ${g.id}`);
    else gateIds.add(g.id);
    if (!VALID_CLASSES.has(g?.class)) errors.push(`${gl}: unknown gate class "${g?.class}" (expected one of ${[...VALID_CLASSES].join("|")})`);
    if (!VALID_RESULTS.has(g?.result)) errors.push(`${gl}: unknown result "${g?.result}" (a sidecar may only pre-set "n/a" or "deferred")`);
    if (g?.result === "n/a" && !g.reason) errors.push(`${gl}: result n/a requires a "reason" field`);
    if (g?.result === "deferred" && !g.owed_by) errors.push(`${gl}: result deferred requires "owed_by" (the step that runs the real gate)`);
    if (!g?.cmd && g?.result !== "n/a" && g?.result !== "deferred") errors.push(`${gl}: no cmd and not marked n/a or deferred`);
    if (g?.proxy === true && !g.real_gate) errors.push(`${gl}: proxy:true requires a "real_gate" field naming the real command`);
    if (g?.result === "deferred" || g?.proxy === true) deferredOrProxy.push({ step: label, gate: g.id });
  }
  const classes = new Set(step.gates.map((g) => g?.class));
  const missing = [...VALID_CLASSES].filter((c) => !classes.has(c));
  if (missing.length) errors.push(`${label}: no verdict for gate class(es) ${missing.join(", ")} (use result "n/a" + reason; an omitted class is a planning defect)`);
  if (!step.gates.some(runnable)) errors.push(`${label}: no runnable gate (every gate is n/a or deferred, so nothing would be verified)`);

  if (!Array.isArray(step.coverage)) errors.push(`${label}: coverage must be an array`);
  else for (const row of step.coverage) {
    const target = step.gates.find((g) => g?.id === row?.gate);
    if (!row?.row || !row?.gate) errors.push(`${label}: coverage rows need "row" and "gate"`);
    else if (!runnable(target)) errors.push(`${label}: coverage row "${row.row}" names gate ${row.gate}, which is not a runnable gate of this step`);
  }

  const touchesArtifact = (Array.isArray(step.files) ? step.files : []).some((p) => ARTIFACT_HINTS.test(String(p))) || ARTIFACT_HINTS.test(step.description ?? "");
  if (touchesArtifact && !firstArtifactStepSeen) {
    firstArtifactStepSeen = true;
    const hasRealBuildGate = step.gates.some((g) => (g?.class === "build" || g?.class === "e2e-smoke") && g.proxy !== true && runnable(g));
    if (!hasRealBuildGate) errors.push(`${label}: First-Artifact Rule violation - this is the first step touching a build-artifact definition and has no real (non-proxy) build/e2e-smoke gate`);
  }

  const hardSplits = step.hard_splits_declared ?? [];
  if (!Array.isArray(hardSplits)) errors.push(`${label}: hard_splits_declared must be an array`);

  // Cross-checks against the files the runtime and the parent actually read. plan.json is only an index:
  // the executor runs the sidecar that step-loader derives from the step file name, and the ledger is PROGRESS.md.
  if (!step.id) continue;
  const mdPath = step.step_file ? path.resolve(planDir, step.step_file) : path.join(planDir, step.id + ".md");
  const derivedSidecar = mdPath.replace(/\.md$/, ".gates.json");
  if (step.sidecar && path.resolve(planDir, step.sidecar) !== derivedSidecar) errors.push(`${label}: sidecar ${step.sidecar} is not the file the executor loads (${derivedSidecar}); name it after the step file`);
  const sidecar = readJson(derivedSidecar);
  if (!sidecar) errors.push(`${label}: sidecar missing or not valid JSON: ${derivedSidecar}`);
  else {
    for (const k of ["gates", "coverage"]) {
      if (!isDeepStrictEqual(sidecar[k] ?? [], step[k] ?? [])) errors.push(`${label}: plan.json ${k} differ from sidecar ${derivedSidecar} (the sidecar is what runs; make them identical)`);
    }
    if (sidecar.step !== step.id) errors.push(`${label}: sidecar "step" is ${JSON.stringify(sidecar.step)}, expected ${JSON.stringify(step.id)}`);
    if (sidecar.tier !== step.tier) errors.push(`${label}: sidecar tier ${JSON.stringify(sidecar.tier)} differs from plan.json ${JSON.stringify(step.tier)}`);
  }
  if (!fs.existsSync(mdPath)) errors.push(`${label}: step file not found: ${mdPath}`);
  else {
    const md = fs.readFileSync(mdPath, "utf8");
    const unlisted = step.gates.filter((g) => runnable(g) && g.id && !mentionsId(md, g.id)).map((g) => g.id);
    if (unlisted.length) errors.push(`${label}: step file does not mention gate(s) ${unlisted.join(", ")} that the sidecar runs`);
  }
}

const progressPath = path.join(planDir, "PROGRESS.md");
if (!fs.existsSync(progressPath)) errors.push(`PROGRESS.md not found next to plan.json: ${progressPath}`);
else {
  // Same parser terminal-gate.mjs uses at the end; catching problems here costs one fix round, not a blocked plan.
  const L = parseLedger(fs.readFileSync(progressPath, "utf8"));
  for (const e of L.errors) errors.push(`PROGRESS.md: ${e}`);
  for (const k of ["deferred", "disabled"]) for (const r of L.rows[k]) {
    if (!isValidStatus(r.status)) errors.push(`PROGRESS.md: row without a valid Status (placeholder rows like "| (none) |" are not allowed; leave the table empty): ${r.row}`);
  }
  for (const id of stepIds) if (L.seen.steps && !L.steps.some((s) => mentionsId(s.text, id))) errors.push(`PROGRESS.md: ## Steps has no checklist item for ${id}`);
  for (const d of deferredOrProxy) {
    if (!L.rows.deferred.some((r) => mentionsId(r.row, d.gate) && /^open$/i.test(r.status))) errors.push(`PROGRESS.md: deferred/proxy gate ${d.step}.${d.gate} needs an open row in "Tech debt / deferred gates"`);
  }
}

report(errors.length === 0, errors);
