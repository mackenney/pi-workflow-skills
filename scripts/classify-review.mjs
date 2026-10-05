#!/usr/bin/env node
// Typed-gate classifier for a wf-code-reviewer synthesis report: {blockers, important, refuted} counts.
// Always exits 0. Fail closed: any shape other than
//   { blockers: [...], important: [...], refuted: [...], nits?: [...] }
// yields an `error` field, which the workflow treats as a failed round (an off-schema report is not "zero findings").
import fs from "node:fs";

const path = process.argv[2];
const done = (obj) => { process.stdout.write(JSON.stringify(obj) + "\n"); process.exit(0); };
const fail = (error) => done({ blockers: 0, important: 0, refuted: 0, error });

if (!path || !fs.existsSync(path)) fail("synthesis file not found");
let data;
try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { fail(`not valid JSON: ${e.message}`); }
if (!data || typeof data !== "object" || Array.isArray(data)) fail("synthesis must be a JSON object");
for (const k of ["blockers", "important", "refuted"]) {
  if (!Array.isArray(data[k])) fail(`synthesis.${k} must be an array (got ${data[k] === undefined ? "nothing" : typeof data[k]})`);
}
if (data.nits !== undefined && !Array.isArray(data.nits)) fail("synthesis.nits must be an array when present");
done({ blockers: data.blockers.length, important: data.important.length, refuted: data.refuted.length });
