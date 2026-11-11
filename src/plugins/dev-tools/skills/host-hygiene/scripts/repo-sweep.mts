#!/usr/bin/env node
// repo-sweep.mjs [--apply] [--auto] [--json] [--repo <dir>] [--remote-scope mine|all]
//
// Applies the branch lifecycle (github-workflow skill) to one repo's worktrees, local and remote
// branches and stashes. Origin holds the work; a local copy goes once origin has it. Dry run by
// default: it prints what each item becomes; --apply does it; --auto is --apply for the session-start
// hook (no-op unless 24 h passed since the last run, one summary line, exits 0 on every failure).
// Usage errors exit 2. Needs node 22+ and git; gh (GitHub) and gitleaks are optional.
//
// "On origin" means the tip is reachable from a remote-tracking ref (after `git fetch --prune`), from
// the head of a merged PR (refs/pull/<n>/head), or from a refs/archive/* ref on origin.
//
// What an item becomes (first match wins):
//   keep     the default branch, a branch checked out in the main or the current worktree, bot branches
//            (dependabot/*, renovate/*, release-please--*, SWEEP_KEEP globs), anything whose tip is
//            younger than 24 h, the head or base of an open PR.
//   delete   local branch on origin (its worktree, if any, is clean, not in use and idle 24 h: the
//            worktree is removed first, an open draft PR's included, unless it holds ignored secrets: .env*,
//            *secret*, *.key; other ignored files, build output, do not block); remote branch whose PR
//            merged, whose PR closed unmerged 7 idle days ago with the remote tip still the PR's head (a
//            reused name is listed), or, with --remote-scope all only, that has no PR and landed by content;
//            a local copy never counts a remote branch deleted in the same run as "on origin"; archive refs
//            older than SWEEP_ARCHIVE_DAYS; stashes after archiving. Every delete is compare-and-delete:
//            a tip that moved since classification is kept and logged as `moved`.
//   archive  local branch not on origin, no open PR, idle 7 days, clean worktree; stash 7 days old.
//            Pushed to refs/archive/<branch>/<yyyymmdd>-<sha12> (stash: refs/archive/stash/...; date =
//            archive day, UTC), verified with ls-remote, then removed locally. First, gitleaks scans the
//            commits origin lacks (plus a second pass with GITLEAKS_PRIVATE_CONFIG on a public repo, and
//            when the visibility is unknown); a finding, a failed scan or a missing gitleaks keeps the
//            item local and lists it.
//   list     what needs a person: dirty or in-use worktrees, unpushed work, remote branches pushed
//            without a PR (that nothing proves landed, or any on the default scope), unregistered dirs under the worktree roots (with
//            size and the commands that reclaim them; never removed by the sweep).
//
// Remote branches are touched on GitHub only (PR data from gh); elsewhere the sweep does locals and
// archives. Only PRs authored by the logged-in gh user are acted on unless --remote-scope all. A remote
// branch with no PR is never deleted on the default `mine` scope (it may be a teammate's); with
// --remote-scope all it is deleted only when its content landed on the default branch D: P1 merging it into
// D changes nothing (git 2.38+), P2 every file it changed is identical on D or was deleted on D after
// the merge base (a file it added that never landed is no proof), P3 it is inside a merged PR head
// based on D.
//
// State lives in <git-common-dir>/sweep/: stamp, lock/ (stale after 1 h), last.json (counts, summary
// text, log path) and log.jsonl, one {time, kind, name, oid, reason, restore} per action. To restore,
// run the line's `restore`: an origin fetch (then `git branch <name> <oid>`), possible while origin
// keeps the ref (archives: 90 days). Offline (fetch fails) only local branches that a remote-tracking
// ref already holds are deleted.
//
// Env: SWEEP_MIN_AGE_H (24), SWEEP_IDLE_DAYS (7), SWEEP_ARCHIVE_DAYS (90), SWEEP_REMOTE_SCOPE (mine),
// SWEEP_KEEP (comma-separated globs), SWEEP_WORKTREES_ROOT (extra roots, path-list separated),
// GITLEAKS_PRIVATE_CONFIG. Tests: SWEEP_GH_PRS (gh pr list JSON file), SWEEP_GH_USER,
// SWEEP_GH_VISIBILITY, SWEEP_NOW (epoch seconds), SWEEP_GITLEAKS (binary or .mjs stub).
import { spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AUTO_INTERVAL,
  BOT_BRANCH_GLOBS,
  DAY,
  LOCK_STALE,
  WALK_CAP,
} from "./constants.mjs";
import type {
  Counts,
  Item,
  LogLine,
  Pr,
  RemoteScope,
  Report,
  SweepConfig,
} from "./types.mjs";

const USAGE =
  "usage: repo-sweep.mjs [--apply] [--auto] [--json] [--repo <dir>] [--remote-scope mine|all]";

// ---------------------------------------------------------------- process helpers

interface Run {
  code: number;
  out: string;
  err: string;
}

function run(cmd: string, args: string[], cwd: string, timeout?: number): Run {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.error) return { code: -1, out: "", err: r.error.message };
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function epochOf(v: unknown): number | undefined {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

/** Parse `gh pr list --json ...` output; undefined when it is not a PR array. */
export function parsePrs(raw: string): Pr[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const prs: Pr[] = [];
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.number !== "number") continue;
    const author = entry.author;
    prs.push({
      number: entry.number,
      state: text(entry.state).toUpperCase(),
      headRefName: text(entry.headRefName),
      headRefOid: text(entry.headRefOid),
      baseRefName: text(entry.baseRefName),
      closedAt: epochOf(entry.closedAt),
      mergedAt: epochOf(entry.mergedAt),
      updatedAt: epochOf(entry.updatedAt),
      author: isRecord(author) ? text(author.login) : "",
    });
  }
  return prs;
}

// ---------------------------------------------------------------- config

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+^${}()|[\]\\?]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

function days(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0
    ? n
    : fallback;
}

