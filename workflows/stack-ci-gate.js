// args: { prs: [101, 102, 103] (downstream order: base of the stack first), repo?: "/abs/repo", waitSeconds?: 1800 }
// R8 stack-level gate: after any rebase of a stack, every PR's CI must be green. Returns at the first
// non-green PR so the parent fixes bottom-up. CI comes from `gh pr checks --json` via wf-host-command.
if (!Array.isArray(args.prs) || args.prs.length === 0) return { ok: false, error: "args.prs must be a non-empty array" };
const results = [];
for (const pr of args.prs) {
  const run = await runs.run("ci-" + pr, {
    agent: "wf-host-command", label: "CI for PR " + pr, timeoutMs: 2100000,
    task: JSON.stringify({ script: "ci-gate", pr, repo: args.repo, waitSeconds: args.waitSeconds ?? 1800 })
  });
  let ci;
  try { ci = JSON.parse(run.output); } catch (e) { ci = { state: "unknown", error: run.error ?? "unparseable ci-gate output" }; }
  results.push({ pr, ...ci });
  if (ci.state !== "green") return { ok: false, firstNonGreen: pr, results };
}
return { ok: true, results };
