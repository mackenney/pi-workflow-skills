// args: { target: "diff/PR description, e.g. 'git diff main...HEAD in /abs/repo' or 'PR #67'", reviewDir: "/abs/plans/x/review",
//         baseRef?: "<sha before the change>" (pins the review range across fix rounds), repo?: "/abs/repo", angles?: string[] | number, diversityModel?: "openai/gpt-6-sol",
//         crossExam?: boolean, maxRounds?: 2, stageDir?: "/abs/run/NN-review" (default: reviewDir) }
// Returns the stage envelope; full result in <stageDir>/result.json.
// Sandbox rules: top-level await only, no nested async fns, no fs. Everything file-based goes through children.
// Models are NOT named here except the opt-in diversityModel lane; modelScope rejects any value not
// allow-listed for wf-code-reviewer, so an unlisted model fails the launch rather than running silently.
// Gate commands run through the host shell, so the env override expands there (isolated test installs set it).
const SKILLS = "${PI_WORKFLOW_SKILLS_DIR:-/home/ignacio/pr/pi-workflow-skills}";

const DEFAULT_ANGLES = ["correctness", "security-and-failure-modes", "tests-and-gate-coverage"];
const angles = Array.isArray(args.angles)
  ? args.angles
  : (typeof args.angles === "number" ? DEFAULT_ANGLES.slice(0, args.angles) : DEFAULT_ANGLES);
const maxRounds = args.maxRounds ?? 2;
const repoLine = args.repo ? "Repo: " + args.repo : "";
// Fix rounds add commits, so relative ranges like HEAD~1..HEAD drift onto the fix commit. Pin to baseRef.
const rangeLine = args.baseRef ? "Review range: " + args.baseRef + "..HEAD (cumulative, including any fix commits from prior rounds). This overrides any relative range in Target." : "";

const REVIEW_CLASS_SCHEMA = {
  type: "object", additionalProperties: true, required: ["blockers", "important", "refuted"],
  properties: { blockers: { type: "integer" }, important: { type: "integer" }, refuted: { type: "integer" }, error: { type: "string" } }
};
const FC_CLASS_SCHEMA = {
  type: "object", additionalProperties: true, required: ["refuted", "partial", "disputed"],
  properties: { refuted: { type: "integer" }, partial: { type: "integer" }, disputed: { type: "integer" }, unverifiable: { type: "integer" }, total: { type: "integer" }, error: { type: "string" } }
};

