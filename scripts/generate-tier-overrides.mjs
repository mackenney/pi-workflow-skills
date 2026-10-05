#!/usr/bin/env node
// Binds package-agent `tier:` frontmatter + agents/builtin-tiers.json, via the
// ~/.pi/agent/AGENTS.md "Model Tiers" table, into ~/.pi/agent/settings.json's
// subagents.agentOverrides. Dry-run by default. See ORCHESTRATION-ENCODING.md §3.2.1.
//
// Node >= 20, ESM, zero dependencies. The only file this script writes outside the
// package is ~/.pi/agent/settings.json (plus its own backup + state files beside it).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const HOME_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_TIERS = new Set(["frontier", "deep", "standard", "fast"]);

function parseArgs(argv) {
  const opts = {
    mode: "dry-run",
    agentsMd: path.join(HOME_AGENT_DIR, "AGENTS.md"),
    settings: path.join(HOME_AGENT_DIR, "settings.json"),
    packageDir: PKG_ROOT,
    writePatchPath: null,
    prune: [],
    overrideTier: [],
    clearOverride: [],
    force: false,
    accept: [],
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply") opts.mode = "apply";
    else if (a === "--check") opts.mode = "dry-run";
    else if (a === "--write-patch") {
      opts.mode = opts.mode === "apply" ? opts.mode : "write-patch";
      if (args[i + 1] && !args[i + 1].startsWith("--")) opts.writePatchPath = args[++i];
    } else if (a === "--agents-md") opts.agentsMd = path.resolve(args[++i]);
    else if (a === "--settings") opts.settings = path.resolve(args[++i]);
    else if (a === "--package-dir") opts.packageDir = path.resolve(args[++i]);
    else if (a === "--prune") opts.prune.push(args[++i]);
    else if (a === "--override-tier") opts.overrideTier.push(args[++i]);
    else if (a === "--clear-override") opts.clearOverride.push(args[++i]);
    else if (a === "--force") opts.force = true;
    else if (a === "--accept") opts.accept.push(args[++i]);
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (!opts.writePatchPath) opts.writePatchPath = path.join(HOME_AGENT_DIR, "tier-overrides.patch.json");
  return opts;
}

function stripInlineComment(value) {
  // Generator-side only: strip anything from the first unescaped ` #` onward.
  const m = value.match(/(?<!\\) #/);
  return (m ? value.slice(0, m.index) : value).trim();
}

// The Default cell is the first `code span` (AGENTS.md may append prose such as
// "(fallback: `x`)"); a cell without one is taken whole.
function defaultModelCell(s) {
  const m = s.match(/`([^`]+)`/);
  return (m ? m[1] : s).trim();
}

function parseAgentsMdTiers(agentsMdPath) {
  const text = fs.readFileSync(agentsMdPath, "utf8");
  const lines = text.split("\n");
  const headingIdx = lines.findIndex((l) => /^##\s+Model Tiers\s*$/.test(l.trim()));
  if (headingIdx === -1) throw new Error(`"## Model Tiers" heading not found in ${agentsMdPath}`);
  let tableStart = -1;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) {
      const cells = l.split("|").map((c) => c.trim().toLowerCase());
      if (cells.some((c) => c === "tier") && cells.some((c) => c === "default") && cells.some((c) => c === "thinking")) {
        tableStart = i;
        break;
      }
    }
    if (/^##\s/.test(l) && i > headingIdx) break;
  }
  if (tableStart === -1) throw new Error(`No markdown table with Tier/Default/Thinking header found after "## Model Tiers" in ${agentsMdPath}`);
  const table = {};
  for (let i = tableStart + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*\|/.test(l)) break;
    const cells = l.split("|").map((c) => c.trim());
    // header separator row: |---|---|---|
    if (cells.every((c) => /^:?-+:?$/.test(c) || c === "")) continue;
    // cells[0] is empty (leading pipe), so real cells start at index 1
    const [_, tierRaw, modelRaw, thinkingRaw] = cells;
    if (!tierRaw) continue;
    const tier = tierRaw.trim();
    table[tier] = { model: defaultModelCell(modelRaw ?? ""), thinking: (thinkingRaw ?? "").trim() };
  }
  return table;
}

function parseFrontmatter(content) {
  const lines = content.split("\n");
  if (lines[0].trim() !== "---") return { frontmatter: {}, hasFrontmatter: false };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: {}, hasFrontmatter: false };
  const fm = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    fm[m[1]] = m[2];
  }
  return { frontmatter: fm, hasFrontmatter: true };
}

function parsePackageAgents(agentsDir) {
  const result = []; // { name, tier, lane, file }
  if (!fs.existsSync(agentsDir)) return result;
  for (const f of fs.readdirSync(agentsDir)) {
    if (!f.endsWith(".md")) continue;
    const full = path.join(agentsDir, f);
    const content = fs.readFileSync(full, "utf8");
    const { frontmatter } = parseFrontmatter(content);
    if (!frontmatter.name) throw new Error(`${full}: missing "name" in frontmatter`);
    if ("runner" in frontmatter || /^runner:/m.test(content.split("---")[1] ?? "")) {
      continue; // command-runner agents have no model
    }
    if ("model" in frontmatter || "thinking" in frontmatter) {
      throw new Error(`${full}: package agent frontmatter must not set model:/thinking: (tier is the only source of truth)`);
    }
    if (!("tier" in frontmatter)) continue; // no tier declared: not managed by this generator
    const tier = stripInlineComment(frontmatter.tier);
    const lane = "lane" in frontmatter ? stripInlineComment(frontmatter.lane) : null;
    result.push({ name: frontmatter.name.trim(), tier, lane, file: full });
  }
  return result;
}

function parseBuiltinTiers(builtinTiersPath) {
  if (!fs.existsSync(builtinTiersPath)) return [];
  const data = JSON.parse(fs.readFileSync(builtinTiersPath, "utf8"));
  return Object.entries(data).map(([name, tier]) => ({ name, tier, lane: null, file: builtinTiersPath }));
}

function loadJsonOr(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function modelAllowed(model, allowList) {
  if (!allowList || allowList.length === 0) return null; // no policy configured -> no verdict
  return allowList.some((pat) => globToRegExp(pat).test(model));
}

function detectIndent(rawText) {
  const m = rawText.match(/^\{\n( +)"/);
  if (m) return m[1].length;
  const m4 = rawText.match(/^\{\n(\t+)"/);
  if (m4) return "\t";
  return 2;
}

function main() {
  const opts = parseArgs(process.argv);

  let table;
  try {
    table = parseAgentsMdTiers(opts.agentsMd);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }

  let packageAgents, builtinAgents;
  try {
    packageAgents = parsePackageAgents(path.join(opts.packageDir, "agents"));
    builtinAgents = parseBuiltinTiers(path.join(opts.packageDir, "agents", "builtin-tiers.json"));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }

  const seen = new Map();
  const errors = [];
  for (const a of [...packageAgents, ...builtinAgents]) {
    if (seen.has(a.name)) {
      errors.push(`duplicate agent name "${a.name}" declared in ${seen.get(a.name)} and ${a.file}`);
    }
    seen.set(a.name, a.file);
  }
  const managed = [...packageAgents, ...builtinAgents];

  for (const [tier, row] of Object.entries(table)) {
    if (!VALID_TIERS.has(tier)) {
      const hint = /^mt-\d+$|^model-tier-\d+$/.test(tier) ? " (hint: use verbose tier names, not mt-N / model-tier-N)" : "";
      errors.push(`AGENTS.md table has unknown tier name "${tier}"${hint}`);
    }
    if (!row.model) errors.push(`AGENTS.md table: tier "${tier}" has no model`);
    if (!VALID_THINKING.has(row.thinking)) errors.push(`AGENTS.md table: tier "${tier}" thinking "${row.thinking}" not in ${[...VALID_THINKING].join("|")}`);
  }
  for (const a of managed) {
    if (!(a.tier in table)) errors.push(`${a.file}: agent "${a.name}" declares tier "${a.tier}" not present in AGENTS.md's Model Tiers table`);
  }

  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exit(1);
  }

  const settingsRaw = fs.existsSync(opts.settings) ? fs.readFileSync(opts.settings, "utf8") : "{}";
  const settings = JSON.parse(settingsRaw);
  const agentOverrides = settings.subagents?.agentOverrides ?? {};
  const modelScope = settings.subagents?.modelScope;
  const enabledModels = settings.enabledModels ?? [];

  const statePath = path.join(path.dirname(opts.settings), "tier-overrides.state.json");
  const state = loadJsonOr(statePath, { appliedAt: null, applied: {}, overrides: {} });

  // Compose --override-tier args (this run) with persisted overrides, then apply --clear-override.
  const overridesTiers = { ...state.overrides };
  for (const spec of opts.overrideTier) {
    const m = spec.match(/^([a-z]+)=([^:]+)(?::(.+))?$/);
    if (!m) {
      console.error(`error: --override-tier value must look like tier=model[:thinking], got "${spec}"`);
      process.exit(1);
    }
    const [, tier, model, thinking] = m;
    if (!VALID_TIERS.has(tier)) {
      console.error(`error: --override-tier: unknown tier "${tier}"`);
      process.exit(1);
    }
    overridesTiers[tier] = { model, thinking: thinking ?? table[tier]?.thinking ?? "medium", setAt: new Date().toISOString() };
  }
  for (const tier of opts.clearOverride) {
    delete overridesTiers[tier];
  }

  const warnings = [];
  const rows = []; // { agent, key, current, desired, class }
  const desiredByAgent = {};

  for (const a of managed) {
    const tierRow = table[a.tier];
    const override = overridesTiers[a.tier];
    const desired = { model: override ? override.model : tierRow.model, thinking: override ? override.thinking : tierRow.thinking };
    const isOverrideActive = !!override;
    const stateHasEntry = Object.prototype.hasOwnProperty.call(state.applied, a.name);
    const ownedKeys = ["model", "thinking"];
    if (a.lane === "trial" && !stateHasEntry) {
      desired.disabled = true;
      ownedKeys.push("disabled");
    }
    desiredByAgent[a.name] = { desired, ownedKeys, isOverrideActive };

    const current = agentOverrides[a.name] ?? {};
    const lastApplied = state.applied[a.name] ?? {};

    for (const key of ownedKeys) {
      const curVal = current[key];
      const desVal = desired[key];
      let cls;
      if (isOverrideActive && key !== "disabled") {
        cls = "override-active";
      } else if (curVal === undefined) {
        cls = "new";
      } else if (deepEqual(curVal, desVal)) {
        cls = "ok";
      } else if (Object.prototype.hasOwnProperty.call(lastApplied, key) && deepEqual(curVal, lastApplied[key])) {
        cls = "upstream-change";
      } else {
        cls = "drift";
      }
      rows.push({ agent: a.name, key, current: curVal, desired: desVal, class: cls });
    }

    const allow = modelScope?.agents?.[a.name]?.allow ?? modelScope?.allow;
    const scopeVerdict = modelAllowed(desired.model, allow);
    if (scopeVerdict === false) warnings.push(`${a.name}: desired model "${desired.model}" is not covered by modelScope allow list (would be rejected under strict, or warned under non-strict)`);
    if (!enabledModels.includes(desired.model)) warnings.push(`${a.name}: desired model "${desired.model}" is not in settings.enabledModels (cosmetic only)`);
  }

  const managedNames = new Set(managed.map((a) => a.name));
  const knownHandOwned = new Set(["scout", "oracle"]);
  let localAgentFiles = new Set();
  const localAgentsDir = path.join(HOME_AGENT_DIR, "agents");
  if (fs.existsSync(localAgentsDir)) {
    localAgentFiles = new Set(fs.readdirSync(localAgentsDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")));
  }
  const deadOverrides = Object.keys(agentOverrides).filter((name) => !managedNames.has(name) && !knownHandOwned.has(name) && !localAgentFiles.has(name));
  for (const d of deadOverrides) warnings.push(`agentOverrides["${d}"] targets an agent that is neither managed nor a known hand-owned/local agent (candidate dead override)`);

  const summaryCounts = { new: 0, ok: 0, "upstream-change": 0, "override-active": 0, drift: 0 };
  for (const r of rows) summaryCounts[r.class] = (summaryCounts[r.class] ?? 0) + 1;

  function printTable() {
    console.log("agent | key | current | desired | class");
    for (const r of rows) {
      console.log(`${r.agent} | ${r.key} | ${JSON.stringify(r.current)} | ${JSON.stringify(r.desired)} | ${r.class}`);
    }
    console.log(
      `${summaryCounts.new} new, ${summaryCounts.ok} ok, ${summaryCounts["upstream-change"]} upstream-change, ${summaryCounts["override-active"]} override-active, ${summaryCounts.drift} drift, ${warnings.length} warnings`
    );
    for (const w of warnings) console.log(`warning: ${w}`);
  }

  const hasPendingChanges = rows.some((r) => r.class !== "ok");
  const driftRows = rows.filter((r) => r.class === "drift");

  if (opts.mode === "dry-run") {
    printTable();
    process.exit(hasPendingChanges ? 2 : 0);
  }

  if (opts.mode === "write-patch") {
    printTable();
    const patch = {
      generatedAt: new Date().toISOString(),
      sources: { agentsMd: opts.agentsMd, packageDir: opts.packageDir, settings: opts.settings },
      agentOverrides: Object.fromEntries(
        managed.map((a) => [a.name, desiredByAgent[a.name].desired])
      ),
      drift: driftRows.map((r) => ({ agent: r.agent, key: r.key, current: r.current, desired: r.desired })),
      overrides: Object.entries(overridesTiers).map(([tier, v]) => ({ tier, ...v })),
      warnings,
    };
    fs.writeFileSync(opts.writePatchPath, JSON.stringify(patch, null, 2) + "\n");
    console.log(`wrote patch: ${opts.writePatchPath}`);
    process.exit(hasPendingChanges ? 2 : 0);
  }

  if (opts.mode === "apply") {
    const acceptedAgents = new Set(opts.accept);
    const unresolvedDrift = driftRows.filter((r) => !opts.force && !acceptedAgents.has(r.agent));
    if (unresolvedDrift.length) {
      printTable();
      console.error(`refused: ${unresolvedDrift.length} drift row(s) require --force or --accept <agent>:`);
      for (const r of unresolvedDrift) console.error(`  ${r.agent}.${r.key}: ${JSON.stringify(r.current)} -> ${JSON.stringify(r.desired)}`);
      process.exit(3);
    }

    const nowIso = new Date().toISOString();
    const backupPath = `${opts.settings}.bak-${nowIso.replace(/[:.]/g, "-")}`;
    fs.copyFileSync(opts.settings, backupPath);

    const newSettings = JSON.parse(JSON.stringify(settings));
    newSettings.subagents = newSettings.subagents ?? {};
    newSettings.subagents.agentOverrides = newSettings.subagents.agentOverrides ?? {};

    for (const r of rows) {
      if (r.class === "ok") continue;
      newSettings.subagents.agentOverrides[r.agent] = newSettings.subagents.agentOverrides[r.agent] ?? {};
      newSettings.subagents.agentOverrides[r.agent][r.key] = r.desired;
    }

    for (const name of opts.prune) {
      delete newSettings.subagents.agentOverrides[name];
    }

    const indent = detectIndent(settingsRaw);
    const tmpPath = `${opts.settings}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(newSettings, null, indent) + "\n");
    if (fs.existsSync(opts.settings)) fs.chmodSync(tmpPath, fs.statSync(opts.settings).mode & 0o777);
    fs.renameSync(tmpPath, opts.settings);

    const newState = { appliedAt: nowIso, applied: { ...state.applied }, overrides: overridesTiers };
    for (const a of managed) {
      if (opts.prune.includes(a.name)) {
        delete newState.applied[a.name];
        continue;
      }
      newState.applied[a.name] = { ...newSettings.subagents.agentOverrides[a.name] };
    }
    fs.writeFileSync(statePath, JSON.stringify(newState, null, 2) + "\n");

    printTable();
    console.log(`applied. backup: ${backupPath}`);
    if (opts.prune.length) console.log(`pruned: ${opts.prune.join(", ")}`);
    console.log("restart or /reload pi, then /subagents-models");
    process.exit(0);
  }
}

main();
