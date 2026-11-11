// Builds a throwaway bare origin + clone that covers every branch-lifecycle case the repo sweep
// classifies (tests/repo-sweep.test.mjs), the `gh pr list` JSON that goes with it, and a gitleaks stub.
// Node and git only, so it runs on every OS. All names are examples.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const MARKER = "LEAKME-example-secret";
export const USER = "tester";
const DAY = 86400;

/** yyyymmdd of an epoch, UTC (the sweep's archive-ref date). */
export const ymd = (epoch) =>
  new Date(epoch * 1000).toISOString().slice(0, 10).replaceAll("-", "");

/** Apply fn to every entry under dir, directories first, never following links. */
function walk(dir, fn) {
  fn(dir);
  if (!lstatSync(dir).isDirectory()) return;
  for (const name of readdirSync(dir)) walk(join(dir, name), fn);
}

export function removeTree(dir) {
  try {
    walk(dir, (p) => {
      if (!lstatSync(p).isSymbolicLink()) chmodSync(p, 0o777);
    });
  } catch {
    // already gone
  }
  rmSync(dir, { recursive: true, force: true });
}

const STUB = `import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
const value = (flag) => argv[argv.indexOf(flag) + 1];
const range = value("--log-opts") ?? "";
const config = argv.includes("--config") ? value("--config") : undefined;
const needle = config ? readFileSync(config, "utf8").trim() : process.env.STUB_MARKER;
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify({ range, config: config ?? null }) + "\\n");
// A test hook: move refs while the sweep is running, once.
const once = process.env.STUB_ONCE;
if (once && !existsSync(once)) {
  appendFileSync(once, "x");
  if (process.env.STUB_MOVE_LOCAL) {
    const [ref, oid] = process.env.STUB_MOVE_LOCAL.split("=");
    spawnSync("git", ["update-ref", ref, oid], { cwd: process.cwd() });
  }
  if (process.env.STUB_MOVE_ORIGIN) {
    const [ref, oid] = process.env.STUB_MOVE_ORIGIN.split("=");
    spawnSync("git", ["-C", process.env.STUB_ORIGIN, "update-ref", ref, oid]);
  }
}
const log = spawnSync("git", ["log", "-p", "--format=%H", ...range.split(" ")], { cwd: process.cwd(), encoding: "utf8" });
process.exit(log.stdout.includes(needle) ? 1 : 0);
`;