let result = null;
main: {
const rounds = [];
let final = null;
if (!(maxRounds >= 1)) { result = { state: "BLOCKED", reason: "maxRounds must be >= 1", rounds }; break main; }

for (let round = 0; round < maxRounds; round += 1) {
  const dir = args.reviewDir + "/round-" + round;
  const prior = round > 0 ? "Prior round's fixed findings: " + args.reviewDir + "/round-" + (round - 1) + "/synthesis.json - confirm they are resolved; do not re-raise resolved items." : "";

  // 1. Independent angle reviews. Last angle takes the cross-vendor model when requested.
  let angleRuns = await runs.all(
    angles.map((angle, i) => {
      const item = {
        key: "r" + round + "-angle-" + i,
        agent: "wf-code-reviewer",
        label: "Review r" + round + " " + angle,
        task: ["mode: \"angle\"", "Angle: " + angle, "Target: " + args.target, repoLine, rangeLine, prior,
               "Write your findings (markdown, every finding with file:line + evidence + severity P0/P1/P2) to your output path."].filter(Boolean).join("\n"),
        output: dir + "/angle-" + i + ".md"
      };
      if (args.diversityModel && i === angles.length - 1) item.model = args.diversityModel;
      return item;
    })
  );
  // A missing angle is a missing perspective: retry each failed angle once (own output path, the runtime forbids
  // reusing one), and fail the round if any is still missing rather than synthesising the survivors into a PASS.
  const angleOut = angles.map((_, i) => dir + "/angle-" + i + ".md");
  const failedIdx = angleRuns.map((r, i) => (r.ok ? -1 : i)).filter((i) => i >= 0);
  if (failedIdx.length) {
    const retries = await runs.all(failedIdx.map((i) => ({
      key: "r" + round + "-angle-" + i + "-retry", agent: "wf-code-reviewer", label: "Review r" + round + " " + angles[i] + " (retry)",
      task: ["mode: \"angle\"", "Angle: " + angles[i], "Target: " + args.target, repoLine, rangeLine, prior,
             "Write your findings (markdown, every finding with file:line + evidence + severity P0/P1/P2) to your output path."].filter(Boolean).join("\n"),
      output: dir + "/angle-" + i + "-retry.md",
      ...(args.diversityModel && i === angles.length - 1 ? { model: args.diversityModel } : {})
    })));
    // Results may be frozen; rebuild instead of mutating.
    const retryByIdx = {};
    retries.forEach((rr, j) => { retryByIdx[failedIdx[j]] = rr; });
    angleRuns = angleRuns.map((r0, i) => (retryByIdx[i] && retryByIdx[i].ok ? retryByIdx[i] : r0));
    failedIdx.forEach((i) => { if (retryByIdx[i] && retryByIdx[i].ok) angleOut[i] = dir + "/angle-" + i + "-retry.md"; });
  }
  const failedAngles = angleRuns.map((r, i) => (r.ok ? null : { angle: angles[i], error: r.error })).filter(Boolean);
  if (failedAngles.length) {
    { result = { state: "FAIL", stage: "angles", round, failedAngles, rounds }; break main; }
  }
  const anglePaths = angleOut;

  // 2. Optional cross-exam: each angle reviewer (resumed, so it keeps its own context) reads the others.
  // `resume` does not re-capture per-launch fields from the retained contract (confirmed for outputSchema in
  // execute-step.js), so the output path is passed again explicitly. It must differ from the angle's own
  // path: the runtime rejects two children of one workflow resolving output to the same file.
  const xexamPaths = [];
  if (args.crossExam) {
    const xruns = await runs.all(
      angleRuns.map((r, i) => (r.ok ? {
        key: "r" + round + "-xexam-" + i,
        resume: r.runId,
        label: "Cross-exam r" + round + " " + angles[i],
        task: "Cross-examine the other reviewers' findings: " + anglePaths.filter((p) => p !== angleOut[i]).join(", ") +
              ". For each finding: AGREE / DISPUTE (with evidence) / ADD-CONTEXT. Write only your cross-exam section to your output path.",
        output: dir + "/angle-" + i + "-xexam.md"
      } : null)).filter(Boolean)
    );
    const xIdx = angleRuns.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0); // runs.all keeps order
    xruns.forEach((x, j) => { if (x.ok) xexamPaths.push(dir + "/angle-" + xIdx[j] + "-xexam.md"); });
  }

  // 3. Synthesis under the classify-review typed gate. Fresh launch (typed gates are rejected on resume).
  const synthPath = dir + "/synthesis.json";
  const synth = await runs.run("r" + round + "-synth", {
    agent: "wf-code-reviewer", label: "Review synthesis r" + round, output: synthPath,
    task: ["mode: \"synthesis\"", "Target: " + args.target, repoLine, rangeLine,
           "Angle findings files: " + anglePaths.join(", "),
           xexamPaths.length ? "Cross-exam files: " + xexamPaths.join(", ") : "",
           "Write JSON to your output path, exactly: {\"blockers\":[{\"title\",\"file\",\"line\",\"evidence\",\"fix\"}],\"important\":[...same shape],\"refuted\":[{\"title\",\"reason\"}]}. blockers = P0 (must fix before merge); important = P1 only; P2/nits/hygiene go in an optional \"nits\" array, never in important (the loop stops when blockers and important are both empty); refuted = angle findings you rejected with evidence."].filter(Boolean).join("\n"),
    gate: {
      command: SKILLS + "/scripts/classify-review.sh " + synthPath,
      output: "json", schema: REVIEW_CLASS_SCHEMA, timeoutMs: 60000
    }
  });
  const reviewClass = synth.structuredOutput;
  if (!synth.ok || !reviewClass || reviewClass.error) {
    { result = { state: "FAIL", stage: "synth", round, reviewClass, error: synth.error, rounds }; break main; }
  }

  // Early stop before spending a fact-check: a clean synthesis has no findings to verify.
  if (reviewClass.blockers === 0 && reviewClass.important === 0) {
    rounds.push({ round, synthPath, reviewClass, diversityModel: args.diversityModel ?? null });
    final = { state: "PASS", round };
    break;
  }

  // 4. Fact-check the synthesis so the fix pass only acts on verified findings.
  const fcPath = dir + "/factcheck.json";
  const fc = await runs.run("r" + round + "-factcheck", {
    agent: "wf-fact-checker", label: "Fact-check review r" + round, output: fcPath,
    task: "Fact-check the review synthesis at " + synthPath + " (target: " + args.target + (args.repo ? ", repo " + args.repo : "") +
          "). One claim per blocker/important finding: is the defect real at the cited file:line? Write {claims:[{claim, verdict, evidence}]} to your output path.",
    gate: {
      command: SKILLS + "/scripts/classify-factcheck.sh " + fcPath,
      output: "json", schema: FC_CLASS_SCHEMA, timeoutMs: 60000
    }
  });
  const fcClass = fc.structuredOutput;

  const record = { round, synthPath, fcPath, reviewClass, fcClass, diversityModel: args.diversityModel ?? null };
  rounds.push(record);
  if (!fc.ok || !fcClass || fcClass.error || !(fcClass.total > 0)) {
    final = { state: "FAIL", stage: "factcheck", round, error: fcClass?.error ?? fc.error ?? "empty fact-check report" };
    break;
  }
  if (round === maxRounds - 1) {
    final = { state: "FAIL", round, reason: "findings remain after maxRounds" };
    break;
  }

  // 5. Fix pass: builtin worker applies only findings the fact-check did not refute.
  const fix = await runs.run("r" + round + "-fix", {
    agent: "worker", skill: "step-contract", label: "Fix review findings r" + round,
    task: ["Target: " + args.target, repoLine, rangeLine,
           "Apply fixes for every blocker and important finding in " + synthPath + ".",
           "Skip any finding the fact-check at " + fcPath + " marks REFUTED; for DISPUTED/UNVERIFIABLE ones, fix only if you can confirm the defect yourself.",
           "Re-run the repo's relevant tests/lint after fixing and commit with an imperative message. Report what you fixed and skipped."].filter(Boolean).join("\n")
  });
  record.fix = { ok: fix.ok, runId: fix.runId, error: fix.error };
  if (!fix.ok) {
    final = { state: "FAIL", round, stage: "fix", error: fix.error };
    break;
  }
}

