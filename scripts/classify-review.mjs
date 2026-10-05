#!/usr/bin/env node
// Typed-gate classifier for a wf-code-reviewer synthesis report: {blockers, important, refuted} counts.
// Always exits 0. Expected input shape: { blockers: [...], important: [...], refuted: [...] }
import fs from "node:fs";

const path = process.argv[2];
function done(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(0);
}

if (!path || !fs.existsSync(path)) {
  done({ blockers: 0, important: 0, refuted: 0, error: "synthesis file not found" });
}

let data;
try {
  data = JSON.parse(fs.readFileSync(path, "utf8"));
} catch (e) {
  done({ blockers: 0, important: 0, refuted: 0, error: `not valid JSON: ${e.message}` });
}

const asCount = (v) => (Array.isArray(v) ? v.length : 0);
done({ blockers: asCount(data.blockers), important: asCount(data.important), refuted: asCount(data.refuted) });
