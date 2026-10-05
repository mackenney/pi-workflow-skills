#!/usr/bin/env node
// Typed-gate classifier for a wf-fact-checker report: {refuted, partial, disputed} counts.
// Always exits 0. Expected input shape: { claims: [ { verdict: "CONFIRMED"|"REFUTED"|"PARTIAL"|"DISPUTED"|"UNVERIFIABLE", ... } ] }
import fs from "node:fs";

const path = process.argv[2];
if (!path || !fs.existsSync(path)) {
  process.stdout.write(JSON.stringify({ refuted: 0, partial: 0, disputed: 0, error: "factcheck file not found" }) + "\n");
  process.exit(0);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(path, "utf8"));
} catch (e) {
  process.stdout.write(JSON.stringify({ refuted: 0, partial: 0, disputed: 0, error: `not valid JSON: ${e.message}` }) + "\n");
  process.exit(0);
}

const claims = Array.isArray(data.claims) ? data.claims : [];
let refuted = 0, partial = 0, disputed = 0;
for (const c of claims) {
  const v = String(c.verdict ?? "").toUpperCase();
  if (v === "REFUTED") refuted++;
  else if (v === "PARTIAL") partial++;
  else if (v === "DISPUTED") disputed++;
}

process.stdout.write(JSON.stringify({ refuted, partial, disputed, total: claims.length }) + "\n");