/** Parse argv and env into a config; a string is a usage error. */
export function loadConfig(
  argv: string[],
  env: NodeJS.ProcessEnv,
): SweepConfig | string {
  let apply = false;
  let auto = false;
  let json = false;
  let repo = process.cwd();
  let scope = env.SWEEP_REMOTE_SCOPE ?? "mine";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--auto") auto = true;
    else if (arg === "--json") json = true;
    else if (arg === "--repo" || arg === "--remote-scope") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) return USAGE;
      if (arg === "--repo") repo = value;
      else scope = value;
    } else return USAGE;
  }
  if (scope !== "mine" && scope !== "all") return USAGE;
  const remoteScope: RemoteScope = scope;
  const now = Number(env.SWEEP_NOW);
  const keepGlobs = [
    ...BOT_BRANCH_GLOBS,
    ...(env.SWEEP_KEEP ?? "").split(/[\s,]+/).filter(Boolean),
  ];
  const roots = (env.SWEEP_WORKTREES_ROOT ?? "")
    .split(delimiter)
    .filter(Boolean);
  return {
    apply: apply || auto,
    auto,
    json,
    repo,
    remoteScope,
    now: Number.isFinite(now) && env.SWEEP_NOW ? now : Date.now() / 1000,
    minAgeSeconds: days(env.SWEEP_MIN_AGE_H, 24) * 3600,
    idleSeconds: days(env.SWEEP_IDLE_DAYS, 7) * DAY,
    archiveSeconds: days(env.SWEEP_ARCHIVE_DAYS, 90) * DAY,
    keep: keepGlobs.map(globToRegExp),
    roots,
    gitleaks: env.SWEEP_GITLEAKS ?? "gitleaks",
    prsFile: env.SWEEP_GH_PRS,
    ghUser: env.SWEEP_GH_USER,
    visibility: env.SWEEP_GH_VISIBILITY,
    privateConfig: env.GITLEAKS_PRIVATE_CONFIG,
  };
}

// ---------------------------------------------------------------- repo context

interface Worktree {
  path: string;
  branch: string | undefined;
}

interface OriginHold {
  ref: string;
  via: string;
}

interface Ctx {
  cfg: SweepConfig;
  dir: string;
  common: string;
  sweepDir: string;
  main: string;
  current: string;
  defaultBranch: string;
  defaultOid: string;
  offline: boolean;
  prs: Pr[] | undefined;
  user: string | undefined;
  mergedHeads: { number: number; oid: string }[];
  /** Remote branches this run deletes: their remote-tracking refs hold nothing. */
  doomed: Set<string>;
  archives: { ref: string; oid: string }[];
  gitVersion: [number, number];
  log: LogLine[];
}

function git(ctx: { dir: string }, ...args: string[]): Run {
  return run("git", args, ctx.dir);
}

function gitText(ctx: { dir: string }, ...args: string[]): string | undefined {
  const r = git(ctx, ...args);
  return r.code === 0 ? r.out.trim() : undefined;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function listWorktrees(ctx: { dir: string }): Worktree[] {
  const r = git(ctx, "worktree", "list", "--porcelain");
  if (r.code !== 0) return [];
  return r.out
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const path = lines
        .find((l) => l.startsWith("worktree "))
        ?.slice("worktree ".length);
      const ref = lines
        .find((l) => l.startsWith("branch refs/heads/"))
        ?.slice("branch refs/heads/".length);
      return path === undefined ? undefined : { path, branch: ref };
    })
    .filter((w): w is Worktree => w !== undefined);
}

const ymd = (epoch: number): string =>
  new Date(epoch * 1000).toISOString().slice(0, 10).replaceAll("-", "");

function isAncestor(ctx: Ctx, oid: string, of: string): boolean {
  return git(ctx, "merge-base", "--is-ancestor", oid, of).code === 0;
}

function hasCommit(ctx: Ctx, oid: string): boolean {
  return git(ctx, "cat-file", "-e", `${oid}^{commit}`).code === 0;
}

// ---------------------------------------------------------------- filesystem helpers

/** Depth-first walk without following links; `visit` returns true to stop. Returns whether it stopped. */
function walk(
  root: string,
  visit: (path: string, st: Stats) => boolean,
  skip: readonly string[] = [],
): boolean {
  let seen = 0;
  const step = (path: string): boolean => {
    if (++seen > WALK_CAP) return true;
    let st: Stats;
    try {
      st = lstatSync(path);
    } catch {
      return false;
    }
    if (visit(path, st)) return true;
    if (!st.isDirectory()) return false;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return false;
    }
    return names.some((name) => !skip.includes(name) && step(join(path, name)));
  };
  return step(root);
}

function makeWritable(root: string): void {
  walk(root, (path, st) => {
    if (!st.isSymbolicLink()) {
      try {
        chmodSync(path, st.mode | 0o200);
      } catch {
        // git worktree remove reports what is left
      }
    }
    return false;
  });
}

function modifiedSince(root: string, since: number): boolean {
  return walk(root, (path, st) => path !== root && st.mtimeMs / 1000 > since, [
    ".git",
    "node_modules",
  ]);
}

