#!/usr/bin/env node
// {"commit": "<7-40 hex>", "base": "<ref>", "repo"?: "/abs/dir"} on stdin ->
// {"ok", "commit": <full sha>, "base": <full sha>, "head": <full sha>, "error"?}.
// A resumed step must continue from work that exists and was built on the step's base; anything else would review or
// ledger an unrelated tree. ok only when the commit exists and base is an ancestor of (or equal to) it. Always exits 0.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const done = (o) => { process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
let task;
try { task = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { done({ ok: false, error: "bad task JSON: " + e.message }); }
const cwd = task.repo || process.cwd();
const git = (...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
const resolve = (ref) => { const r = git("rev-parse", "--verify", "--quiet", ref + "^{commit}"); return r.status === 0 ? r.stdout.trim() : null; };

if (!/^[0-9a-f]{7,40}$/i.test(String(task.commit ?? ""))) done({ ok: false, error: "commit must be 7-40 hex chars" });
// A leading "-" would be parsed as a git option.
if (typeof task.base !== "string" || !task.base || task.base.startsWith("-")) done({ ok: false, error: "base must be a ref (the step's base_commit or baseCommit)" });
const commit = resolve(task.commit);
if (!commit) done({ ok: false, error: "commit " + task.commit + " does not exist in " + cwd });
const base = resolve(task.base);
if (!base) done({ ok: false, commit, error: "base " + task.base + " does not exist in " + cwd });
const head = resolve("HEAD");
const anc = git("merge-base", "--is-ancestor", base, commit);
if (anc.status !== 0) done({ ok: false, commit, base, head, error: "commit " + commit.slice(0, 12) + " does not descend from base " + base.slice(0, 12) });
done({ ok: true, commit, base, head });