const last = rounds[rounds.length - 1];
const pendingDecisions = last && last.fcClass && last.fcClass.disputed > 0
  ? ["disputed review claims - see " + last.fcPath] : [];

result = { ...final, rounds, pendingDecisions };
}

// Tail: persist, return the envelope. The surviving findings are in the last round's synthesis/fact-check files.
const stageDir = args.stageDir ?? args.reviewDir;
const lastR = result.rounds?.[result.rounds.length - 1];
const actionables = [];
for (const p of result.pendingDecisions ?? []) actionables.push({ what: p, kind: "decision", ref: lastR?.fcPath ?? stageDir });
if (result.state !== "PASS") actionables.push({ what: (result.stage ?? "review") + ": " + (result.reason ?? result.error ?? (result.failedAngles ? result.failedAngles.length + " angle(s) failed" : "see result.json")), kind: "fix", ref: lastR?.synthPath ?? stageDir + "/result.json" });
const rc = lastR?.reviewClass;
const summary = "review " + result.state + " after " + (result.rounds?.length ?? 0) + " round(s)" + (rc ? "; last synthesis: " + rc.blockers + " blockers, " + rc.important + " important" : "") + ".";
const status = result.state === "PASS" ? ((result.pendingDecisions ?? []).length ? "needs-decision" : "done") : result.state === "BLOCKED" ? "blocked" : "failed";
const envelope = { stage: "review", status, summary, actionables, artifacts: { primary: lastR?.synthPath ?? stageDir + "/result.json", details: [stageDir + "/result.json"] } };
await runs.run("persist", { agent: "wf-host-command", label: "Persist review result",
  task: JSON.stringify({ script: "write-artifact", files: [{ path: stageDir + "/result.json", json: result }, { path: stageDir + "/brief.json", json: envelope }] }) });
return envelope;
