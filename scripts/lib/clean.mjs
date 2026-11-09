// Shared clean-tree definition for pi's tree-check host script and Claude Code's gates.mjs, so the two harnesses cannot
// disagree on what "clean" means. dirtyPaths(repo, planDir, {stage, wtdir, ignoreSha}) ->
// {paths[], byproducts[], allByproducts, ignoreSha, hint?} or {error, ignoreSha?}; never throws.
// Untracked files are listed per file whatever the user's status.showUntrackedFiles, submodules are never ignored, and
// fsmonitor/untracked cache are off, because each would otherwise hide dirt. Tracked files flagged assume-unchanged or
// skip-worktree are hashed against the index, and untracked .gitignore files count even when they ignore themselves.
// Not dirty: the plan dir; untracked sibling plan dirs (a directory next to the plan dir holding PROGRESS.md, plan.json
// or spec.md, with nothing in the index or HEAD); `stage`; and registered worktrees under `wtdir` (lane worktrees). Only
// worktrees under `wtdir`: a worker can register a worktree anywhere, and one inside src/ must still count. No
// exclusion may be a symlink, the repo root, or (except the plan dir) hold tracked content.
// Ignored files are never checked (gitignore gate by-products). The ignore sources outside the tree
// (.git/info/exclude, core.excludesFile) are hashed into ignoreSha: the caller records it before dispatch and passes it
// back after, so a worker that ignores its own files fails closed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const why = (r) => ((r.stderr || "").trim() || (r.error && r.error.message) || "exit " + r.status);
const BYPRODUCT = /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|htmlcov|coverage|node_modules|\.venv|dist|build|target|[^/]+\.egg-info)(\/|$)|\.(pyc|pyo|coverage|log)$|(^|\/)\.coverage(\.|$)/;

const MARKERS = ["PROGRESS.md", "plan.json", "spec.md"];
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const readOr = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const isLink = (p) => { try { return fs.lstatSync(p.replace(/\/+$/, "")).isSymbolicLink(); } catch { return false; } };

export function dirtyPaths(repo, planDir, opt = {}) {
  try { return dirty(repo, planDir, opt); } catch (e) { return { error: e.message }; }
}

