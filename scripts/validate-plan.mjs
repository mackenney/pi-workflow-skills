#!/usr/bin/env node
// Typed-gate validator for wf-synthesizer's plan-mode output. Always exits 0; reports
// {ok, errors[]} on stdout. See step-contract SKILL.md for the gate-class/coverage/sidecar schema.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const VALID_CLASSES = new Set(["build", "static", "unit", "integ", "e2e-smoke", "regress"]);
const VALID_RESULTS = new Set(["pass", "fail", "proxy", "deferred", "n/a", undefined]);
const ARTIFACT_HINTS = /dockerfile|docker-compose|packaging|package\.json|pyproject\.toml|lockfile|\.lock$|bundle.?spec|buildx|bake/i;

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
if (!steps) {
  report(false, ["plan.steps must be an array"]);
}
if (steps.length === 0) errors.push("plan.steps is empty");

let firstArtifactStepSeen = false;
for (const step of steps) {
  const label = step.id ?? "(missing id)";
  if (!step.id) errors.push("a step is missing an id");
  if (!Array.isArray(step.gates)) {
    errors.push(`${label}: gates must be an array`);
    continue;
  }
  if (step.gates.length === 0) errors.push(`${label}: gates array is empty (an omitted class is a planning defect)`);
  for (const g of step.gates) {
    if (!g.id) errors.push(`${label}: a gate is missing an id`);
    if (!VALID_CLASSES.has(g.class)) errors.push(`${label}.${g.id ?? "?"}: unknown gate class "${g.class}" (expected one of ${[...VALID_CLASSES].join("|")})`);
    if (!VALID_RESULTS.has(g.result)) errors.push(`${label}.${g.id ?? "?"}: unknown result "${g.result}"`);
    if (g.result === "n/a" && !g.reason) errors.push(`${label}.${g.id ?? "?"}: result n/a requires a "reason" field`);
    if (!g.cmd && g.result !== "n/a") errors.push(`${label}.${g.id ?? "?"}: no cmd and not marked n/a`);
    if (g.proxy === true && !g.real_gate) errors.push(`${label}.${g.id ?? "?"}: proxy:true requires a "real_gate" field naming the real command`);
  }
  if (!Array.isArray(step.coverage)) errors.push(`${label}: coverage must be an array (may be empty only if the step touches no profile/selector/flag/non-default path)`);

  const touchesArtifact = ARTIFACT_HINTS.test(JSON.stringify(step.files ?? [])) || ARTIFACT_HINTS.test(step.description ?? "");
  if (touchesArtifact && !firstArtifactStepSeen) {
    firstArtifactStepSeen = true;
    const hasRealBuildGate = (step.gates ?? []).some(
      (g) => (g.class === "build" || g.class === "e2e-smoke") && g.proxy !== true && g.result !== "n/a"
    );
    if (!hasRealBuildGate) {
      errors.push(`${label}: First-Artifact Rule violation - this is the first step touching a build-artifact definition and has no real (non-proxy) build/e2e-smoke gate`);
    }
  }

  const hardSplits = step.hard_splits_declared ?? [];
  if (!Array.isArray(hardSplits)) errors.push(`${label}: hard_splits_declared must be an array`);
}

// Cross-checks against the files the runtime and the parent actually read. plan.json is only an index:
// the executor runs the sidecar and the parent ledgers PROGRESS.md, so drift there is a plan defect.
const planDir = path.dirname(path.resolve(planPath));
const inPlan = (p, fallback) => (p ? (path.isAbsolute(p) ? p : path.join(planDir, p)) : path.join(planDir, fallback));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; } };
for (const step of steps) {
  if (!step.id || !Array.isArray(step.gates)) continue;
  const classes = new Set(step.gates.map((g) => g.class));
  const missing = [...VALID_CLASSES].filter((c) => !classes.has(c));
  if (missing.length) errors.push(`${step.id}: no verdict for gate class(es) ${missing.join(", ")} (use result "n/a" + reason; an omitted class is a planning defect)`);
  const sidecarPath = inPlan(step.sidecar, step.id + ".gates.json");
  const sidecar = readJson(sidecarPath);
  if (!sidecar) errors.push(`${step.id}: sidecar missing or not valid JSON: ${sidecarPath}`);
  else {
    for (const k of ["gates", "coverage"]) {
      if (!isDeepStrictEqual(sidecar[k] ?? [], step[k] ?? [])) errors.push(`${step.id}: plan.json ${k} differ from sidecar ${sidecarPath} (the sidecar is what runs; make them identical)`);
    }
  }
  const mdPath = inPlan(step.step_file, step.id + ".md");
  if (!fs.existsSync(mdPath)) errors.push(`${step.id}: step file not found: ${mdPath}`);
  else {
    const md = fs.readFileSync(mdPath, "utf8");
    const unlisted = step.gates.filter((g) => g.id && g.cmd && g.result !== "n/a" && !md.includes(g.id)).map((g) => g.id);
    if (unlisted.length) errors.push(`${step.id}: step file does not mention gate(s) ${unlisted.join(", ")} that the sidecar runs`);
  }
}

const progressPath = path.join(planDir, "PROGRESS.md");
if (!fs.existsSync(progressPath)) errors.push(`PROGRESS.md not found next to plan.json: ${progressPath}`);
else {
  // Same section/row grammar terminal-gate.mjs enforces at the end; catching it here costs one fix round, not a blocked plan.
  const SECTION = { deferred: /^##\s+Tech debt\s*\/\s*deferred gates\s*$/i, disabled: /^##\s+Disabled\s*\/\s*softened checks\s*$/i, steps: /^##\s+Steps\s*$/i };
  const STATUS = /^(open|discharged\s+[0-9a-f]{7,40}\b.*|waived by\s+\S.*?\s+\d{4}-\d{2}-\d{2}\s*:\s*\S.*)$/i;
  const seen = {}; const stepLines = []; let cur = null;
  for (const raw of fs.readFileSync(progressPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (/^##\s/.test(line)) { cur = Object.keys(SECTION).find((k) => SECTION[k].test(line)) ?? null; if (cur) seen[cur] = true; continue; }
    if (cur === "steps") { if (/^[-*]\s+\[[ xX]\]/.test(line)) stepLines.push(line); continue; }
    if (!cur || !line.startsWith("|")) continue;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (/^(gate|check)$/i.test(cells[0]) && /^status$/i.test(cells[cells.length - 1])) continue;
    if (!STATUS.test(cells[cells.length - 1])) errors.push(`PROGRESS.md: row without a valid Status (placeholder rows like "| (none) |" are not allowed; leave the table empty): ${line}`);
  }
  for (const k of Object.keys(SECTION)) if (!seen[k]) errors.push(`PROGRESS.md: missing section matching ${SECTION[k]}`);
  if (seen.steps) for (const step of steps) if (step.id && !stepLines.some((l) => l.includes(step.id))) errors.push(`PROGRESS.md: ## Steps has no checklist item for ${step.id}`);
}

report(errors.length === 0, errors);