function treeSize(root: string): string {
  let bytes = 0;
  walk(root, (_path, st) => {
    if (st.isFile()) bytes += st.size;
    return false;
  });
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** True when a process may hold files under dir; any error counts as in use. */
function inUse(dir: string): boolean {
  if (process.platform === "win32") {
    const probe = `${dir}.sweep-probe`;
    try {
      renameSync(dir, probe);
    } catch {
      return true;
    }
    try {
      renameSync(probe, dir);
    } catch {
      return true;
    }
    return false;
  }
  const r = spawnSync("lsof", ["+D", dir], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status === null || r.status > 1) return true;
  return r.stdout.split("\n").filter((l) => l.trim() !== "").length > 1;
}

// ---------------------------------------------------------------- secret scan

function scanOnce(ctx: Ctx, oid: string, config?: string): string | undefined {
  const args = [
    "git",
    "--no-banner",
    "--redact",
    "--log-opts",
    `--diff-merges=remerge ${oid} --not --remotes=origin`,
    ...(config === undefined ? [] : ["--config", config]),
  ];
  const bin = ctx.cfg.gitleaks;
  const script = /\.[cm]?js$/.test(bin);
  const r = script
    ? run(process.execPath, [bin, ...args], ctx.dir, 120000)
    : run(bin, args, ctx.dir, 120000);
  if (r.code === 0) return undefined;
  const pass = config === undefined ? "secret scan" : "private-name scan";
  if (r.code === -1)
    return `${pass} unavailable: ${r.err.split("\n")[0] ?? ""}`;
  return r.code === 1
    ? `${pass} reported a finding`
    : `${pass} failed (exit ${String(r.code)})`;
}

function visibility(ctx: Ctx): string {
  if (ctx.cfg.visibility !== undefined) return ctx.cfg.visibility.toLowerCase();
  const r = run("gh", ["repo", "view", "--json", "visibility"], ctx.dir, 30000);
  if (r.code !== 0) return "unknown";
  try {
    const data: unknown = JSON.parse(r.out);
    return isRecord(data) ? text(data.visibility).toLowerCase() : "unknown";
  } catch {
    return "unknown";
  }
}

/** Why an archive push must not happen, or undefined when the commits origin lacks are clean. */
function scanFailure(ctx: Ctx, oid: string): string | undefined {
  const first = scanOnce(ctx, oid);
  if (first !== undefined) return first;
  const config = ctx.cfg.privateConfig;
  const public_ = !["private", "internal"].includes(visibility(ctx));
  if (!public_ || config === undefined) return undefined;
  try {
    accessSync(config, fsConstants.R_OK);
  } catch {
    return undefined;
  }
  return scanOnce(ctx, oid, config);
}

// ---------------------------------------------------------------- origin facts

function openContext(cfg: SweepConfig): Ctx | string {
  const dir = cfg.repo;
  const probe = { dir };
  const common = gitText(
    probe,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  if (common === undefined) return `${dir} is not a git repository`;
  if (gitText(probe, "remote", "get-url", "origin") === undefined) {
    return "no origin remote";
  }
  const trees = listWorktrees(probe);
  const head = gitText(
    probe,
    "symbolic-ref",
    "-q",
    "--short",
    "refs/remotes/origin/HEAD",
  );
  const fallback = ["main", "master"].find(
    (b) =>
      git(probe, "rev-parse", "-q", "--verify", `refs/remotes/origin/${b}`)
        .code === 0,
  );
  const defaultBranch = head?.replace(/^origin\//, "") ?? fallback;
  if (defaultBranch === undefined) return "cannot tell the default branch";
  const version = /(\d+)\.(\d+)/.exec(git(probe, "--version").out);
  return {
    cfg,
    dir,
    common,
    sweepDir: join(common, "sweep"),
    main: real(trees[0]?.path ?? dir),
    current: real(gitText(probe, "rev-parse", "--show-toplevel") ?? dir),
    defaultBranch,
    defaultOid: "",
    offline: false,
    prs: undefined,
    user: undefined,
    mergedHeads: [],
    doomed: new Set(),
    archives: [],
    gitVersion: [Number(version?.[1] ?? 0), Number(version?.[2] ?? 0)],
    log: [],
  };
}

function loadPrs(ctx: Ctx): void {
  const { cfg } = ctx;
  if (cfg.prsFile !== undefined) {
    try {
      ctx.prs = parsePrs(readFileSync(cfg.prsFile, "utf8"));
    } catch {
      ctx.prs = undefined;
    }
    ctx.user = cfg.ghUser;
    return;
  }
  if (ctx.offline) return;
  const r = run(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,state,headRefName,headRefOid,baseRefName,closedAt,mergedAt,updatedAt,author",
    ],
    ctx.dir,
    120000,
  );
  if (r.code === 0) ctx.prs = parsePrs(r.out);
  ctx.user =
    cfg.ghUser ??
    (ctx.prs === undefined
      ? undefined
      : run(
          "gh",
          ["api", "user", "--jq", ".login"],
          ctx.dir,
          30000,
        ).out.trim() || undefined);
}

interface Branch {
  name: string;
  oid: string;
  date: number;
}

function refs(ctx: Ctx, prefix: string, strip: number): Branch[] {
  const r = git(
    ctx,
    "for-each-ref",
    `--format=%(refname:lstrip=${String(strip)})%09%(objectname)%09%(committerdate:unix)`,
    prefix,
  );
  if (r.code !== 0) return [];
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", oid = "", date = "0"] = line.split("\t");
      return { name, oid, date: Number(date) };
    });
}

/** Fetch heads of merged PRs that may hold a candidate tip (once, objects only). */
function fetchMergedHeads(ctx: Ctx, since: number): void {
  const merged = (ctx.prs ?? []).filter(
    (pr) =>
      pr.state === "MERGED" &&
      pr.headRefOid !== "" &&
      (pr.mergedAt ?? Number.MAX_SAFE_INTEGER) >= since,
  );
  const wanted = merged
    .filter((pr) => !hasCommit(ctx, pr.headRefOid))
    .sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0))
    .slice(0, 100);
  if (wanted.length > 0) {
    const specs = wanted.map((pr) => `refs/pull/${String(pr.number)}/head`);
    if (
      git(ctx, "fetch", "--quiet", "--no-tags", "origin", ...specs).code !== 0
    ) {
      for (const spec of specs) {
        git(ctx, "fetch", "--quiet", "--no-tags", "origin", spec);
      }
    }
  }
  ctx.mergedHeads = merged
    .filter((pr) => hasCommit(ctx, pr.headRefOid))
    .map((pr) => ({ number: pr.number, oid: pr.headRefOid }));
}

