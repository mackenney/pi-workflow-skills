#!/usr/bin/env node
// Typed-gate classifier for a wf-fact-checker report: {refuted, partial, disputed, unverifiable, total} counts.
// Always exits 0. Fail closed: a report that is not { claims: [ {verdict}, ... ] } with at least one claim, or any
// verdict outside the vocabulary, yields an `error` field; workflows treat `error` (or total 0) as a failed check.
import fs from "node:fs";

const VERDICTS = new Set(["CONFIRMED", "REFUTED", "PARTIAL", "DISPUTED", "UNVERIFIABLE"]);
const path = process.argv[2];
const done = (obj) => { process.stdout.write(JSON.stringify(obj) + "\n"); process.exit(0); };
const fail = (error) => done({ refuted: 0, partial: 0, disputed: 0, unverifiable: 0, total: 0, error });

if (!path || !fs.existsSync(path)) fail("factcheck file not found");
let data;
try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { fail(`not valid JSON: ${e.message}`); }
if (!data || typeof data !== "object" || !Array.isArray(data.claims)) fail("report must be an object with a claims array");
if (data.claims.length === 0) fail("report has no claims");
const counts = { refuted: 0, partial: 0, disputed: 0, unverifiable: 0 };
const bad = [];
for (const c of data.claims) {
  const v = String(c?.verdict ?? "").trim().toUpperCase();
  if (!VERDICTS.has(v)) { bad.push(String(c?.verdict ?? "(missing)").slice(0, 40)); continue; }
  if (v !== "CONFIRMED") counts[v.toLowerCase()]++;
}
if (bad.length) fail(`verdict(s) outside ${[...VERDICTS].join("|")}: ${bad.slice(0, 5).join(", ")}`);
done({ ...counts, total: data.claims.length });