export function buildLifecycleRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sweep-")));
  const now = Math.floor(Date.now() / 1000);
  const config = join(root, "gitconfig");
  writeFileSync(
    config,
    "[user]\n\tname = Tester\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[core]\n\thooksPath = " +
      join(root, "nohooks").replaceAll("\\", "/") +
      "\n",
  );
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GUARD_OTEL: "off",
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SWEEP_") || key === "GITLEAKS_PRIVATE_CONFIG") delete env[key];
  }
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (cwd, message, seconds) => {
    git(cwd, "add", "-A");
    const date = `${String(now - seconds)} +0000`;
    execFileSync("git", ["commit", "-q", "-m", message], {
      cwd,
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: "ignore",
    });
    return git(cwd, "rev-parse", "HEAD");
  };
  const write = (cwd, rel, content) => {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), content);
  };
  const age = (dir, seconds) =>
    walk(dir, (p) => {
      if (!lstatSync(p).isSymbolicLink()) utimesSync(p, now - seconds, now - seconds);
    });

  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  const extra = join(root, "extra-root");
  mkdirSync(join(root, "nohooks"));
  mkdirSync(extra);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(clone);
  git(clone, "init", "-q", "-b", "main");
  git(clone, "remote", "add", "origin", origin);
  write(clone, "base.txt", "base\n");
  write(clone, "f.txt", Array.from({ length: 10 }, (_, i) => `l${String(i + 1)}\n`).join(""));
  write(clone, "del.txt", "del\n");
  const base = commit(clone, "base", 30 * DAY);
  git(clone, "push", "-q", "-u", "origin", "main");
  git(clone, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

  /** A branch off the base commit; returns its tip. `push` also publishes it, `keep` keeps the local branch. */
  const branch = (name, { files, seconds, push = false, keep = true }) => {
    git(clone, "checkout", "-q", "-b", name, base);
    for (const [rel, content] of Object.entries(files)) write(clone, rel, content);
    const tip = commit(clone, name, seconds);
    if (push) git(clone, "push", "-q", "-u", "origin", name);
    git(clone, "checkout", "-q", "main");
    if (!keep) git(clone, "branch", "-q", "-D", name);
    return tip;
  };
  const pullRef = (n, oid) => git(clone, "push", "-q", "origin", `${oid}:refs/pull/${String(n)}/head`);

  const tips = {};
  tips["pushed-synced"] = branch("pushed-synced", { files: { "a.txt": "a\n" }, seconds: 10 * DAY, push: true });
  tips["pushed-unpushed"] = branch("pushed-unpushed", { files: { "b.txt": "b\n" }, seconds: 10 * DAY, push: true });
  git(clone, "checkout", "-q", "pushed-unpushed");
  write(clone, "b2.txt", "b2\n");
  tips["pushed-unpushed-local"] = commit(clone, "unpushed", 9 * DAY);
  git(clone, "checkout", "-q", "main");
  tips["squash-merged"] = branch("squash-merged", { files: { "sm.txt": "sm\n" }, seconds: 11 * DAY, push: true });
  pullRef(3, tips["squash-merged"]);
  git(clone, "push", "-q", "origin", ":squash-merged");
  tips["worker-in-merged"] = branch("worker-in-merged", { files: { "w.txt": "w\n" }, seconds: 10 * DAY });
  git(clone, "checkout", "-q", "-b", "driver-other", tips["worker-in-merged"]);
  write(clone, "d.txt", "d\n");
  tips["driver/other"] = commit(clone, "driver", 10 * DAY);
  git(clone, "checkout", "-q", "main");
  git(clone, "branch", "-q", "-D", "driver-other");
  pullRef(4, tips["driver/other"]);
  for (const [name, n, days] of [["closed-8d", 5, 9], ["closed-3d", 6, 4], ["closed-other", 7, 10], ["merged-still-there", 12, 10]]) {
    tips[name] = branch(name, { files: { [`${name}.txt`]: `${name}\n` }, seconds: days * DAY, push: true, keep: false });
    pullRef(n, tips[name]);
  }
  tips["never-pushed-8d"] = branch("never-pushed-8d", { files: { "n8.txt": "n\n" }, seconds: 8 * DAY });
  tips["never-pushed-2d"] = branch("never-pushed-2d", { files: { "n2.txt": "n\n" }, seconds: 2 * DAY });
  tips["never-pushed-leak"] = branch("never-pushed-leak", { files: { "leak.txt": `${MARKER}\n` }, seconds: 9 * DAY });
  tips["private-name"] = branch("private-name", { files: { "pn.txt": "PRIVATE-NAME-X\n" }, seconds: 9 * DAY });
  // Landed by content, no PR: P1 (merge changes nothing), P2 (the file was deleted on main), refusal (added, never landed).
  tips["landed-p1"] = branch("landed-p1", { files: { "f.txt": ["X", ...Array.from({ length: 9 }, (_, i) => `l${String(i + 2)}`)].join("\n") + "\n" }, seconds: 10 * DAY, push: true, keep: false });
  tips["landed-p2"] = branch("landed-p2", { files: { "del.txt": "del\nmore\n" }, seconds: 10 * DAY, push: true, keep: false });
  tips["landed-p2-added"] = branch("landed-p2-added", { files: { "new.txt": "never lands\n" }, seconds: 10 * DAY, push: true, keep: false });
  tips["dependabot/npm/x"] = branch("dependabot/npm/x", { files: { "dep.txt": "dep\n" }, seconds: 20 * DAY, push: true, keep: false });
  tips.fresh = branch("fresh", { files: { "fr.txt": "fr\n" }, seconds: 2 * 3600, push: true });
  for (const name of ["dirty-wt", "ro-wt", "draft-idle", "draft-fresh"]) {
    tips[name] = branch(name, { files: { [`${name}.txt`]: `${name}\n`, "ro/inner/f.txt": "ro\n" }, seconds: 10 * DAY, push: true });
  }

  // main moves on: the squash merge, the driver merge, and the content of the two landed branches.
  write(clone, "sm.txt", "sm\n");
  commit(clone, "squash of squash-merged", 11 * DAY);
  write(clone, "w.txt", "w\n");
  write(clone, "d.txt", "d\n");
  commit(clone, "squash of driver/other", 10 * DAY);
  write(clone, "f.txt", ["X", ...Array.from({ length: 8 }, (_, i) => `l${String(i + 2)}`), "Y"].join("\n") + "\n");
  commit(clone, "landed-p1 by another commit", 9 * DAY);
  git(clone, "rm", "-q", "del.txt");
  commit(clone, "delete del.txt", 9 * DAY);
  git(clone, "push", "-q", "origin", "main");

  // Worktrees: idle (aged), fresh, dirty, read-only files.
  const trees = join(clone, ".claude", "worktrees");
  const wt = (name) => join(trees, name);
  for (const name of ["dirty-wt", "ro-wt", "draft-idle", "draft-fresh"]) {
    git(clone, "worktree", "add", "-q", wt(name), name);
  }
  for (const name of ["dirty-wt", "ro-wt", "draft-idle"]) age(wt(name), 3 * DAY);
  write(wt("dirty-wt"), "scratch.txt", "uncommitted\n");
  chmodSync(join(wt("ro-wt"), "ro", "inner", "f.txt"), 0o444);
  chmodSync(join(wt("ro-wt"), "ro", "inner"), 0o555);

  // Unregistered dirs: their worktree entry is gone (a remove that failed on read-only files).
  const orphans = [join(trees, "orphan"), join(wt("dirty-wt"), ".claude", "worktrees", "nested"), join(extra, "orphan2")];
  const common = join(clone, ".git");
  for (const dir of orphans) {
    git(clone, "worktree", "add", "-q", "--detach", dir);
    rmSync(join(common, "worktrees", dir.split(/[\\/]/).at(-1)), { recursive: true, force: true });
  }

  // Stashes: 8 d and 1 d old (stash@{1} and stash@{0}).
  for (const [text, seconds] of [["old", 8 * DAY], ["new", 1 * DAY]]) {
    write(clone, "base.txt", `${text}\n`);
    const date = `${String(now - seconds)} +0000`;
    execFileSync("git", ["stash", "push", "-q", "-m", text], { cwd: clone, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: "ignore" });
  }

  // Archive refs on origin: 100 d and 10 d old.
  const archives = {
    old: `refs/archive/old-work/${ymd(now - 100 * DAY)}-${base.slice(0, 12)}`,
    recent: `refs/archive/recent-work/${ymd(now - 10 * DAY)}-${base.slice(0, 12)}`,
  };
  for (const ref of Object.values(archives)) git(clone, "push", "-q", "origin", `${base}:${ref}`);
  git(clone, "fetch", "-q", "--prune", "origin");

  const iso = (seconds) => new Date((now - seconds) * 1000).toISOString();
  const pr = (number, state, head, oid, extra = {}) => ({
    number,
    state,
    headRefName: head,
    headRefOid: oid,
    baseRefName: "main",
    closedAt: null,
    mergedAt: null,
    updatedAt: iso(DAY),
    author: { login: USER },
    ...extra,
  });
  const prs = [
    pr(1, "OPEN", "pushed-synced", tips["pushed-synced"]),
    pr(2, "OPEN", "pushed-unpushed", tips["pushed-unpushed"]),
    pr(3, "MERGED", "squash-merged", tips["squash-merged"], { mergedAt: iso(11 * DAY), closedAt: iso(11 * DAY) }),
    pr(4, "MERGED", "driver/other", tips["driver/other"], { mergedAt: iso(10 * DAY), closedAt: iso(10 * DAY) }),
    pr(5, "CLOSED", "closed-8d", tips["closed-8d"], { closedAt: iso(8 * DAY) }),
    pr(6, "CLOSED", "closed-3d", tips["closed-3d"], { closedAt: iso(3 * DAY) }),
    pr(7, "CLOSED", "closed-other", tips["closed-other"], { closedAt: iso(9 * DAY), author: { login: "someone-else" } }),
    pr(8, "OPEN", "draft-idle", tips["draft-idle"]),
    pr(9, "OPEN", "draft-fresh", tips["draft-fresh"]),
    pr(10, "OPEN", "dirty-wt", tips["dirty-wt"]),
    pr(11, "OPEN", "ro-wt", tips["ro-wt"]),
    pr(12, "MERGED", "merged-still-there", tips["merged-still-there"], { mergedAt: iso(9 * DAY), closedAt: iso(9 * DAY) }),
  ];
  const prsFile = join(root, "prs.json");
  writeFileSync(prsFile, JSON.stringify(prs));
  const stub = join(root, "gitleaks-stub.mjs");
  writeFileSync(stub, STUB);
  const [major, minor] = git(root, "--version").match(/(\d+)\.(\d+)/).slice(1).map(Number);
  const p1 = major > 2 || (major === 2 && minor >= 38);

  return {
    root,
    origin,
    clone,
    extraRoot: extra,
    now,
    prsFile,
    stub,
    tips,
    archives,
    base,
    trees: { idle: wt("draft-idle"), readonly: wt("ro-wt"), dirty: wt("dirty-wt"), fresh: wt("draft-fresh") },
    orphans,
    // The environment every sweep run in a test starts from.
    env: {
      ...env,
      SWEEP_NOW: String(now),
      SWEEP_GH_PRS: prsFile,
      SWEEP_GH_USER: USER,
      SWEEP_GH_VISIBILITY: "private",
      SWEEP_GITLEAKS: stub,
      SWEEP_WORKTREES_ROOT: extra,
      STUB_MARKER: MARKER,
      STUB_LOG: join(root, "stub.log"),
    },
    git: (...args) => git(clone, ...args),
    gitIn: git,
    // What a dry run says about each item (default remote scope).
    expected: {
      local: {
        main: "keep",
        "pushed-synced": "delete",
        "pushed-unpushed": "list",
        "squash-merged": "delete",
        "worker-in-merged": "delete",
        "never-pushed-8d": "archive",
        "never-pushed-2d": "list",
        "never-pushed-leak": "archive",
        "private-name": "archive",
        fresh: "keep",
        "dirty-wt": "list",
        "ro-wt": "delete",
        "draft-idle": "delete",
        "draft-fresh": "keep",
      },
      remote: {
        "pushed-synced": "keep",
        "pushed-unpushed": "keep",
        "closed-8d": "delete",
        "closed-3d": "keep",
        "closed-other": "keep",
        "merged-still-there": "delete",
        "landed-p1": p1 ? "delete" : "list",
        "landed-p2": "delete",
        "landed-p2-added": "list",
        "dependabot/npm/x": "keep",
        fresh: "keep",
        "dirty-wt": "keep",
        "ro-wt": "keep",
        "draft-idle": "keep",
        "draft-fresh": "keep",
      },
      archive: { [archives.old]: "delete", [archives.recent]: "keep" },
      stash: { "stash@{0}": "keep", "stash@{1}": "archive" },
    },
    cleanup: () => removeTree(root),
  };
}