function loadArchives(ctx: Ctx): void {
  const r = git(ctx, "ls-remote", "origin", "refs/archive/*");
  if (r.code !== 0) return;
  ctx.archives = r.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [oid = "", ref = ""] = line.split("\t");
      return { oid, ref };
    });
}

/** Where origin holds this tip, if anywhere. */
function heldByOrigin(ctx: Ctx, oid: string): OriginHold | undefined {
  const remote = (
    gitText(
      ctx,
      "for-each-ref",
      "--contains",
      oid,
      "--format=%(refname:lstrip=3)",
      "refs/remotes/origin",
    ) ?? ""
  )
    .split("\n")
    .find((name) => name !== "" && !ctx.doomed.has(name));
  if (remote) return { ref: `refs/heads/${remote}`, via: `origin/${remote}` };
  for (const head of ctx.mergedHeads) {
    if (isAncestor(ctx, oid, head.oid)) {
      return {
        ref: `refs/pull/${String(head.number)}/head`,
        via: `merged PR #${String(head.number)}`,
      };
    }
  }
  for (const archive of ctx.archives) {
    if (hasCommit(ctx, archive.oid) && isAncestor(ctx, oid, archive.oid)) {
      return { ref: archive.ref, via: archive.ref };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- content proof

/** Why the remote tip's content already landed on the default branch, or undefined. */
function landedByContent(ctx: Ctx, tip: string): string | undefined {
  const d = ctx.defaultOid;
  const [major, minor] = ctx.gitVersion;
  if (major > 2 || (major === 2 && minor >= 38)) {
    const merged = git(ctx, "merge-tree", "--write-tree", d, tip);
    const tree = gitText(ctx, "rev-parse", `${d}^{tree}`);
    if (merged.code === 0 && merged.out.split("\n")[0]?.trim() === tree) {
      return "merging it into the default branch changes nothing";
    }
  }
  const base = gitText(ctx, "merge-base", d, tip);
  if (base !== undefined) {
    const changed = gitText(
      ctx,
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      base,
      tip,
    );
    const apart = git(ctx, "diff", "--raw", "--no-renames", "-z", d, tip);
    if (changed !== undefined && apart.code === 0) {
      const mine = new Set(changed.split("\0").filter(Boolean));
      const fields = apart.out.split("\0").filter(Boolean);
      const differing: { status: string; path: string }[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const status = (fields[i] ?? "").trim().slice(-1);
        const path = fields[i + 1] ?? "";
        if (mine.has(path)) differing.push({ status, path });
      }
      const proven =
        differing.length <= 200 &&
        differing.every(
          // D->tip: A = the tip has a file D lacks (deleted on D after the base only if the base had it)
          ({ status, path }) =>
            status === "A" &&
            git(ctx, "cat-file", "-e", `${base}:${path}`).code === 0,
        );
      if (proven) {
        return "every file it changed is identical on the default branch or was deleted there";
      }
    }
  }
  for (const pr of ctx.prs ?? []) {
    if (
      pr.state === "MERGED" &&
      pr.baseRefName === ctx.defaultBranch &&
      hasCommit(ctx, pr.headRefOid) &&
      isAncestor(ctx, tip, pr.headRefOid)
    ) {
      return `inside merged PR #${String(pr.number)}`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- classification

const ageOf = (ctx: Ctx, epoch: number): number => ctx.cfg.now - epoch;
const daysAgo = (seconds: number): string =>
  `${String(Math.floor(seconds / DAY))} d`;

function isKept(ctx: Ctx, name: string): boolean {
  return ctx.cfg.keep.some((re) => re.test(name));
}

function inScope(ctx: Ctx, pr: Pr): boolean {
  return (
    ctx.cfg.remoteScope === "all" ||
    pr.author.toLowerCase() === ctx.user?.toLowerCase()
  );
}

interface WorktreeState {
  verdict: "ok" | "list" | "keep";
  reason: string;
}

// The guard's NEVER_REGEN pattern (plugins/guard/core/engine.mts), copied: an ignored path with such a segment
// is a local secret that origin does not hold.
const SECRET_SEGMENT = /^\.env|secret|\.key$/i;

function worktreeState(ctx: Ctx, path: string): WorktreeState {
  if (!existsSync(path)) return { verdict: "ok", reason: "" };
  const status = git({ dir: path }, "status", "--porcelain", "--ignored");
  if (status.code !== 0)
    return { verdict: "list", reason: "git status failed in its worktree" };
  const lines = status.out.split("\n").filter((l) => l.trim() !== "");
  if (lines.some((l) => !l.startsWith("!! "))) {
    return { verdict: "list", reason: "its worktree has uncommitted changes" };
  }
  const secrets = lines
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .filter((p) => p.split("/").some((seg) => SECRET_SEGMENT.test(seg)));
  if (secrets.length > 0) {
    return {
      verdict: "list",
      reason: `ignored secrets: ${secrets.slice(0, 3).join(", ")}`,
    };
  }
  if (modifiedSince(path, ctx.cfg.now - ctx.cfg.minAgeSeconds)) {
    return {
      verdict: "keep",
      reason: "its worktree was modified in the last 24 h",
    };
  }
  if (inUse(path)) {
    return { verdict: "list", reason: "its worktree is in use by a process" };
  }
  return { verdict: "ok", reason: "" };
}

function classifyLocal(ctx: Ctx, items: Item[]): void {
  const trees = listWorktrees(ctx);
  const held = (branch: string): Worktree | undefined =>
    trees.find((w) => w.branch === branch);
  const prs = ctx.prs ?? [];
  for (const b of refs(ctx, "refs/heads", 2)) {
    const base = { kind: "local-branch" as const, name: b.name, oid: b.oid };
    const tree = held(b.name);
    const worktree = tree === undefined ? {} : { worktree: tree.path };
    const done = (
      verdict: Item["verdict"],
      reason: string,
      extra: Partial<Item> = {},
    ): void => {
      items.push({ ...base, ...worktree, verdict, reason, ...extra });
    };
    if (b.name === ctx.defaultBranch) {
      done("keep", "default branch");
      continue;
    }
    if (isKept(ctx, b.name)) {
      done("keep", "bot or SWEEP_KEEP branch");
      continue;
    }
    if (
      tree !== undefined &&
      [ctx.main, ctx.current].includes(real(tree.path))
    ) {
      done("keep", "checked out in the main or the current worktree");
      continue;
    }
    if (ageOf(ctx, b.date) < ctx.cfg.minAgeSeconds) {
      done("keep", "tip younger than 24 h");
      continue;
    }
    const origin = heldByOrigin(ctx, b.oid);
    const state: WorktreeState =
      tree === undefined
        ? { verdict: "ok", reason: "" }
        : worktreeState(ctx, tree.path);
    if (origin !== undefined) {
      if (state.verdict === "ok") {
        done("delete", `on origin (${origin.via})`, { ref: origin.ref });
      } else {
        done(state.verdict, `on origin (${origin.via}) but ${state.reason}`, {
          ref: origin.ref,
        });
      }
      continue;
    }
    const open = prs.find(
      (p) => p.state === "OPEN" && p.headRefName === b.name,
    );
    if (open !== undefined) {
      done(
        "list",
        `open PR #${String(open.number)} lacks commits origin does not have: push them`,
        { pr: open.number },
      );
    } else if (ageOf(ctx, b.date) < ctx.cfg.idleSeconds) {
      done(
        "list",
        `not on origin; idle ${daysAgo(ageOf(ctx, b.date))}, archived after ${daysAgo(ctx.cfg.idleSeconds)}`,
      );
    } else if (state.verdict !== "ok") {
      done("list", `not on origin and ${state.reason}`);
    } else if (ctx.offline) {
      done("list", "not on origin; offline, cannot archive");
    } else {
      done("archive", "not on origin, no open PR, idle");
    }
  }
}

function classifyRemote(ctx: Ctx, items: Item[]): void {
  const prs = ctx.prs;
  for (const b of refs(ctx, "refs/remotes/origin", 3)) {
    if (b.name === "HEAD" || b.name === ctx.defaultBranch) continue;
    const base = {
      kind: "remote-branch" as const,
      name: b.name,
      oid: b.oid,
      ref: `refs/heads/${b.name}`,
    };
    const say = (
      verdict: Item["verdict"],
      reason: string,
      extra: Partial<Item> = {},
    ): void => {
      items.push({ ...base, verdict, reason, ...extra });
    };
    if (isKept(ctx, b.name)) {
      say("keep", "bot or SWEEP_KEEP branch");
      continue;
    }
    if (ageOf(ctx, b.date) < ctx.cfg.minAgeSeconds) {
      say("keep", "tip younger than 24 h");
      continue;
    }
    if (prs === undefined || ctx.offline) {
      say("keep", "no PR data: remote branches are swept on GitHub only");
      continue;
    }
    const open = prs.find(
      (p) =>
        p.state === "OPEN" &&
        (p.headRefName === b.name || p.baseRefName === b.name),
    );
    if (open !== undefined) {
      say("keep", `head or base of open PR #${String(open.number)}`);
      continue;
    }
    const own = prs.filter((p) => p.headRefName === b.name);
    const merged = own.find(
      (p) =>
        p.state === "MERGED" &&
        hasCommit(ctx, p.headRefOid) &&
        isAncestor(ctx, b.oid, p.headRefOid),
    );
    if (merged !== undefined) {
      if (inScope(ctx, merged))
        say("delete", `PR #${String(merged.number)} merged`, {
          pr: merged.number,
        });
      else
        say(
          "keep",
          `PR #${String(merged.number)} is by ${merged.author}: --remote-scope all`,
        );
      continue;
    }
    const closed = own
      .filter((p) => p.state === "CLOSED")
      .sort((x, y) => (y.closedAt ?? 0) - (x.closedAt ?? 0))[0];
    if (closed !== undefined) {
      const idle = Math.min(
        ageOf(ctx, closed.closedAt ?? ctx.cfg.now),
        ageOf(ctx, b.date),
      );
      if (idle < ctx.cfg.idleSeconds) {
        say(
          "keep",
          `PR #${String(closed.number)} closed ${daysAgo(idle)} ago: waits ${daysAgo(ctx.cfg.idleSeconds)}`,
          { pr: closed.number },
        );
      } else if (!inScope(ctx, closed)) {
        say(
          "keep",
          `PR #${String(closed.number)} is by ${closed.author}: --remote-scope all`,
          { pr: closed.number },
        );
      } else if (
        b.oid !== closed.headRefOid &&
        !(
          hasCommit(ctx, closed.headRefOid) &&
          isAncestor(ctx, b.oid, closed.headRefOid)
        )
      ) {
        say(
          "list",
          `reused branch name: tip differs from closed PR #${String(closed.number)}`,
          { pr: closed.number },
        );
      } else {
        say(
          "delete",
          `PR #${String(closed.number)} closed unmerged, idle ${daysAgo(idle)}`,
          { pr: closed.number },
        );
      }
      continue;
    }
    const proof = landedByContent(ctx, b.oid);
    if (proof !== undefined && ctx.cfg.remoteScope === "all")
      say("delete", `no PR; ${proof}`);
    else if (proof !== undefined)
      say(
        "list",
        `no PR; ${proof}; deleted only with --remote-scope all (its author is not checked)`,
      );
    else say("list", "pushed without a PR, not proven landed");
  }
}

function classifyArchives(ctx: Ctx, items: Item[]): void {
  for (const a of ctx.archives) {
    const stamp = /\/(\d{4})(\d{2})(\d{2})-[0-9a-f]{12}$/.exec(a.ref);
    const made = stamp
      ? Date.UTC(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3])) /
        1000
      : undefined;
    const base = {
      kind: "archive-ref" as const,
      name: a.ref,
      oid: a.oid,
      ref: a.ref,
    };
    if (made === undefined)
      items.push({ ...base, verdict: "keep", reason: "no date in its name" });
    else if (ctx.cfg.now - made > ctx.cfg.archiveSeconds) {
      items.push({
        ...base,
        verdict: "delete",
        reason: `archived ${daysAgo(ctx.cfg.now - made)} ago, expires after ${daysAgo(ctx.cfg.archiveSeconds)}`,
      });
    } else
      items.push({ ...base, verdict: "keep", reason: "archive not expired" });
  }
}

function classifyStashes(ctx: Ctx, items: Item[]): void {
  const r = git(ctx, "stash", "list", "--format=%gd%x09%H%x09%ct");
  if (r.code !== 0) return;
  for (const line of r.out.split("\n").filter(Boolean)) {
    const [name = "", oid = "", date = "0"] = line.split("\t");
    const age = ageOf(ctx, Number(date));
    const base = { kind: "stash" as const, name, oid };
    if (age < ctx.cfg.idleSeconds)
      items.push({
        ...base,
        verdict: "keep",
        reason: `stash is ${daysAgo(age)} old`,
      });
    else if (ctx.offline)
      items.push({
        ...base,
        verdict: "list",
        reason: "offline, cannot archive",
      });
    else
      items.push({
        ...base,
        verdict: "archive",
        reason: `stash is ${daysAgo(age)} old`,
      });
  }
}

function classifyDirs(ctx: Ctx, items: Item[]): void {
  const trees = listWorktrees(ctx).map((w) => w.path);
  const registered = new Set(trees.map(real));
  const roots = new Set<string>();
  for (const t of [ctx.main, ...trees])
    roots.add(join(t, ".claude", "worktrees"));
  for (const r of ctx.cfg.roots) roots.add(r);
  const seen = new Set<string>();
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = real(join(root, name));
      if (seen.has(dir) || registered.has(dir)) continue;
      seen.add(dir);
      let pointer: string;
      try {
        pointer = readFileSync(join(dir, ".git"), "utf8");
      } catch {
        continue;
      }
      const target = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
      const entries = join(real(ctx.common), "worktrees");
      if (target === undefined || existsSync(target)) continue;
      if (!join(real(dirname(target)), basename(target)).startsWith(entries))
        continue;
      const windows = process.platform === "win32";
      const commands = windows
        ? `Remove-Item -LiteralPath '${dir}' -Recurse -Force`
        : `chmod -R u+w '${dir}' && rm -rf '${dir}'`;
      items.push({
        kind: "unregistered-dir",
        name: dir,
        oid: "",
        verdict: "list",
        reason: "not a registered worktree",
        size: treeSize(dir),
        commands,
      });
    }
  }
}

// ---------------------------------------------------------------- applying

function record(
  ctx: Ctx,
  kind: string,
  item: Item,
  reason: string,
  restore: string,
): void {
  const line: LogLine = {
    time: new Date(ctx.cfg.now * 1000).toISOString(),
    kind,
    name: item.name,
    oid: item.oid,
    reason,
    restore,
  };
  ctx.log.push(line);
  mkdirSync(ctx.sweepDir, { recursive: true });
  appendFileSync(join(ctx.sweepDir, "log.jsonl"), `${JSON.stringify(line)}\n`);
}

const tipOf = (ctx: Ctx, branch: string): string | undefined =>
  gitText(ctx, "rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`);

const restoreBranch = (item: Item, ref: string): string =>
  `git fetch origin ${ref} && git branch ${item.name} ${item.oid}`;

/** Remove the item's worktree (clean only, never --force) and then its branch, both compare-and-delete. */
function removeLocal(ctx: Ctx, item: Item, ref: string, why: string): void {
  if (tipOf(ctx, item.name) !== item.oid) {
    item.done = false;
    item.note = "moved: the branch changed since it was classified";
    record(ctx, "moved", item, item.note, "");
    return;
  }
  const restore = restoreBranch(item, ref);
  if (item.worktree !== undefined && existsSync(item.worktree)) {
    const state = worktreeState(ctx, item.worktree);
    if (state.verdict !== "ok") {
      item.done = false;
      item.note = state.reason;
      return;
    }
    makeWritable(item.worktree);
    const removed = git(ctx, "worktree", "remove", item.worktree);
    if (removed.code !== 0) {
      item.done = false;
      item.note = `git worktree remove refused: ${removed.err.trim().split("\n")[0] ?? ""}`;
      return;
    }
    record(ctx, "remove-worktree", item, `${why}; ${item.worktree}`, restore);
  }
  const holder = listWorktrees(ctx).find((w) => w.branch === item.name);
  if (holder !== undefined) {
    item.done = false;
    item.note = `checked out in ${holder.path}`;
    return;
  }
  const deleted = git(
    ctx,
    "update-ref",
    "-d",
    `refs/heads/${item.name}`,
    item.oid,
  );
  if (deleted.code !== 0) {
    item.done = false;
    item.note = "moved: the branch changed since it was classified";
    record(ctx, "moved", item, item.note, "");
    return;
  }
  git(ctx, "config", "--remove-section", `branch.${item.name}`);
  item.done = true;
  record(ctx, "delete-branch", item, why, restore);
}

function archiveRefOf(ctx: Ctx, item: Item): string {
  const prefix = item.kind === "stash" ? "stash" : item.name;
  return `refs/archive/${prefix}/${ymd(ctx.cfg.now)}-${item.oid.slice(0, 12)}`;
}

/** Scan, push to the archive ref and verify it on origin; undefined means archived. */
function pushArchive(ctx: Ctx, item: Item, ref: string): string | undefined {
  if (item.kind === "local-branch" && tipOf(ctx, item.name) !== item.oid) {
    return "moved: the branch changed since it was classified";
  }
  const failure = scanFailure(ctx, item.oid);
  if (failure !== undefined) return `${failure}: kept local`;
  const pushed = git(ctx, "push", "--quiet", "origin", `${item.oid}:${ref}`);
  if (pushed.code !== 0) {
    return `archive push failed: ${pushed.err.trim().split("\n")[0] ?? ""}`;
  }
  const check = gitText(ctx, "ls-remote", "origin", ref);
  if (check?.split(/\s+/)[0] !== item.oid)
    return "archive not found on origin after the push";
  return undefined;
}

function dropStash(ctx: Ctx, item: Item, ref: string): void {
  const listed = git(ctx, "stash", "list", "--format=%gd%x09%H");
  const index = listed.out
    .split("\n")
    .map((l) => l.split("\t"))
    .find(([, sha]) => sha === item.oid)?.[0];
  if (index === undefined) {
    item.done = false;
    item.note = "stash is gone or changed";
    return;
  }
  const dropped = git(ctx, "stash", "drop", "--quiet", index);
  item.done = dropped.code === 0;
  if (item.done) {
    record(
      ctx,
      "archive-stash",
      item,
      item.reason,
      `git fetch origin ${ref} && git stash apply ${item.oid}`,
    );
  } else item.note = "git stash drop failed";
}

function applyArchives(ctx: Ctx, items: Item[]): void {
  const stashes: Item[] = [];
  for (const item of items.filter((i) => i.verdict === "archive")) {
    const ref = archiveRefOf(ctx, item);
    const failure = pushArchive(ctx, item, ref);
    if (failure !== undefined) {
      item.done = false;
      item.note = failure;
      if (!failure.startsWith("moved")) item.verdict = "list";
      else record(ctx, "moved", item, failure, "");
      continue;
    }
    item.ref = ref;
    if (item.kind === "stash") stashes.push(item);
    else {
      removeLocal(ctx, item, ref, `archived at ${ref}`);
      if (item.done === true) {
        record(
          ctx,
          "archive-branch",
          item,
          `archived at ${ref}`,
          restoreBranch(item, ref),
        );
      }
    }
  }
  // Highest index first, so a drop never renumbers a stash still waiting.
  for (const item of stashes.reverse()) dropStash(ctx, item, item.ref ?? "");
}

function pushDelete(ctx: Ctx, ref: string, oid: string): Run {
  return git(
    ctx,
    "push",
    "--quiet",
    `--force-with-lease=${ref}:${oid}`,
    "origin",
    `:${ref}`,
  );
}

function applyRemote(ctx: Ctx, items: Item[]): void {
  for (const item of items.filter(
    (i) =>
      i.verdict === "delete" &&
      (i.kind === "remote-branch" || i.kind === "archive-ref"),
  )) {
    const ref = item.ref ?? "";
    const pr = item.pr === undefined ? "" : `refs/pull/${String(item.pr)}/head`;
    const restore =
      item.kind === "remote-branch" && pr !== ""
        ? `git fetch origin ${pr} && git push origin ${item.oid}:${ref}`
        : `git push origin ${item.oid}:${ref}`;
    const r = pushDelete(ctx, ref, item.oid);
    item.done = r.code === 0;
    if (item.done) {
      record(
        ctx,
        item.kind === "archive-ref" ? "expire-archive" : "delete-remote-branch",
        item,
        item.reason,
        restore,
      );
    } else {
      item.note =
        "moved or not deletable: the ref changed on origin or the push was refused";
      record(ctx, "moved", item, item.note, "");
    }
  }
}

function applyAll(ctx: Ctx, items: Item[]): void {
  if (!ctx.offline) applyArchives(ctx, items);
  for (const item of items.filter(
    (i) => i.kind === "local-branch" && i.verdict === "delete",
  )) {
    removeLocal(ctx, item, item.ref ?? "", item.reason);
  }
  if (!ctx.offline) applyRemote(ctx, items);
  git(ctx, "worktree", "prune");
}

// ---------------------------------------------------------------- report

function count(cfg: SweepConfig, items: Item[]): Counts {
  const happened = (i: Item): boolean => !cfg.apply || i.done === true;
  const where = (kind: Item["kind"], verdict: Item["verdict"]): Item[] =>
    items.filter(
      (i) => i.kind === kind && i.verdict === verdict && happened(i),
    );
  return {
    localBranches: where("local-branch", "delete").length,
    worktrees: items.filter(
      (i) =>
        i.kind === "local-branch" &&
        i.worktree !== undefined &&
        (i.verdict === "delete" || i.verdict === "archive") &&
        happened(i),
    ).length,
    archived:
      where("local-branch", "archive").length +
      where("stash", "archive").length,
    remoteBranches: where("remote-branch", "delete").length,
    expiredArchives: where("archive-ref", "delete").length,
    listed: items.filter((i) => i.verdict === "list").length,
  };
}

function summarize(ctx: Ctx, c: Counts, logPath: string): string {
  const w = ctx.cfg.apply ? "" : "would ";
  const parts: string[] = [];
  const removed = [
    c.localBranches > 0
      ? `${String(c.localBranches)} local branch${c.localBranches === 1 ? "" : "es"}`
      : "",
    c.worktrees > 0
      ? `${String(c.worktrees)} worktree${c.worktrees === 1 ? "" : "s"}`
      : "",
  ].filter(Boolean);
  if (removed.length > 0)
    parts.push(
      `${w}${ctx.cfg.apply ? "removed" : "remove"} ${removed.join(", ")}`,
    );
  if (c.archived > 0)
    parts.push(
      `${w}${ctx.cfg.apply ? "archived" : "archive"} ${String(c.archived)}`,
    );
  if (c.remoteBranches > 0)
    parts.push(
      `${w}${ctx.cfg.apply ? "deleted" : "delete"} ${String(c.remoteBranches)} stale remote branch${c.remoteBranches === 1 ? "" : "es"}`,
    );
  if (c.expiredArchives > 0)
    parts.push(
      `${w}${ctx.cfg.apply ? "expired" : "expire"} ${String(c.expiredArchives)} archive${c.expiredArchives === 1 ? "" : "s"}`,
    );
  if (c.listed > 0) parts.push(`${String(c.listed)} listed`);
  const body = parts.length > 0 ? parts.join("; ") : "nothing to do";
  return `sweep: ${body}${ctx.cfg.apply ? `; log ${logPath}` : ""}`;
}

const LABEL: Record<Item["kind"], string> = {
  "local-branch": "branch",
  "remote-branch": "origin branch",
  "archive-ref": "archive",
  stash: "stash",
  "unregistered-dir": "dir",
};

function render(report: Report): string[] {
  const lines: string[] = [];
  for (const i of report.items) {
    if (i.kind === "unregistered-dir") {
      lines.push(
        `unregistered ${i.name} (${i.size ?? "?"}): the owner runs ${i.commands ?? ""}`,
      );
    } else if (i.verdict === "list") {
      lines.push(`list ${LABEL[i.kind]} ${i.name}: ${i.note ?? i.reason}`);
    } else if (i.verdict === "keep") {
      continue;
    } else if (!report.apply) {
      lines.push(`would ${i.verdict} ${LABEL[i.kind]} ${i.name}: ${i.reason}`);
    } else if (i.done === true) {
      lines.push(
        `${i.verdict === "delete" ? "deleted" : "archived"} ${LABEL[i.kind]} ${i.name}: ${i.reason}`,
      );
    } else {
      lines.push(`kept ${LABEL[i.kind]} ${i.name}: ${i.note ?? "not done"}`);
    }
  }
  lines.push(report.summary);
  return lines;
}

// ---------------------------------------------------------------- run

function takeLock(ctx: Ctx): boolean {
  const lock = join(ctx.sweepDir, "lock");
  mkdirSync(ctx.sweepDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      return true;
    } catch {
      try {
        if (ctx.cfg.now - statSync(lock).mtimeMs / 1000 <= LOCK_STALE)
          return false;
        rmSync(lock, { recursive: true, force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

function stampAge(ctx: Ctx): number {
  try {
    const at = Number(readFileSync(join(ctx.sweepDir, "stamp"), "utf8").trim());
    return Number.isFinite(at) ? ctx.cfg.now - at : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function sweep(ctx: Ctx): Report {
  ctx.offline = git(ctx, "fetch", "--prune", "--quiet", "origin").code !== 0;
  ctx.defaultOid =
    gitText(ctx, "rev-parse", `refs/remotes/origin/${ctx.defaultBranch}`) ?? "";
  loadPrs(ctx);
  if (!ctx.offline) loadArchives(ctx);
  const local = refs(ctx, "refs/heads", 2);
  const remote = refs(ctx, "refs/remotes/origin", 3);
  const lonely = [
    ...local.filter(
      (b) =>
        !gitText(
          ctx,
          "for-each-ref",
          "--count=1",
          "--contains",
          b.oid,
          "--format=x",
          "refs/remotes/origin",
        ),
    ),
    ...remote.filter(
      (b) =>
        b.name !== "HEAD" &&
        !(ctx.prs ?? []).some((p) => p.headRefName === b.name),
    ),
  ];
  if (!ctx.offline && lonely.length > 0) {
    fetchMergedHeads(ctx, Math.min(...lonely.map((b) => b.date)));
  }
  const items: Item[] = [];
  // Remote decisions first: a local copy is "on origin" only through a remote branch this run keeps.
  const remoteItems: Item[] = [];
  classifyRemote(ctx, remoteItems);
  for (const i of remoteItems) {
    if (i.verdict === "delete") ctx.doomed.add(i.name);
  }
  classifyLocal(ctx, items);
  items.push(...remoteItems);
  if (!ctx.offline) classifyArchives(ctx, items);
  classifyStashes(ctx, items);
  classifyDirs(ctx, items);
  if (ctx.cfg.apply) applyAll(ctx, items);
  const counts = count(ctx.cfg, items);
  const logPath = join(ctx.sweepDir, "log.jsonl");
  const summary = summarize(ctx, counts, logPath);
  if (ctx.cfg.apply) {
    mkdirSync(ctx.sweepDir, { recursive: true });
    writeFileSync(
      join(ctx.sweepDir, "last.json"),
      `${JSON.stringify({ time: new Date(ctx.cfg.now * 1000).toISOString(), counts, summary, log: logPath })}\n`,
    );
    writeFileSync(
      join(ctx.sweepDir, "stamp"),
      `${String(Math.floor(ctx.cfg.now))}\n`,
    );
  }
  return {
    repo: ctx.dir,
    defaultBranch: ctx.defaultBranch,
    apply: ctx.cfg.apply,
    offline: ctx.offline,
    items,
    counts,
    summary,
    log: logPath,
  };
}

/** Run the CLI; returns the exit code. */
export function main(argv: string[], env: NodeJS.ProcessEnv): number {
  const cfg = loadConfig(argv, env);
  if (typeof cfg === "string") {
    console.error(cfg);
    return 2;
  }
  const failure = (message: string): number => {
    if (!cfg.auto) console.error(`sweep: ${message}`);
    return cfg.auto ? 0 : 1;
  };
  try {
    const ctx = openContext(cfg);
    if (typeof ctx === "string") return failure(ctx);
    if (cfg.auto) {
      if (stampAge(ctx) < AUTO_INTERVAL) return 0;
      if (!takeLock(ctx)) return 0;
    }
    try {
      const report = sweep(ctx);
      if (cfg.json) console.log(JSON.stringify(report, null, 2));
      else if (cfg.auto) console.log(report.summary);
      else console.log(render(report).join("\n"));
    } finally {
      if (cfg.auto)
        rmSync(join(ctx.sweepDir, "lock"), { recursive: true, force: true });
    }
    return 0;
  } catch (e) {
    return failure(e instanceof Error ? e.message : "failed");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
