// Generic single-agent stage: one child, strict envelope out. The coordinator never carries the schema itself, so it
// cannot drop it (observed 2026-10-05: after one rejected structured_output the parent launched later stages without it).
// args: { stage: "spec", agent: "wf-synthesizer", task: "...", stageDir: "/abs/run/NN-spec",
//         skill?: "specifier", detailFile?: "spec.md" | "/abs/path", model?: "<provider/id>", helpers?: [ {agent, task, file, skill?}, ... ] }
// helpers: optional parallel read-only children (e.g. investigation scouts) that write markdown to <stageDir>/<file>;
//          no schema on them (small models reject it); the main child receives their paths.
// Returns the envelope; <stageDir>/brief.json holds it. A child that fails or returns an invalid envelope is retried once
// on `delegate`; if that also fails, this script writes a `blocked` envelope itself.
const ENVELOPE = {
  type: "object", additionalProperties: false,
  required: ["stage", "status", "summary", "actionables", "artifacts"],
  properties: {
    stage: { type: "string" },
    status: { enum: ["done", "needs-decision", "failed", "blocked"] },
    summary: { type: "string", maxLength: 400 },
    actionables: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["what", "kind", "ref"],
      properties: { what: { type: "string", maxLength: 300 }, kind: { enum: ["decision", "fix", "info"] }, ref: { type: "string" } } } },
    artifacts: { type: "object", additionalProperties: false, required: ["primary"],
      properties: { primary: { type: "string" }, details: { type: "array", items: { type: "string" } } } }
  }
};
const brief = args.stageDir + "/brief.json";
const detail = !args.detailFile ? args.stageDir + "/" + args.stage + ".md" : args.detailFile.startsWith("/") ? args.detailFile : args.stageDir + "/" + args.detailFile;

let helperPaths = [];
if (Array.isArray(args.helpers) && args.helpers.length) {
  const hs = await runs.all(args.helpers.map((h, i) => ({
    key: "helper-" + i, agent: h.agent ?? "scout", label: args.stage + " helper " + (i + 1),
    ...(h.skill ? { skill: h.skill } : {}),
    // The runtime saves the child's final reply to `output`; helpers do not have to write files (scouts often don't).
    task: h.task + "\nYour final reply is saved verbatim as your findings file: make it the complete markdown findings.",
    output: args.stageDir + "/" + h.file
  })));
  helperPaths = args.helpers.map((h, i) => (hs[i].ok ? args.stageDir + "/" + h.file : null)).filter(Boolean);
}

const contract = [
  "Write your detailed output to " + detail + " (all detail goes there).",
  "Then return the stage envelope through structured_output: stage \"" + args.stage + "\"; status done | needs-decision (the user must decide something) | failed | blocked;",
  "summary at most 3 lines; actionables = only what the parent must act on (kind decision | fix | info, ref = file#anchor); artifacts.primary = " + detail + "."
].join("\n");
const task = [args.task, helperPaths.length ? "Helper findings to merge: " + helperPaths.join(", ") : "", contract].filter(Boolean).join("\n\n");

// Valid = a schema-conforming envelope AND the detail file the task demanded actually exists.
// (the sandbox forbids nested async helpers, so the check is inlined after each run)
const CHECK_TASK = JSON.stringify({ script: "write-artifact", check: [detail] });
const missingFrom = (chk) => { try { return (JSON.parse(chk.output).missing ?? []).length > 0; } catch (e) { return true; } };
const schemaOk = (r) => r && r.ok && r.structuredOutput && ENVELOPE.properties.status.enum.includes(r.structuredOutput.status);
let run = await runs.run("main", {
  agent: args.agent, label: args.stage, task, output: brief, outputSchema: ENVELOPE,
  ...(args.skill ? { skill: args.skill } : {}), ...(args.model ? { model: args.model } : {})
});
const chkMain = await runs.run("check-main", { agent: "wf-host-command", label: "Check " + args.stage + " detail file", task: CHECK_TASK });
let ok = schemaOk(run) && !missingFrom(chkMain);
let fallback = null;
if (!ok && args.agent !== "delegate") {
  fallback = { agent: args.agent, error: run.error ?? (schemaOk(run) ? "detail file " + detail + " not written" : "no valid envelope") };
  // Own output path: the runtime rejects two children resolving output to the same file.
  run = await runs.run("main-retry", {
    agent: "delegate", label: args.stage + " (retry on delegate)", task, output: args.stageDir + "/brief.retry.json", outputSchema: ENVELOPE,
    ...(args.skill ? { skill: args.skill } : {})
  });
  const chkRetry = await runs.run("check-retry", { agent: "wf-host-command", label: "Check " + args.stage + " detail file (retry)", task: CHECK_TASK });
  ok = schemaOk(run) && !missingFrom(chkRetry);
}
let envelope = ok ? { ...run.structuredOutput, artifacts: { ...run.structuredOutput.artifacts, primary: detail } } : {
  stage: args.stage, status: "blocked",
  summary: "stage child returned no valid envelope or no detail file" + (fallback ? " (also after a retry on delegate)" : "") + ".",
  actionables: [{ what: String((schemaOk(run) ? "detail file not written: " + detail : run?.error) ?? fallback?.error ?? "unknown error").slice(0, 300), kind: "fix", ref: args.stageDir }],
  artifacts: { primary: detail, details: helperPaths }
};
if (fallback && ok) envelope = { ...envelope, actionables: [{ what: args.agent + " failed (" + String(fallback.error).slice(0, 120) + "); delegate completed the stage", kind: "info", ref: args.stageDir }, ...envelope.actionables].slice(0, 12) };
if (helperPaths.length) envelope = { ...envelope, artifacts: { ...envelope.artifacts, details: [...new Set([...(envelope.artifacts.details ?? []), ...helperPaths])] } };
// brief.json is always the final envelope (retry or synthesized), whatever the child wrote.
await runs.run("persist", { agent: "wf-host-command", label: "Persist " + args.stage + " brief",
  task: JSON.stringify({ script: "write-artifact", path: brief, json: envelope }) });
return envelope;
