// Tests for plugins/dev-tools/skills/host-hygiene/scripts/repo-sweep.mjs: a throwaway origin and clone
// (tests/fixtures/lifecycle-repo.mjs), the real script as a child process, a gitleaks stub. No POSIX shell.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildLifecycleRepo, removeTree, ymd } from "./fixtures/lifecycle-repo.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/dev-tools/skills/host-hygiene/scripts/repo-sweep.mjs", import.meta.url));

function sweep(fx, args = [], env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--repo", fx.clone], {
    env: { ...fx.env, ...env },
    encoding: "utf8",
    timeout: 240000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function report(fx, args = [], env = {}) {
  const r = sweep(fx, ["--json", ...args], env);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
}

/** verdict per item of one kind, keyed by name. */
function verdicts(rep, kind) {
  return Object.fromEntries(rep.items.filter((i) => i.kind === kind).map((i) => [i.name, i.verdict]));
}

const branches = (fx, cwd = fx.clone) =>
  fx.gitIn(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
const originHeads = (fx) =>
  fx.gitIn(fx.origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
const originArchives = (fx) =>
  fx.gitIn(fx.origin, "for-each-ref", "--format=%(refname)", "refs/archive").split("\n").filter(Boolean).sort();
const logLines = (fx) => {
  const file = join(fx.clone, ".git", "sweep", "log.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const nonKeep = (table) => Object.entries(table).filter(([, v]) => v !== "keep").map(([k]) => k).sort();

describe("dry run", () => {
  let fx;
  before(() => {
    fx = buildLifecycleRepo();
  });
  after(() => fx.cleanup());

  test("gives each item the verdict the lifecycle table sets, and changes nothing", () => {
    const headsBefore = branches(fx);
    const originBefore = originHeads(fx);
    const rep = report(fx);
    assert.equal(rep.apply, false);
    assert.equal(rep.offline, false);
    assert.deepEqual(verdicts(rep, "local-branch"), fx.expected.local);
    assert.deepEqual(verdicts(rep, "remote-branch"), fx.expected.remote);
    assert.deepEqual(verdicts(rep, "archive-ref"), fx.expected.archive);
    assert.deepEqual(verdicts(rep, "stash"), fx.expected.stash);
    assert.deepEqual(branches(fx), headsBefore);
    assert.deepEqual(originHeads(fx), originBefore);
    assert.equal(existsSync(join(fx.clone, ".git", "sweep", "log.jsonl")), false);
    assert.ok(existsSync(fx.trees.idle) && existsSync(fx.trees.readonly));
    assert.equal(fx.gitIn(fx.clone, "stash", "list").split("\n").length, 2);
  });

  test("says why: origin holds the tip through a remote branch, a merged PR of any name, or nothing does", () => {
    const rep = report(fx);
    const reason = (kind, name) => rep.items.find((i) => i.kind === kind && i.name === name)?.reason ?? "";
    assert.match(reason("local-branch", "pushed-synced"), /on origin \(origin\/pushed-synced\)/);
    assert.match(reason("local-branch", "squash-merged"), /on origin \(merged PR #3\)/);
    assert.match(reason("local-branch", "worker-in-merged"), /on origin \(merged PR #4\)/);
    assert.match(reason("local-branch", "pushed-unpushed"), /open PR #2/);
    assert.match(reason("local-branch", "dirty-wt"), /uncommitted changes/);
    assert.match(reason("local-branch", "draft-fresh"), /modified in the last 24 h/);
    assert.match(reason("remote-branch", "closed-3d"), /closed 3 d ago/);
    assert.match(reason("remote-branch", "landed-p2-added"), /not proven landed/);
  });

  test("text output names each action and ends with one summary line", () => {
    const r = sweep(fx);
    assert.equal(r.code, 0);
    const lines = r.out.trim().split("\n");
    assert.ok(lines.includes("would delete branch pushed-synced: on origin (origin/pushed-synced)"));
    assert.ok(lines.some((l) => l.startsWith("would archive branch never-pushed-8d:")));
    assert.ok(lines.some((l) => l.startsWith("list origin branch landed-p2-added:")));
    assert.match(lines.at(-1), /^sweep: would remove \d+ local branches, 2 worktrees; would archive 4; would delete 2 stale remote branches; would expire 1 archive; \d+ listed$/);
  });

  test("lists unregistered dirs under every root with size and the commands, and never removes them", () => {
    const rep = report(fx);
    const dirs = rep.items.filter((i) => i.kind === "unregistered-dir");
    assert.equal(dirs.length, 3);
    for (const orphan of fx.orphans) {
      const item = dirs.find((d) => d.name.endsWith(orphan.split(/[\\/]/).at(-1)));
      assert.ok(item, orphan);
      assert.match(item.size, /MB$/);
      assert.match(item.commands, /(rm -rf|Remove-Item)/);
      assert.ok(existsSync(orphan));
    }
    assert.match(sweep(fx).out, /^unregistered .*orphan \(.*\): the owner runs /m);
  });

  test("remote scope: a branch with no PR that landed by content is deleted only with --remote-scope all", () => {
    const all = verdicts(report(fx, ["--remote-scope", "all"]), "remote-branch");
    assert.equal(all["landed-p2"], "delete");
    assert.equal(all["landed-p1"], fx.p1 ? "delete" : "list");
    assert.equal(all["landed-p2-added"], "list");
  });

  test("remote scope: other authors' closed PRs are acted on only with --remote-scope all", () => {
    assert.equal(verdicts(report(fx, ["--remote-scope", "all"]), "remote-branch")["closed-other"], "delete");
    assert.equal(verdicts(report(fx, [], { SWEEP_REMOTE_SCOPE: "all" }), "remote-branch")["closed-other"], "delete");
    assert.equal(verdicts(report(fx, ["--remote-scope", "mine"], { SWEEP_REMOTE_SCOPE: "all" }), "remote-branch")["closed-other"], "keep");
  });

  test("SWEEP_KEEP globs and the idle threshold change verdicts", () => {
    const kept = verdicts(report(fx, [], { SWEEP_KEEP: "squash-*,closed-8d" }), "local-branch");
    assert.equal(kept["squash-merged"], "keep");
    assert.equal(verdicts(report(fx, [], { SWEEP_KEEP: "closed-8d" }), "remote-branch")["closed-8d"], "keep");
    assert.equal(verdicts(report(fx, [], { SWEEP_IDLE_DAYS: "1" }), "local-branch")["never-pushed-2d"], "archive");
  });

  test("usage errors exit 2", () => {
    for (const args of [["--bogus"], ["--remote-scope", "everyone"], ["--remote-scope"], ["--repo"]]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: fx.env, encoding: "utf8" });
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, /^usage: repo-sweep\.mjs/);
    }
  });
});

describe("--apply", () => {
  let fx;
  before(() => {
    fx = buildLifecycleRepo();
  });
  after(() => fx.cleanup());

  test("deletes and archives exactly what the dry run said, and logs a restore for each", () => {
    const planned = report(fx);
    const rep = report(fx, ["--apply"]);
    assert.equal(rep.apply, true);
    const done = (kind) => rep.items.filter((i) => i.kind === kind && i.done === true).map((i) => i.name).sort();
    const want = (kind, table) => Object.entries(table).filter(([, v]) => v === "delete" || v === "archive").map(([k]) => k).sort();
    const archived = ["never-pushed-8d", "private-name"]; // never-pushed-leak keeps: the scan found a finding
    assert.deepEqual(done("local-branch"), want("local-branch", fx.expected.local).filter((n) => n !== "never-pushed-leak"));
    assert.deepEqual(done("remote-branch"), want("remote-branch", fx.expected.remote));
    assert.deepEqual(done("archive-ref"), [fx.archives.old]);
    assert.deepEqual(done("stash"), ["stash@{1}"]);
    assert.deepEqual(planned.items.map((i) => i.name), rep.items.map((i) => i.name));

    assert.deepEqual(branches(fx), ["dirty-wt", "draft-fresh", "fresh", "main", "never-pushed-2d", "never-pushed-leak", "pushed-unpushed"]);
    const wanted = originHeads(fx).filter((n) => ["closed-8d", "merged-still-there", "landed-p1", "landed-p2"].includes(n));
    assert.deepEqual(wanted, ["landed-p1", "landed-p2"], "no PR on the default scope: listed, kept on origin");
    assert.ok(!existsSync(fx.trees.idle) && !existsSync(fx.trees.readonly), "worktrees removed, read-only files included");
    assert.ok(existsSync(fx.trees.dirty) && existsSync(fx.trees.fresh));
    assert.deepEqual(originArchives(fx), [
      ...archived.map((n) => `refs/archive/${n}/${ymd(fx.now)}-${fx.tips[n].slice(0, 12)}`),
      `refs/archive/recent-work/${ymd(fx.now - 10 * 86400)}-${fx.base.slice(0, 12)}`,
      `refs/archive/stash/${ymd(fx.now)}-${fx.gitIn(fx.origin, "for-each-ref", "--format=%(objectname)", "refs/archive/stash").slice(0, 12)}`,
    ].sort());
    assert.equal(fx.gitIn(fx.clone, "stash", "list").split("\n").length, 1);

    const log = logLines(fx);
    const kinds = (k) => log.filter((l) => l.kind === k).map((l) => l.name).sort();
    assert.deepEqual(kinds("remove-worktree"), ["draft-idle", "ro-wt"]);
    assert.equal(kinds("delete-branch").length, 7);
    assert.deepEqual(kinds("archive-branch"), archived);
    assert.deepEqual(kinds("archive-stash"), ["stash@{1}"]);
    assert.equal(kinds("expire-archive").length, 1);
    for (const line of log) {
      assert.deepEqual(Object.keys(line).sort(), ["kind", "name", "oid", "reason", "restore", "time"]);
      assert.match(line.restore, /^git (fetch|push) origin /);
    }
    const last = JSON.parse(readFileSync(join(fx.clone, ".git", "sweep", "last.json"), "utf8"));
    assert.equal(last.summary, rep.summary);
    assert.equal(last.log, rep.log);
    assert.match(last.summary, /removed 5 local branches, 2 worktrees; archived 3; deleted 2 stale remote branches; expired 1 archive/);
  });

  test("a scan finding keeps the branch local and listed with the reason", () => {
    const leak = report(fx).items.find((i) => i.name === "never-pushed-leak");
    assert.equal(leak.verdict, "archive");
    assert.ok(branches(fx).includes("never-pushed-leak"));
    assert.equal(originArchives(fx).filter((r) => r.includes("never-pushed-leak")).length, 0);
    const rep = report(fx, ["--apply"]);
    const kept = rep.items.find((i) => i.name === "never-pushed-leak");
    assert.equal(kept.verdict, "list");
    assert.match(kept.note, /secret scan reported a finding: kept local/);
  });

  test("restore commands bring back a deleted and an archived branch from origin", () => {
    const log = logLines(fx);
    for (const name of ["squash-merged", "worker-in-merged", "never-pushed-8d"]) {
      const line = log.find((l) => l.kind === "delete-branch" && l.name === name);
      const [fetch, branch] = line.restore.split(" && ");
      fx.git(...fetch.split(" ").slice(1));
      fx.git(...branch.split(" ").slice(1));
      assert.equal(fx.git("rev-parse", name), line.oid, name);
    }
  });

  test("--apply never removes the unregistered dirs, and prints them with the owner's command", () => {
    const r = sweep(fx, ["--apply"]);
    assert.match(r.out, /^unregistered .*orphan \(.*\): the owner runs /m);
    for (const orphan of fx.orphans) assert.ok(existsSync(orphan), orphan);
  });
});

// Each case builds its own fixture, so they run in parallel.
describe("safety", { concurrency: true }, () => {
  test("compare-and-delete keeps a local branch and a remote branch that moved mid-run", () => {
    const fx = buildLifecycleRepo();
    try {
      const once = join(fx.root, "once");
      const rep = report(fx, ["--apply"], {
        STUB_ONCE: once,
        STUB_ORIGIN: fx.origin,
        STUB_MOVE_LOCAL: `refs/heads/pushed-synced=${fx.base}`,
        STUB_MOVE_ORIGIN: `refs/heads/closed-8d=${fx.base}`,
      });
      assert.equal(fx.git("rev-parse", "pushed-synced"), fx.base, "the moved local branch is still there");
      assert.equal(fx.gitIn(fx.origin, "rev-parse", "refs/heads/closed-8d"), fx.base, "the moved remote branch is still there");
      const moved = logLines(fx).filter((l) => l.kind === "moved").map((l) => l.name).sort();
      assert.deepEqual(moved, ["closed-8d", "pushed-synced"]);
      for (const name of ["pushed-synced", "closed-8d"]) {
        const item = rep.items.find((i) => i.name === name && i.verdict === "delete");
        assert.equal(item.done, false);
        assert.match(item.note, /moved/);
      }
      assert.ok(!branches(fx).includes("squash-merged"), "the rest still goes");
    } finally {
      fx.cleanup();
    }
  });

  test("archives are verified on origin, scanned over the commits origin lacks, and a missing gitleaks keeps them local", () => {
    const fx = buildLifecycleRepo();
    try {
      const gone = join(fx.root, "no-such-gitleaks");
      const missing = report(fx, ["--apply"], { SWEEP_GITLEAKS: gone });
      for (const name of ["never-pushed-8d", "private-name", "never-pushed-leak"]) {
        assert.ok(branches(fx).includes(name), name);
        assert.match(missing.items.find((i) => i.name === name).note, /secret scan unavailable|secret scan failed/);
      }
      assert.equal(originArchives(fx).filter((r) => !r.startsWith("refs/archive/recent-work")).length, 0);

      const config = join(fx.root, "private.toml");
      writeFileSync(config, "PRIVATE-NAME-X\n");
      const publicRun = report(fx, ["--apply"], { SWEEP_GH_VISIBILITY: "public", GITLEAKS_PRIVATE_CONFIG: config });
      assert.match(publicRun.items.find((i) => i.name === "private-name").note, /private-name scan reported a finding/);
      assert.ok(branches(fx).includes("private-name"));
      assert.ok(!branches(fx).includes("never-pushed-8d"));
      const ref = originArchives(fx).find((r) => r.includes("never-pushed-8d"));
      assert.equal(fx.gitIn(fx.origin, "rev-parse", ref), fx.tips["never-pushed-8d"], "verified on origin");

      const privateRun = report(fx, ["--apply"], { SWEEP_GH_VISIBILITY: "private", GITLEAKS_PRIVATE_CONFIG: config });
      assert.ok(!branches(fx).includes("private-name"), "a private repo skips the private-name pass");
      assert.ok(privateRun.items.some((i) => i.name === "private-name" && i.done === true));

      const calls = readFileSync(fx.env.STUB_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(calls.every((c) => c.range.endsWith(" --not --remotes=origin")));
      assert.ok(calls.some((c) => c.config === config));
      assert.ok(calls.some((c) => c.config === null));
    } finally {
      fx.cleanup();
    }
  });

  test("a worktree with uncommitted changes is never removed", () => {
    const fx = buildLifecycleRepo();
    try {
      writeFileSync(join(fx.trees.idle, "new-work.txt"), "work\n");
      const rep = report(fx, ["--apply"]);
      assert.ok(existsSync(fx.trees.idle));
      assert.ok(branches(fx).includes("draft-idle"));
      assert.equal(rep.items.find((i) => i.name === "draft-idle").verdict, "list");
    } finally {
      fx.cleanup();
    }
  });
});

describe("--auto", { concurrency: true }, () => {
  test("runs once a day under a lock, prints one summary line and records state", () => {
    const fx = buildLifecycleRepo();
    try {
      const sweepDir = join(fx.clone, ".git", "sweep");
      const first = sweep(fx, ["--auto"]);
      assert.equal(first.code, 0);
      assert.equal(first.out.trim().split("\n").length, 1);
      assert.match(first.out.trim(), /^sweep: removed .*; log .*log\.jsonl$/);
      assert.ok(existsSync(join(sweepDir, "stamp")) && existsSync(join(sweepDir, "last.json")));
      assert.ok(!existsSync(join(sweepDir, "lock")), "the lock is released");
      assert.ok(!branches(fx).includes("pushed-synced"), "--auto implies --apply");

      const again = sweep(fx, ["--auto"]);
      assert.deepEqual([again.code, again.out, again.err], [0, "", ""]);

      const later = { SWEEP_NOW: String(fx.now + 25 * 3600) };
      mkdirSync(join(sweepDir, "lock"));
      utimesSync(join(sweepDir, "lock"), fx.now + 25 * 3600, fx.now + 25 * 3600);
      const locked = sweep(fx, ["--auto"], later);
      assert.deepEqual([locked.code, locked.out], [0, ""]);
      assert.ok(existsSync(join(sweepDir, "lock")), "another run's lock stays");

      const old = fx.now + 23 * 3600;
      utimesSync(join(sweepDir, "lock"), old, old);
      const stale = sweep(fx, ["--auto"], later);
      assert.equal(stale.code, 0);
      assert.match(stale.out, /^sweep: /);
      assert.ok(!existsSync(join(sweepDir, "lock")));
    } finally {
      fx.cleanup();
    }
  });

  test("offline, it removes only local branches that a remote-tracking ref already holds", () => {
    const fx = buildLifecycleRepo();
    try {
      fx.git("remote", "set-url", "origin", join(fx.root, "no-such-origin.git"));
      const r = sweep(fx, ["--auto"]);
      assert.equal(r.code, 0);
      assert.equal(r.out.trim().split("\n").length, 1);
      assert.deepEqual(branches(fx).filter((b) => ["pushed-synced", "ro-wt", "draft-idle"].includes(b)), []);
      for (const kept of ["squash-merged", "worker-in-merged", "never-pushed-8d", "never-pushed-2d"]) {
        assert.ok(branches(fx).includes(kept), kept);
      }
      assert.equal(originArchives(fx).length, 2, "nothing archived or expired offline");
      assert.equal(originHeads(fx).includes("closed-8d"), true);
    } finally {
      fx.cleanup();
    }
  });

  test("exits 0 and stays quiet on every failure, while a plain run reports it", () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-none-"));
    try {
      const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args, "--repo", dir], { encoding: "utf8" });
      const auto = run(["--auto"]);
      assert.deepEqual([auto.status, auto.stdout, auto.stderr], [0, "", ""]);
      const plain = run([]);
      assert.equal(plain.status, 1);
      assert.match(plain.stderr, /not a git repository/);
    } finally {
      removeTree(dir);
    }
  });
});

// Review findings (PR #420, rounds 1 and 2): each case states the safe behaviour the sweep must keep; a `todo` one is
// x-failing until the sweep is fixed.
describe("review findings", () => {
  const DAY = 86400;
  let fx;
  let planned;
  let applied;
  let secretStash;
  let reusedTip;
  before(() => {
    fx = buildLifecycleRepo();
    const dated = (seconds) => {
      const date = `${String(fx.now - seconds)} +0000`;
      return { ...fx.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    };
    const gitAt = (seconds, ...args) => {
      const r = spawnSync("git", args, { cwd: fx.clone, env: dated(seconds), encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    // 1. A 9-day-old stash whose secret sits in an unstaged change (the usual stash): only the stash's merge commit
    //    holds it, and `git log -p` (so gitleaks git, and the stub that mirrors it) shows no diff for a merge commit.
    writeFileSync(join(fx.clone, "f.txt"), `${readFileSync(join(fx.clone, "f.txt"), "utf8")}${fx.env.STUB_MARKER}\n`);
    gitAt(9 * DAY, "stash", "push", "-q", "-m", "secret-in-worktree");
    secretStash = fx.git("rev-parse", "stash@{0}");
    // 2. An ignored local secret in a clean, idle, pushed worktree (draft-idle is removed by --apply).
    mkdirSync(join(fx.clone, ".git", "info"), { recursive: true });
    writeFileSync(join(fx.clone, ".git", "info", "exclude"), ".env\ncerts/\n");
    const env = join(fx.trees.idle, ".env");
    writeFileSync(env, "TOKEN=local-only\n");
    utimesSync(env, fx.now - 3 * DAY, fx.now - 3 * DAY);
    // 5. (round 2) The same in an ignored directory: `git status --ignored` names only `certs/`, not the key in it
    //    (ro-wt is removed by --apply).
    const certs = join(fx.trees.readonly, "certs");
    mkdirSync(certs);
    writeFileSync(join(certs, "server.key"), "local-only\n");
    for (const p of [join(certs, "server.key"), certs]) utimesSync(p, fx.now - 3 * DAY, fx.now - 3 * DAY);
    // 3. A branch name reused after its PR closed: new commits on origin that no PR ever had.
    gitAt(8 * DAY, "checkout", "-q", "-b", "reuse", fx.tips["closed-8d"]);
    writeFileSync(join(fx.clone, "reuse.txt"), "work after the PR closed\n");
    gitAt(8 * DAY, "add", "-A");
    gitAt(8 * DAY, "commit", "-q", "-m", "new work on a reused name");
    reusedTip = fx.git("rev-parse", "HEAD");
    gitAt(0, "push", "-q", "origin", "reuse:closed-8d");
    gitAt(0, "checkout", "-q", "main");
    gitAt(0, "branch", "-q", "-D", "reuse");
    // 4. A long-lived branch nobody opened a PR from (an environment branch behind main), on the default scope.
    gitAt(0, "push", "-q", "origin", `${fx.base}:refs/heads/staging`);
    gitAt(0, "fetch", "-q", "--prune", "origin");
    planned = report(fx);
    applied = report(fx, ["--apply"]);
  });
  after(() => fx.cleanup());

  test(
    "a stash whose secret is only in its unstaged changes is never pushed to an archive ref",
    () => {
      const item = applied.items.find((i) => i.kind === "stash" && i.oid === secretStash);
      assert.ok(item, "the stash was classified");
      assert.notEqual(item.done, true, "the stash was archived to origin with the secret in it");
      const leaked = spawnSync("git", ["-C", fx.origin, "grep", "-q", fx.env.STUB_MARKER, secretStash], {
        encoding: "utf8",
      });
      assert.notEqual(leaked.status, 0, "origin now holds the secret");
    },
  );

  test(
    "a worktree holding an ignored local file (.env) is not removed",
    () => {
      assert.ok(existsSync(join(fx.trees.idle, ".env")), "the ignored .env was deleted with the worktree");
    },
  );

  test(
    "a worktree holding a secret inside an ignored directory (certs/server.key) is not removed",
    () => {
      assert.ok(existsSync(join(fx.trees.readonly, "certs", "server.key")), "the ignored key was deleted with the worktree");
    },
  );

  test(
    "a remote branch whose tip is not the closed PR's head is not deleted as stale",
    () => {
      const item = planned.items.find((i) => i.kind === "remote-branch" && i.name === "closed-8d");
      assert.notEqual(item.verdict, "delete", item.reason);
      assert.equal(
        fx.gitIn(fx.origin, "rev-parse", "-q", "--verify", "refs/heads/closed-8d"),
        reusedTip,
        "the commits after the PR closed are gone from origin",
      );
    },
  );

  test(
    "on the default remote scope, a branch with no PR of the user is never deleted on origin",
    () => {
      const item = planned.items.find((i) => i.kind === "remote-branch" && i.name === "staging");
      assert.notEqual(item.verdict, "delete", item.reason);
    },
  );
});
