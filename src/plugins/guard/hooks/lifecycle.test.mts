import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  defaultRunner,
  lifecycleReminder,
  queueAgentNote,
  startSessionSweep,
  sweepNotice,
  takeAgentNotes,
} from "./lifecycle.mjs";
import type { LifecycleDeps, RunResult, Runner } from "./lifecycle.mjs";

const tmp = (): string => mkdtempSync(join(tmpdir(), "guard-lifecycle-"));
const NO_ENV = {};
const sh = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

// A repo with an origin that holds `main`; the clone sits on `main`.
function repo(): string {
  const root = tmp();
  const origin = join(root, "origin.git");
  mkdirSync(origin);
  sh(origin, "init", "--bare", "-b", "main");
  const work = join(root, "work");
  sh(root, "clone", origin, work);
  sh(work, "config", "user.email", "a@example.com");
  sh(work, "config", "user.name", "a");
  sh(work, "config", "commit.gpgsign", "false");
  writeFileSync(join(work, "a.txt"), "a\n");
  sh(work, "add", ".");
  sh(work, "commit", "-m", "init");
  sh(work, "push", "-u", "origin", "HEAD:main");
  sh(work, "fetch", "origin");
  sh(
    work,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  return work;
}

const commit = (work: string, file = "b.txt"): void => {
  writeFileSync(join(work, file), `${file}\n`);
  sh(work, "add", ".");
  sh(work, "commit", "-m", `add ${file}`);
};

// Real git, scripted gh.
const withGh =
  (gh: RunResult | "missing"): Runner =>
  (cmd, args, cwd, timeoutMs) =>
    cmd === "gh"
      ? gh === "missing"
        ? { status: null, stdout: "" }
        : gh
      : defaultRunner(cmd, args, cwd, timeoutMs);
const deps = (gh: RunResult | "missing"): { deps: LifecycleDeps } => ({
  deps: { run: withGh(gh) },
});
const NO_PR = { status: 0, stdout: "[]" };
const A_PR = { status: 0, stdout: '[{"number":7}]' };

void test("lifecycleReminder: a feature branch with unpushed commits is told to push", () => {
  const work = repo();
  sh(work, "switch", "-c", "feat/x");
  commit(work);
  const r = lifecycleReminder(work, NO_ENV, deps(NO_PR));
  assert.ok(r);
  assert.equal(
    r.message,
    "`feat/x` has 1 commit(s) origin does not have: push them (`github-workflow`, Branch lifecycle).",
  );
  assert.equal(r.key, `feat/x@${sh(work, "rev-parse", "HEAD")}`);
});

void test("lifecycleReminder: a pushed branch with no open PR is told to open a draft", () => {
  const work = repo();
  sh(work, "switch", "-c", "feat/x");
  commit(work);
  sh(work, "push", "-u", "origin", "feat/x");
  assert.equal(
    lifecycleReminder(work, NO_ENV, deps(NO_PR))?.message,
    "`feat/x` is pushed but has no PR: open a draft PR (`gh pr create --draft`).",
  );
  assert.equal(lifecycleReminder(work, NO_ENV, deps(A_PR)), null);
});

void test("lifecycleReminder: the default branch with local commits is told to push or move them", () => {
  const work = repo();
  commit(work);
  assert.equal(
    lifecycleReminder(work, NO_ENV, deps(NO_PR))?.message,
    "`main` has 1 local commit(s): push them where the repo allows direct commits; otherwise move them to a branch (`wt`).",
  );
  sh(work, "push", "origin", "main");
  assert.equal(lifecycleReminder(work, NO_ENV, deps(NO_PR)), null);
});

void test("lifecycleReminder: a clean unpushed branch with nothing new says nothing", () => {
  const work = repo();
  sh(work, "switch", "-c", "feat/empty");
  assert.equal(lifecycleReminder(work, NO_ENV, deps(NO_PR)), null);
});

void test("lifecycleReminder: detached HEAD, no origin and a plain directory say nothing", () => {
  const work = repo();
  commit(work);
  sh(work, "switch", "--detach");
  assert.equal(lifecycleReminder(work, NO_ENV, deps(NO_PR)), null);

  const lone = tmp();
  sh(lone, "init", "-b", "main");
  sh(lone, "config", "user.email", "a@example.com");
  sh(lone, "config", "user.name", "a");
  sh(lone, "commit", "--allow-empty", "-m", "init");
  assert.equal(lifecycleReminder(lone, NO_ENV, deps(NO_PR)), null);

  assert.equal(lifecycleReminder(tmp(), NO_ENV, deps(NO_PR)), null);
});

void test("lifecycleReminder: GUARD_LIFECYCLE=off, 0 or false silences it", () => {
  const work = repo();
  commit(work);
  for (const value of ["off", "0", "false", "OFF"])
    assert.equal(
      lifecycleReminder(work, { GUARD_LIFECYCLE: value }, deps(NO_PR)),
      null,
      value,
    );
});

for (const [type, want] of [
  ["worker", false],
  ["dev-tools:worker", false],
  ["scout", false],
  ["driver", true],
  ["dev-tools:driver", true],
  ["escalate", true],
  ["dev-tools:escalate", true],
] as const) {
  void test(`lifecycleReminder: agent type ${type} reminded=${String(want)}`, () => {
    const work = repo();
    commit(work);
    const r = lifecycleReminder(work, NO_ENV, {
      agentType: type,
      ...deps(NO_PR),
    });
    assert.equal(r !== null, want);
  });
}

void test("lifecycleReminder: a missing or failing gh and a bad answer yield nothing", () => {
  const work = repo();
  sh(work, "switch", "-c", "feat/x");
  commit(work);
  sh(work, "push", "-u", "origin", "feat/x");
  assert.equal(lifecycleReminder(work, NO_ENV, deps("missing")), null);
  assert.equal(
    lifecycleReminder(work, NO_ENV, deps({ status: 1, stdout: "" })),
    null,
  );
  assert.equal(
    lifecycleReminder(work, NO_ENV, deps({ status: 0, stdout: "not json" })),
    null,
  );
});

void test("lifecycleReminder: a git that throws yields nothing", () => {
  const boom: Runner = () => {
    throw new Error("spawn exploded");
  };
  assert.equal(lifecycleReminder(tmp(), NO_ENV, { deps: { run: boom } }), null);
});

// A scripted runner for the sweep: `git rev-parse` answers a main checkout (or a linked worktree) at `common`.
function fakeRepo(
  common: string,
  counts: { branches?: number; stashes?: number; worktrees?: number } = {},
  linked = false,
): Runner {
  return (_cmd, args) => {
    const line = args.join(" ");
    const ok = (stdout: string): RunResult => ({ status: 0, stdout });
    if (line.startsWith("rev-parse --path-format=absolute --git-dir")) {
      return ok(
        `${linked ? join(common, "worktrees", "w") : common}\n${common}\n`,
      );
    }
    if (line.startsWith("worktree list")) {
      return ok(
        Array.from(
          { length: counts.worktrees ?? 1 },
          (_, i) => `worktree /w/${String(i)}\nHEAD abc\n`,
        ).join("\n"),
      );
    }
    if (line.startsWith("for-each-ref")) {
      return ok(
        Array.from(
          { length: counts.branches ?? 1 },
          (_, i) => `refs/heads/b${String(i)}\n`,
        ).join(""),
      );
    }
    if (line === "stash list") {
      return ok(
        Array.from(
          { length: counts.stashes ?? 0 },
          (_, i) => `stash@{${String(i)}}: WIP\n`,
        ).join(""),
      );
    }
    return { status: 1, stdout: "" };
  };
}

interface SweepRun {
  calls: string[][];
  common: string;
}

function sweep(
  setup: {
    counts?: { branches?: number; stashes?: number; worktrees?: number };
    env?: Record<string, string>;
    linked?: boolean;
    registered?: boolean;
    script?: string | null;
    stampAgeMs?: number;
    throws?: boolean;
  } = {},
): SweepRun {
  const common = tmp();
  if (setup.stampAgeMs !== undefined) {
    mkdirSync(join(common, "sweep"));
    const stamp = join(common, "sweep", "stamp");
    writeFileSync(stamp, "");
    const at = new Date(Date.now() - setup.stampAgeMs);
    utimesSync(stamp, at, at);
  }
  const calls: string[][] = [];
  startSessionSweep({
    cwd: "/repo",
    env: setup.env ?? {},
    pluginRoot: "/plugins/guard",
    registered: setup.registered ?? false,
    deps: {
      run: fakeRepo(common, setup.counts, setup.linked),
      scriptFor: () =>
        setup.script === undefined ? "/sweep.mjs" : setup.script,
      spawnSweep: (script, repo) => {
        if (setup.throws) throw new Error("ENOENT");
        calls.push([script, repo]);
      },
    },
  });
  return { calls, common };
}

const HOUR = 60 * 60 * 1000;

void test("startSessionSweep: spawns the sweep when the stamp is missing or over a day old", () => {
  assert.deepEqual(sweep().calls, [["/sweep.mjs", "/repo"]]);
  assert.deepEqual(sweep({ stampAgeMs: 25 * HOUR }).calls, [
    ["/sweep.mjs", "/repo"],
  ]);
});

void test("startSessionSweep: skips a fresh stamp, GUARD_LIFECYCLE=off, a registered run and a linked worktree", () => {
  assert.deepEqual(sweep({ stampAgeMs: 2 * HOUR }).calls, []);
  for (const value of ["off", "0", "false"])
    assert.deepEqual(
      sweep({ env: { GUARD_LIFECYCLE: value } }).calls,
      [],
      value,
    );
  assert.deepEqual(sweep({ registered: true }).calls, []);
  assert.deepEqual(sweep({ linked: true }).calls, []);
});

void test("startSessionSweep: a missing script or a failed spawn writes the nudge only for a cluttered repo", () => {
  const calm = sweep({ script: null });
  assert.equal(existsSync(join(calm.common, "sweep", "nudge.json")), false);

  for (const counts of [{ worktrees: 11 }, { branches: 51 }, { stashes: 4 }]) {
    const r = sweep({ script: null, counts });
    assert.ok(
      existsSync(join(r.common, "sweep", "nudge.json")),
      JSON.stringify(counts),
    );
  }
  const failed = sweep({ throws: true, counts: { worktrees: 12, stashes: 1 } });
  const nudge = JSON.parse(
    readFileSync(join(failed.common, "sweep", "nudge.json"), "utf8"),
  ) as { text: string };
  assert.equal(
    nudge.text,
    "This repo has 12 worktrees, 1 branches, 1 stashes; run host-hygiene's repo-sweep (dry run) and show the owner",
  );
});

void test("startSessionSweep: exactly at the thresholds there is no nudge", () => {
  const r = sweep({
    script: null,
    counts: { worktrees: 10, branches: 50, stashes: 3 },
  });
  assert.equal(existsSync(join(r.common, "sweep", "nudge.json")), false);
});

void test("startSessionSweep: a git that throws is swallowed", () => {
  assert.doesNotThrow(() => {
    startSessionSweep({
      cwd: "/repo",
      env: {},
      pluginRoot: "/plugins/guard",
      registered: false,
      deps: {
        run: () => {
          throw new Error("boom");
        },
      },
    });
  });
});

void test("sweepNotice: the last sweep's summary once per time, then again for a new one", () => {
  const common = tmp();
  const run = fakeRepo(common);
  const d = { run };
  assert.equal(sweepNotice("/repo", NO_ENV, d), null);
  mkdirSync(join(common, "sweep"));
  const last = join(common, "sweep", "last.json");
  writeFileSync(
    last,
    JSON.stringify({ time: "t1", summary: "removed 3 worktrees", log: "/l" }),
  );
  assert.equal(sweepNotice("/repo", NO_ENV, d), "removed 3 worktrees");
  assert.equal(sweepNotice("/repo", NO_ENV, d), null);
  writeFileSync(
    last,
    JSON.stringify({ time: "t2", summary: "removed 1 branch", log: "/l" }),
  );
  assert.equal(sweepNotice("/repo", NO_ENV, d), "removed 1 branch");
  assert.equal(sweepNotice("/repo", NO_ENV, d), null);
  assert.equal(sweepNotice("/repo", { GUARD_LIFECYCLE: "off" }, d), null);
});

void test("sweepNotice: the nudge shows once per time", () => {
  const common = tmp();
  const d = { run: fakeRepo(common) };
  mkdirSync(join(common, "sweep"));
  writeFileSync(
    join(common, "sweep", "nudge.json"),
    JSON.stringify({ time: "n1", text: "This repo has 12 worktrees" }),
  );
  assert.equal(sweepNotice("/repo", NO_ENV, d), "This repo has 12 worktrees");
  assert.equal(sweepNotice("/repo", NO_ENV, d), null);
});

void test("sweepNotice: garbage files and a throwing git say nothing", () => {
  const common = tmp();
  mkdirSync(join(common, "sweep"));
  writeFileSync(join(common, "sweep", "last.json"), "{not json");
  assert.equal(sweepNotice("/repo", NO_ENV, { run: fakeRepo(common) }), null);
  assert.equal(
    sweepNotice("/repo", NO_ENV, {
      run: () => {
        throw new Error("boom");
      },
    }),
    null,
  );
});

void test("agent notes: queued per session, taken once, other sessions untouched", () => {
  const dir = tmp();
  assert.deepEqual(takeAgentNotes(dir, "s1"), []);
  queueAgentNote(dir, "s1", "push it");
  queueAgentNote(dir, "s1", "push it");
  queueAgentNote(dir, "s1", "open a PR");
  queueAgentNote(dir, "s2", "other");
  assert.deepEqual(takeAgentNotes(dir, "s1"), ["push it", "open a PR"]);
  assert.deepEqual(takeAgentNotes(dir, "s1"), []);
  assert.deepEqual(takeAgentNotes(dir, "s2"), ["other"]);
});

void test("agent notes: an unusable data dir and a session id with path characters never throw", () => {
  const file = join(tmp(), "afile");
  writeFileSync(file, "x");
  assert.doesNotThrow(() => {
    queueAgentNote(file, "s", "x");
  });
  assert.deepEqual(takeAgentNotes(file, "s"), []);
  const dir = tmp();
  queueAgentNote(dir, "../../etc/x", "n");
  assert.deepEqual(takeAgentNotes(dir, "../../etc/x"), ["n"]);
});
