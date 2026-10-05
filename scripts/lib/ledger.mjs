// PROGRESS.md ledger parser shared by terminal-gate.mjs, validate-plan.mjs and ledger-apply.mjs.
// Grammar: skills/step-contract/SKILL.md. Fail closed: inside the two debt sections every non-blank line must be
// part of a table (prose or list items there could hide an open item from the gate); inside "## Steps" every list
// item must be a `[ ]`/`[x]` checkbox. Lines inside ``` fences are ignored everywhere.
export const SECTIONS = {
  deferred: /^##\s+Tech debt\s*\/\s*deferred gates\s*$/i,
  disabled: /^##\s+Disabled\s*\/\s*softened checks\s*$/i,
  steps: /^##\s+Steps\s*$/i,
};
export const DISCHARGED = /^discharged\s+[0-9a-f]{7,40}\b/i;
export const WAIVED = /^waived by\s+\S.*?\s+\d{4}-\d{2}-\d{2}\s*:\s*\S/i;
export const OPEN = /^open$/i;
export const isClosed = (status) => DISCHARGED.test(status) || WAIVED.test(status);
export const isValidStatus = (status) => OPEN.test(status) || isClosed(status);

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s*(.*)$/;

export function parseLedger(text) {
  const out = { seen: { deferred: false, disabled: false, steps: false }, rows: { deferred: [], disabled: [] }, steps: [], errors: [] };
  let cur = null;
  let fence = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (/^#{1,2}\s/.test(line)) {
      cur = Object.keys(SECTIONS).find((k) => SECTIONS[k].test(line)) ?? null;
      if (cur) out.seen[cur] = true;
      continue;
    }
    if (!cur || !line || /^<!--.*-->$/.test(line)) continue;
    if (cur === "steps") {
      const m = raw.match(CHECKBOX);
      if (m) out.steps.push({ done: m[1] !== " ", text: m[2].trim(), line: raw });
      else if (LIST_ITEM.test(raw)) out.errors.push(`## Steps: list item is not a [ ]/[x] checkbox: ${line}`);
      continue;
    }
    if (!line.startsWith("|")) { out.errors.push(`${cur === "deferred" ? "Tech debt / deferred gates" : "Disabled/softened checks"}: line outside the table (ledger items must be table rows): ${line}`); continue; }
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (/^(gate|check)$/i.test(cells[0]) && /^status$/i.test(cells[cells.length - 1])) continue;
    out.rows[cur].push({ item: cells[0], status: cells[cells.length - 1], row: line });
  }
  for (const k of Object.keys(SECTIONS)) if (!out.seen[k]) out.errors.push(`missing section: ## ${k === "deferred" ? "Tech debt / deferred gates" : k === "disabled" ? "Disabled/softened checks" : "Steps"}`);
  if (out.seen.steps && out.steps.length === 0) out.errors.push("## Steps has no checklist items");
  return out;
}

// Exact step-id match on a checklist item: the id must appear as a whole token (so step-01 never matches step-010).
export const mentionsId = (text, id) => new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`).test(text);
