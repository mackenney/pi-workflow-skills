#!/usr/bin/env node
// validate-chain.mjs <chain.json> -> {"ok", "status": "ready"|"ask", "uncovered", "errors", "inferred", "ambiguous", "ignored"}
// Guards the coordinator's compile step against silently dropped intent. The coordinator interprets the user's prose
// (fuzzy, an LLM's job) and records every reading in chain.json `mapping`; this script only checks bookkeeping:
//   - every meaningful word of `prose` is covered by some mapping `from` (each `from` must be a verbatim slice of the prose),
//   - every stage is known and its args are ones its workflow accepts (read from the workflow's ALLOWED_ARGS),
//   - a structured `to` ("<stage>.<arg>=<value>") is actually present in that stage's args,
//   - `ambiguous` readings come with questions, and a chain with questions has status "ask" (nothing may launch).
// It cannot tell a wrong reading from a right one; the run line's `~` markers and the questions cover that.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WF_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows");
const out = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };

let chain;
try { chain = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); }
catch (e) { out({ ok: false, status: "error", errors: ["cannot read chain.json: " + e.message] }); }

const STAGE_WORKFLOW = {
  investigate: ["stage.js"], spec: ["stage.js"], "fact-check-doc": ["stage.js"], fix: ["stage.js"], e2e: ["stage.js"], custom: ["stage.js"],
  plan: ["plan-factcheck-fix.js"], execute: ["execute-step.js", "execute-wave.js"], review: ["review-factcheck-fix.js"], "done-check": ["terminal-gate.js"]
};
// Args a stage cannot run without; a compiled stage missing one would fail (or guess) at launch.
const STAGEJS = ["stage", "agent"];
const REQUIRED = { review: ["target", "reviewDir"], plan: ["spec", "planDir"], execute: ["planDir"], "done-check": ["planDir"],
  investigate: STAGEJS, spec: STAGEJS, "fact-check-doc": STAGEJS, fix: STAGEJS, e2e: STAGEJS, custom: STAGEJS };
const allowedFor = {};
for (const [stage, files] of Object.entries(STAGE_WORKFLOW)) {
  const set = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(WF_DIR, f), "utf8");
    const m = /const ALLOWED_ARGS = (\[[^\]]*\])/.exec(src);
    if (!m) out({ ok: false, status: "error", errors: ["workflow " + f + " declares no ALLOWED_ARGS"] });
    for (const a of JSON.parse(m[1])) set.add(a);
  }
  allowedFor[stage] = set;
}

// Words that carry no intent on their own. Negations, quantifiers and scope words (no, not, only, all, skip, each,
// without, trivial, ...) are deliberately absent: they change meaning and must be mapped.
const STOP = new Set(("a an the and or but if so as at by for from in into of on onto to with via per " +
  "is are be been being was were am it its this that these those there here then than " +
  "i me my we us our you your he she they them their " +
  "do does did done doing run runs running use using used let lets please pls just also " +
  "can could should would will shall may might must " +
  "what which who whom when where how why " +
  "up out over about again " +
  "coordinator skill skill:coordinator now").split(/\s+/));

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const prose = norm(chain.prose);
const tokens = [...new Set((prose.match(/[a-z0-9][a-z0-9._\/~:+@#-]*/g) ?? [])
  .map((t) => t.replace(/[.:,;-]+$/, ""))
  .filter((t) => t && !STOP.has(t) && (t.length >= 3 || /^x?\d+$/.test(t))))];

const errors = [];
const mapping = Array.isArray(chain.mapping) ? chain.mapping : (errors.push("mapping must be an array"), []);
const CONF = ["exact", "inferred", "ambiguous", "ignored"];
const fromText = [];
mapping.forEach((m, i) => {
  const from = norm(m?.from);
  if (!from) { errors.push("mapping[" + i + "]: empty from"); return; }
  if (!prose.includes(from)) errors.push("mapping[" + i + "]: from is not a verbatim slice of the prose: " + JSON.stringify(m.from).slice(0, 120));
  if (!CONF.includes(m.confidence)) errors.push("mapping[" + i + "]: confidence must be one of " + CONF.join("|"));
  if (m.confidence === "ignored" && !m.reason) errors.push("mapping[" + i + "]: ignored needs a reason");
  if (m.confidence !== "ignored" && m.confidence !== "ambiguous" && !m.to) errors.push("mapping[" + i + "]: " + m.confidence + " needs a to");
  fromText.push(from);
});
const covered = fromText.join("\n");
const uncovered = tokens.filter((t) => !covered.includes(t));

const stages = Array.isArray(chain.stages) ? chain.stages : (errors.push("stages must be an array"), []);
stages.forEach((s, i) => {
  if (!allowedFor[s?.stage]) { errors.push("stages[" + i + "]: unknown stage " + JSON.stringify(s?.stage) + " (known: " + Object.keys(allowedFor).join(", ") + ")"); return; }
  for (const k of Object.keys(s.args ?? {})) if (!allowedFor[s.stage].has(k)) errors.push("stages[" + i + "] " + s.stage + ": arg " + k + " is not accepted (allowed: " + [...allowedFor[s.stage]].join(", ") + ")");
  for (const k of REQUIRED[s.stage] ?? []) if (s.args?.[k] === undefined || s.args[k] === "") errors.push("stages[" + i + "] " + s.stage + ": required arg " + k + " missing");
});
// A structured `to` must land in the compiled stages, or the reading was recorded but never applied.
mapping.forEach((m, i) => {
  const t = /^([a-z][a-z-]*)\.([A-Za-z]+)=/.exec(String(m?.to ?? ""));
  if (!t || m.confidence === "ignored" || m.confidence === "ambiguous") return;
  const hit = stages.some((s) => s.stage === t[1] && s.args && Object.prototype.hasOwnProperty.call(s.args, t[2]));
  if (!hit) errors.push("mapping[" + i + "]: to " + JSON.stringify(m.to) + " is not applied in any " + t[1] + " stage's args");
});

const ambiguous = mapping.filter((m) => m.confidence === "ambiguous").map((m) => m.from);
const questions = Array.isArray(chain.questions) ? chain.questions : [];
if (ambiguous.length && !questions.length) errors.push("ambiguous readings without questions: " + ambiguous.join(" | "));
questions.forEach((q, i) => { if (!q?.about || !Array.isArray(q.options) || q.options.length < 2) errors.push("questions[" + i + "]: needs about and >= 2 options"); });
const status = questions.length ? "ask" : "ready";
if (chain.status && chain.status !== status) errors.push("chain.status is " + JSON.stringify(chain.status) + " but questions imply " + status);

out({
  ok: errors.length === 0 && uncovered.length === 0, status, uncovered, errors,
  inferred: mapping.filter((m) => m.confidence === "inferred").map((m) => m.from + " -> " + m.to),
  ambiguous,
  ignored: mapping.filter((m) => m.confidence === "ignored").map((m) => m.from + " (" + m.reason + ")")
});