function dirty(repo, planDir, { stage, wtdir, ignoreSha }) {
  const run = (cwd, args) => spawnSync("git", ["-C", cwd, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const t = run(repo, ["rev-parse", "--show-toplevel"]);
  if (t.status !== 0) return { error: "git rev-parse failed in " + repo + ": " + why(t) };
  const top = real(t.stdout.trim());
  const git = (args, what) => { const r = run(top, args); if (r.status !== 0) throw new Error("git " + what + " failed in " + top + " (not treated as clean): " + why(r)); return r.stdout; };
  // "" for the root itself, null outside the repo.
  const inside = (abs) => { const r = path.relative(top, real(abs)); return r.startsWith("..") || path.isAbsolute(r) ? null : r; };
  const hasHead = run(top, ["rev-parse", "-q", "--verify", "HEAD"]).status === 0;
  const tracked = (rel) => git(["ls-files", "--", ":(top,literal)" + rel], "ls-files").trim() !== ""
    || (hasHead && git(["ls-tree", "-r", "--name-only", "HEAD", "--", ":(top,literal)" + rel], "ls-tree").trim() !== "");
  const ex = new Set();
  const candidate = (abs, what, mayTrack) => {
    if (isLink(abs)) return what + " must not be a symlink: " + abs;
    const r = inside(abs);
    if (r === "") return what + " is the repo root (" + top + "): it must be a subdirectory, or every file would count as " + what + " state";
    if (r === null) return null;
    if (!mayTrack && ![...ex].some((e) => r === e || r.startsWith(e + "/")) && tracked(r)) return what + " holds tracked files, so excluding it would hide changes: " + r;
    ex.add(r); return null;
  };
  let e = candidate(planDir, "plan dir", true);
  if (!e && stage) e = candidate(stage, "--stage", false);
  if (!e && wtdir) {
    if (isLink(wtdir)) e = "--wtdir must not be a symlink: " + wtdir;
    else if (inside(wtdir) === "") e = "--wtdir is the repo root (" + top + ")";
  }
  if (e) return { error: e };
  if (wtdir) {
    const root = real(wtdir);
    for (const line of git(["worktree", "list", "--porcelain"], "worktree list").split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const w = real(line.slice(9));
      const under = path.relative(root, w);
      if (under === "" || under.startsWith("..") || path.isAbsolute(under)) continue;
      const r = inside(w); if (r && !tracked(r)) ex.add(r);
    }
  }
  const spec = [":(top)", ...[...ex].map((r) => ":(top,literal,exclude)" + r)];
  const planRel = inside(planDir);
  const parent = planRel ? path.dirname(planRel) : ".";
  const sib = new Map();
  const sibling = (p) => {
    if (parent === "." || !p.startsWith(parent + "/")) return false;
    const d = parent + "/" + p.slice(parent.length + 1).split("/")[0];
    if (!sib.has(d)) sib.set(d, d !== p && MARKERS.some((m) => fs.existsSync(path.join(top, d, m))) && !tracked(d));
    return sib.get(d);
  };
  const z = (s) => s.split("\0").filter(Boolean);
  const paths = [];
  const ent = z(git(["-c", "status.showUntrackedFiles=all", "status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=none", "--", ...spec], "status"));
  for (let i = 0; i < ent.length; i++) {
    const x = ent[i];
    if (x[0] === "R" || x[0] === "C") i++;
    if (x.startsWith("?? ") && sibling(x.slice(3))) continue;
    paths.push(x);
  }
  // A .gitignore that ignores itself (or is ignored by info/exclude) hides itself and whatever it lists.
  for (const p of z(git(["ls-files", "-z", "--others", "--", ":(top,glob)**/.gitignore", ...spec.slice(1)], "ls-files --others")))
    if (!paths.includes("?? " + p) && !sibling(p)) paths.push("?? " + p);
  const flagged = z(git(["ls-files", "-v", "-z", "--", ...spec], "ls-files -v"))
    .filter((x) => x[0] === "S" || /[a-z]/.test(x[0])).map((x) => ({ tag: x[0], p: x.slice(2) }));
  if (flagged.length) {
    const blob = new Map(z(git(["ls-files", "-s", "-z", "--", ...flagged.map((f) => ":(top,literal)" + f.p)], "ls-files -s"))
      .map((x) => { const [meta, p] = x.split("\t"); const [mode, oid] = meta.split(" "); return [p, { mode, oid }]; }));
    for (const f of flagged) {
      const b = blob.get(f.p);
      if (!b || b.mode === "160000" || b.mode === "120000") continue;
      const flag = f.tag === "S" ? "skip-worktree" : "assume-unchanged";
      if (!fs.existsSync(path.join(top, f.p))) { if (flag === "assume-unchanged") paths.push(" D " + f.p + " (" + flag + ")"); continue; }
      if (git(["hash-object", "--", f.p], "hash-object").trim() !== b.oid) paths.push(" M " + f.p + " (" + flag + ")");
    }
  }
  const excl = (run(top, ["config", "--get", "core.excludesFile"]).stdout || "").trim();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config");
  const exFile = excl ? excl.replace(/^~(?=\/|$)/, process.env.HOME || "~") : path.join(xdg, "git", "ignore");
  const info = path.resolve(top, git(["rev-parse", "--git-path", "info/exclude"], "rev-parse --git-path").trim());
  const sha = sha256(JSON.stringify([excl, readOr(path.resolve(top, exFile)), readOr(info)]));
  if (ignoreSha && ignoreSha !== sha) return { error: "ignore rules changed since they were recorded (" + info + " or core.excludesFile " + exFile + "): a worker may not ignore its own files", ignoreSha: sha };
  const byproducts = paths.filter((p) => p.startsWith("?? ") && BYPRODUCT.test(p.slice(3)));
  return { paths, byproducts, allByproducts: paths.length > 0 && byproducts.length === paths.length, ignoreSha: sha,
    hint: byproducts.length ? byproducts.length + " likely gate or tool by-product(s), ignore them (e.g. .git/info/exclude): " + byproducts.slice(0, 10).join(", ") + (byproducts.length > 10 ? ", ..." : "") : undefined };
}

