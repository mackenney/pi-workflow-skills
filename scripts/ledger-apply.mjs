#!/usr/bin/env node
// Applies typed step ledgers to PROGRESS.md (grammar: skills/step-contract/SKILL.md). No model writes ledger rows.
// stdin, one of:
//   {"planDir": "/abs", "ledgerFile"?: "PROGRESS.md", "ledgers": [ <ledger>, ... ]}
//   {"planDir": "/abs", "fromResult": "/abs/<stage>/result.json", "steps"?: ["step-01-x", ...]}   (execute-wave lanes, after merge + re-gate)
// <ledger> = {step, commit, tick?: true, deferred?: [{gate, owed_by, reason, class?}], proxies_used?: [{gate, proxy_cmd, real_gate}],
//             decisions_taken?: [..], pending_decisions?: [..]}
// Idempotent: re-applying the same ledger adds nothing. stdout: {ok, applied: {...}, errors: [...]}. Always exits 0.
import fs from "node:fs";
import path from "node:path";
import { mentionsId } from "./lib/ledger.mjs";

const done = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
let task;
try { task = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { done({ ok: false, errors: ["bad task JSON: " + e.message] }); }
if (!task.planDir) done({ ok: false, errors: ["missing planDir"] });
const file = path.join(task.planDir, task.ledgerFile || "PROGRESS.md");
if (!fs.existsSync(file)) done({ ok: false, errors: ["ledger not found: " + file] });

let ledgers = task.ledgers;
if (task.fromResult) {
  let result;
  try { result = JSON.parse(fs.readFileSync(task.fromResult, "utf8")); } catch (e) { done({ ok: false, errors: ["cannot read " + task.fromResult + ": " + e.message] }); }
  const lanes = (result.board ?? []).filter((l) => l.state === "PASS" && l.ledger);
  ledgers = lanes.map((l) => l.ledger).filter((l) => !task.steps || task.steps.includes(l.step));
  if (task.steps) for (const s of task.steps) if (!ledgers.some((l) => l.step === s)) done({ ok: false, errors: [`no PASS lane ledger for ${s} in ${task.fromResult}`] });
}
if (!Array.isArray(ledgers) || ledgers.length === 0) done({ ok: false, errors: ["no ledgers to apply"] });

const cell = (v) => String(v ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim() || "-";
const short = (sha) => (sha ? String(sha).slice(0, 7) : "?");
let lines = fs.readFileSync(file, "utf8").split("\n");
const errors = [];
const applied = { decisions: 0, pending: 0, deferredRows: 0, ticked: [] };

const headingIdx = (re) => lines.findIndex((l) => re.test(l.trim()));
const sectionEnd = (start) => { let i = start + 1; while (i < lines.length && !/^#{1,2}\s/.test(lines[i].trim())) i += 1; return i; };
function ensureSection(title, re, before) {
  let i = headingIdx(re);
  if (i !== -1) return i;
  const b = headingIdx(before);
  const at = b === -1 ? lines.length : b;
  lines.splice(at, 0, "## " + title, "", "");
  return at;
}
function appendBullet(re, title, text) {
  const start = ensureSection(title, re, /^##\s+Tech debt\s*\/\s*deferred gates\s*$/i);
  const end = sectionEnd(start);
  const bullet = "- " + text;
  if (lines.slice(start, end).some((l) => l.trim() === bullet)) return false;
  let at = end; while (at > start + 1 && lines[at - 1].trim() === "") at -= 1;
  lines.splice(at, 0, bullet);
  return true;
}
function appendRow(re, row, gate, step) {
  const start = headingIdx(re);
  if (start === -1) { errors.push("missing section for row: " + row); return false; }
  const end = sectionEnd(start);
  const body = lines.slice(start, end);
  if (body.some((l) => l.trim().startsWith("|") && mentionsId(l, gate) && l.includes(step))) return false;
  let at = start + 1; let lastTable = -1;
  for (let i = start + 1; i < end; i += 1) if (lines[i].trim().startsWith("|")) lastTable = i;
  if (lastTable === -1) { errors.push("no table in section for row: " + row); return false; }
  at = lastTable + 1;
  lines.splice(at, 0, row);
  return true;
}

for (const L of ledgers) {
  if (!L.step) { errors.push("ledger without step"); continue; }
  const tag = `${L.step} @${short(L.commit)}`;
  for (const d of L.decisions_taken ?? []) if (appendBullet(/^##\s+Decisions taken\s*$/i, "Decisions taken", `${tag}: ${String(d).replace(/\r?\n/g, " ")}`)) applied.decisions += 1;
  for (const p of L.pending_decisions ?? []) if (appendBullet(/^##\s+Pending decisions \(human\)\s*$/i, "Pending decisions (human)", `${L.step}: ${String(p).replace(/\r?\n/g, " ")}`)) applied.pending += 1;
  const DEBT = /^##\s+Tech debt\s*\/\s*deferred gates\s*$/i;
  for (const d of L.deferred ?? []) {
    const row = `| ${cell(d.gate)} | ${cell(d.class)} | ${cell(d.owed_by)} | ${cell(d.reason)} (from ${L.step}) | open |`;
    if (appendRow(DEBT, row, d.gate, L.step)) applied.deferredRows += 1;
  }
  for (const p of L.proxies_used ?? []) {
    // A proxy is owed its real gate: same open-row rule as a deferred gate (step-contract Proxy Rule).
    const row = `| ${cell(p.gate)} | proxy | ${cell(p.owed_by ?? "-")} | proxy \`${cell(p.proxy_cmd)}\` ran instead of \`${cell(p.real_gate)}\` (from ${L.step}) | open |`;
    if (appendRow(DEBT, row, p.gate, L.step)) applied.deferredRows += 1;
  }
  if (L.tick !== false) {
    const s = headingIdx(/^##\s+Steps\s*$/i);
    const e = s === -1 ? -1 : sectionEnd(s);
    let hit = -1;
    for (let i = s + 1; s !== -1 && i < e; i += 1) if (/^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]/.test(lines[i]) && mentionsId(lines[i], L.step)) { hit = i; break; }
    if (hit === -1) errors.push(`## Steps has no checklist item for ${L.step}`);
    else {
      let l = lines[hit].replace(/\[ \]/, "[x]");
      if (L.commit && !l.includes(short(L.commit))) l = l.replace(/\s*$/, ` — ${short(L.commit)}`);
      if (l !== lines[hit]) { lines[hit] = l; applied.ticked.push(L.step); }
    }
  }
}

fs.writeFileSync(file, lines.join("\n"));
done({ ok: errors.length === 0, ledger: file, applied, errors });
