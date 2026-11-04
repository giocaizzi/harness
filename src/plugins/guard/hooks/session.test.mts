import assert from "node:assert/strict";
import {
  type SpawnSyncReturns,
  execFileSync,
  spawnSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { harnessPid, keepAwake, keeperArgv } from "./awake.mjs";
import { lintFile } from "./lint.mjs";
import {
  fingerprint,
  gateFailClosed,
  resultGate,
  runDetached,
  stopCheck,
  takeLock,
} from "./stop.mjs";
import type { CheckerOpts, SyncRunner } from "./stop.mjs";
import type { HookInput } from "./types.mjs";

const tmp = (): string => mkdtempSync(join(tmpdir(), "guard-test-"));
const LINT_ROOT = fileURLToPath(new URL("./.lint-test/", import.meta.url));
const lintTmp = (): string => {
  mkdirSync(LINT_ROOT, { recursive: true });
  return mkdtempSync(join(LINT_ROOT, "x-"));
};
after(() => {
  rmSync(LINT_ROOT, { recursive: true, force: true });
});

delete process.env.GUARD_STOP_CHECK;
delete process.env.GUARD_STOP_TIMEOUT_MS;
for (const k of [
  "FACTORY_RUN_ID",
  "FACTORY_EVENTS_FILE",
  "GUARD_RUN_ID",
  "GUARD_RUN_MANIFEST",
  "GUARD_RUN_TICKET",
  "GUARD_RUN_MODE",
  "GUARD_RESULT_GATE",
]) {
  Reflect.deleteProperty(process.env, k);
}

const stopRun =
  (
    calls: string[],
    make: {
      status: number | null;
      stderr?: string;
      stdout?: string;
      error?: Error;
    },
    git: { status: number | null; stdout?: string } = {
      status: 0,
      stdout: "x",
    },
    targets: readonly string[] = ["check"],
  ): SyncRunner =>
  (cmd: string, args: readonly string[]) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git") {
      return {
        status: git.status,
        stdout: git.stdout ?? "",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      };
    }
    if (args[0] === "-n") {
      const match = targets.includes(args[1] ?? "");
      return {
        status: match ? 0 : 2,
        stdout: "",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      };
    }
    return {
      status: make.status,
      stdout: make.stdout ?? "",
      stderr: make.stderr ?? "",
      error: make.error,
      pid: 0,
      output: [],
      signal: null,
    };
  };

void test("stop: blocks once with the output tail when make check fails", async () => {
  const calls: string[] = [];
  const make = {
    status: 2,
    stdout: "ok\n".repeat(50) + "FAIL x\n",
    stderr: "",
  };
  const out = await stopCheck(
    { cwd: "/r" },
    stopRun(calls, make, { status: 2 }),
    { strain: () => null },
  );
  assert.ok(out);
  assert.equal(out.decision, "block");
  assert.match(out.reason ?? "", /make check failed[\s\S]*FAIL x$/);
  assert.deepEqual(out.hookSpecificOutput, {
    hookEventName: "Stop",
    decision: "block",
    reason: out.reason,
  });
  assert.ok((out.reason ?? "").split("\n").length <= 41);
  assert.deepEqual(
    calls.filter((c) => c.startsWith("make")),
    ["make -n check-fast", "make -n check", "make check"],
  );
});

void test("stop: a failure is reported with the failing target and its last line, scrubbed", async () => {
  const events: Record<string, unknown>[] = [];
  const make = {
    status: 2,
    stdout: "ok\n",
    stderr:
      "make[1]: *** [Makefile:3: test] Error 1\nAPI_TOKEN=supersecret leaked",
  };
  await stopCheck({ cwd: "/r" }, stopRun([], make, { status: 2 }), {
    strain: () => null,
    report: (e) => events.push(e),
  });
  assert.ok(events[0]);
  assert.equal(events[0].result, "fail");
  assert.equal(events[0].failed_target, "test");
  assert.equal(events[0].last_line, "API_TOKEN=*** leaked");
});

void test("stop: prefers make check-fast when the Makefile defines it", async () => {
  const calls: string[] = [];
  const make = { status: 2, stdout: "FAIL y\n", stderr: "" };
  const out = await stopCheck(
    { cwd: "/r" },
    stopRun(calls, make, { status: 2 }, ["check-fast", "check"]),
    { strain: () => null },
  );
  assert.match(out?.reason ?? "", /^make check-fast failed/);
  assert.deepEqual(
    calls.filter((c) => c.startsWith("make")),
    ["make -n check-fast", "make check-fast"],
  );
});

void test("stop: passes when stop_hook_active, no check target, no make, or green", async () => {
  process.env.CLAUDE_PLUGIN_DATA = tmp();
  try {
    const never: SyncRunner = () => {
      assert.fail("must not run");
    };
    assert.equal(await stopCheck({ stop_hook_active: true }, never), null);
    const failRunner: SyncRunner = () =>
      ({
        status: 2,
        stdout: "",
        stderr: "",
      }) as unknown as SpawnSyncReturns<string>;
    assert.equal(await stopCheck({}, failRunner), null);
    const errRunner: SyncRunner = () =>
      ({
        status: null,
        error: new Error("ENOENT"),
        stdout: "",
        stderr: "",
      }) as unknown as SpawnSyncReturns<string>;
    assert.equal(await stopCheck({}, errRunner), null);
    const okRunner: SyncRunner = () =>
      ({
        status: 0,
        stdout: "",
        stderr: "",
      }) as unknown as SpawnSyncReturns<string>;
    assert.equal(await stopCheck({}, okRunner, { strain: () => null }), null);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("stop: skips make check when the repo is unchanged since the last green run", async () => {
  const dir = tmp();
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    const calls: string[] = [];
    const run = stopRun(calls, { status: 0 });
    assert.equal(
      await stopCheck({ cwd: "/r" }, run, { strain: () => null }),
      null,
    );
    assert.equal(calls.filter((c) => c === "make check").length, 1);
    assert.equal(
      await stopCheck({ cwd: "/r" }, run, { strain: () => null }),
      null,
    );
    assert.equal(calls.filter((c) => c === "make check").length, 1);
    const changed = stopRun(calls, { status: 0 }, { status: 0, stdout: "y" });
    assert.equal(
      await stopCheck({ cwd: "/r" }, changed, { strain: () => null }),
      null,
    );
    assert.equal(calls.filter((c) => c === "make check").length, 2);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("stop: a strained host or a check already running in the repo defers it, and the next stop runs it", async () => {
  const dir = tmp();
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    const calls: string[] = [];
    const events: Record<string, unknown>[] = [];
    const report = (e: Record<string, unknown>) => events.push(e);
    const out = await stopCheck({ cwd: "/r" }, stopRun(calls, { status: 0 }), {
      strain: () => "load 45",
      report,
    });
    assert.match(
      out?.systemMessage ?? "",
      /make check deferred \(host strained: load 45\)/,
    );
    assert.equal(calls.filter((c) => c === "make check").length, 0);

    const busy = async (cmd: string, args: readonly string[]) => {
      const busyOut = await stopCheck(
        { cwd: "/r" },
        stopRun(calls, { status: 0 }),
        { strain: () => null, report },
      );
      assert.match(busyOut?.systemMessage ?? "", /another stop check/);
      const res = stopRun(calls, { status: 0 })(cmd, args);
      return {
        status: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
        timedOut: false,
      };
    };

    assert.equal(
      await stopCheck({ cwd: "/r" }, stopRun(calls, { status: 0 }), {
        exec: busy,
        strain: () => null,
        report,
      }),
      null,
    );
    assert.deepEqual(
      events.map((e) => e.result),
      ["deferred", "deferred", "pass"],
    );
    assert.equal(typeof events[2]?.duration_ms, "number");
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("stop: a timeout is deferred, not blocked, and never marks green", async () => {
  const dir = tmp();
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.GUARD_STOP_TIMEOUT_MS = "5000";
  try {
    const calls: string[] = [];
    const make = {
      status: null,
      error: Object.assign(new Error("spawnSync make ETIMEDOUT"), {
        code: "ETIMEDOUT",
      }),
    };
    const out = await stopCheck({ cwd: "/r" }, stopRun(calls, make), {
      strain: () => null,
    });
    assert.equal(out?.decision, undefined);
    assert.match(
      out?.systemMessage ?? "",
      /make check deferred \(did not finish within 5 s\)/,
    );
    await stopCheck({ cwd: "/r" }, stopRun(calls, { status: 0 }), {
      strain: () => null,
    });
    assert.equal(calls.filter((c) => c === "make check").length, 2);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.GUARD_STOP_TIMEOUT_MS;
  }
});

void test("stop: GUARD_STOP_CHECK=force runs it on a strained host", async () => {
  process.env.CLAUDE_PLUGIN_DATA = tmp();
  process.env.GUARD_STOP_CHECK = "force";
  try {
    const out = await stopCheck({ cwd: "/r" }, stopRun([], { status: 2 }), {
      strain: () => "load 45",
    });
    assert.equal(out?.decision, "block");
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.GUARD_STOP_CHECK;
  }
});

void test("stop: GUARD_STOP_CHECK=off disables it", async () => {
  process.env.GUARD_STOP_CHECK = "off";
  try {
    assert.equal(
      await stopCheck({}, () => {
        assert.fail("must not run");
      }),
      null,
    );
  } finally {
    delete process.env.GUARD_STOP_CHECK;
  }
});

// The result gate. A registered run needs a trusted manifest: written to its own temp dir and made out of reach
// through the PrepareOptions probes (OUT_OF_REACH), as hooks/registration.test.mts does.
const TEMPLATE = ".acme/runs/{ticket_number}/result.json";
const RESULT_REL = ".acme/runs/12/result.json";
const posix = process.platform === "win32" ? { skip: "no posix" } : {};

const gateRepo = (result?: unknown, rel: string = RESULT_REL): string => {
  const repo = tmp();
  execFileSync("git", ["init", "-q", repo]);
  if (result !== undefined) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(
      join(repo, rel),
      typeof result === "string" ? result : JSON.stringify(result),
    );
  }
  process.env.CLAUDE_PLUGIN_DATA = tmp();
  return repo;
};

const validResult = (over: Record<string, unknown> = {}) => ({
  schema: 2,
  ticket: "acme/app#12",
  run_id: "run-1",
  end_state: "done",
  reason: "",
  reason_code: null,
  phases: [
    {
      name: "gate",
      started_at: "2026-10-25T10:00:00Z",
      ended_at: "2026-10-25T10:01:00Z",
    },
  ],
  finished_at: "2026-10-25T10:02:00Z",
  ...over,
});

const OUT_OF_REACH = {
  writable: () => false,
  owner: () => false,
  readOnlyMount: () => false,
};
const manifest = (
  result: Record<string, unknown> | null = { file: TEMPLATE },
): string => {
  const p = join(tmp(), "run.json");
  writeFileSync(
    p,
    JSON.stringify({
      contract: 2,
      runner: "acme-runner",
      requires: result ? ["result-gate"] : [],
      ...(result ? { result } : {}),
    }),
  );
  return p;
};
const envFor = (
  m: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  GUARD_RUN_MANIFEST: m,
  GUARD_RUN_ID: "run-1",
  GUARD_RUN_TICKET: "acme/app#12",
  ...extra,
});
const RUNTIME = envFor(manifest());
const ATTENDED = { ...RUNTIME, GUARD_RUN_MODE: "attended" };

const gate = (
  input: HookInput,
  env: NodeJS.ProcessEnv,
  run?: SyncRunner,
  onEvent?: (attrs: Record<string, unknown>) => void,
  opts: CheckerOpts = {},
): Promise<string | null> =>
  resultGate(input, run, env, onEvent, {
    ...OUT_OF_REACH,
    dataDir: process.env.CLAUDE_PLUGIN_DATA,
    ...opts,
  });
const gitFails: SyncRunner = () =>
  ({
    status: 128,
    stdout: "",
    stderr: "",
  }) as unknown as SpawnSyncReturns<string>;

// A checker module written into its own temp dir, and a registration that names it.
const checkerFile = (body: string): string => {
  const p = join(tmp(), "checker.mjs");
  writeFileSync(p, body);
  return p;
};
const passes = "export const resultErrors = () => []";
const strictEnv = (
  checker: string,
  extra: Record<string, string> = {},
): Record<string, string> =>
  envFor(manifest({ file: TEMPLATE, checker }), extra);
const STRICT = strictEnv(checkerFile(passes));

void test("result gate: an unattended run with no result file is blocked twice, then may stop", async () => {
  const cwd = gateRepo();
  try {
    const first = await gate({ cwd }, RUNTIME);
    assert.match(
      first ?? "",
      /^Run result gate \(block 1 of 2\): .*result\.json is not a valid result for run run-1:\nno such file\n/,
    );
    assert.match(
      first ?? "",
      /\nFix the result file until it passes the core check\.\nA subagent ignores this and ends its turn: the main session writes the file\.$/,
    );
    assert.doesNotMatch(first ?? "", /factory|write-result|FACTORY_/i);
    const events: Record<string, unknown>[] = [];
    assert.match(
      (await gate({ cwd, stop_hook_active: true }, RUNTIME, undefined, (e) =>
        events.push(e),
      )) ?? "",
      /block 2 of 2/,
    );
    assert.equal(
      await gate({ cwd }, RUNTIME, undefined, (e) => events.push(e)),
      null,
    );
    assert.deepEqual(events, [
      {
        result: "block",
        target: "result-gate",
        mode: "unattended",
        blocks: 2,
      },
      { result: "capped", target: "result-gate", mode: "unattended" },
    ]);
    assert.match(
      (await gate({ cwd }, { ...RUNTIME, GUARD_RUN_ID: "run-2" })) ?? "",
      /block 1 of 2/,
    );
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: an unattended run's invalid result, broken JSON, another run's or ticket's file blocks with the errors; a valid one passes", async () => {
  try {
    assert.match(
      (await gate({ cwd: gateRepo(validResult({ ticket: 12 })) }, RUNTIME)) ??
        "",
      /ticket must be a string of the form/,
    );
    assert.match(
      (await gate({ cwd: gateRepo('{"schema": 2,') }, RUNTIME)) ?? "",
      /not valid JSON/,
    );
    assert.match(
      (await gate(
        { cwd: gateRepo(validResult({ run_id: "run-0" })) },
        RUNTIME,
      )) ?? "",
      /run_id "run-0" differs from GUARD_RUN_ID "run-1"/,
    );
    assert.match(
      (await gate(
        { cwd: gateRepo(validResult({ ticket: "acme/app#13" })) },
        RUNTIME,
      )) ?? "",
      /ticket "acme\/app#13" differs from GUARD_RUN_TICKET "acme\/app#12"/,
    );
    assert.equal(await gate({ cwd: gateRepo(validResult()) }, RUNTIME), null);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: the manifest's hint replaces the default one, and strict has its own default", async () => {
  try {
    const hint = "Write it with `acme-write`, then run `acme-verify`.";
    const out = await gate(
      { cwd: gateRepo() },
      envFor(manifest({ file: TEMPLATE, hint })),
    );
    assert.match(
      out ?? "",
      /\nno such file\nWrite it with `acme-write`, then run `acme-verify`\.\nA subagent ignores this/,
    );
    assert.doesNotMatch(out ?? "", /Fix the result file/);
    const strict = await gate({ cwd: gateRepo() }, STRICT);
    assert.match(
      strict ?? "",
      /\nFix the result file until it passes the core check and the runner's checker; never edit the checker\.\nA subagent/,
    );
    const strictHint = await gate(
      { cwd: gateRepo() },
      envFor(manifest({ file: TEMPLATE, hint, checker: checkerFile(passes) })),
    );
    assert.match(strictHint ?? "", /\nWrite it with `acme-write`/);
    assert.doesNotMatch(strictHint ?? "", /never edit the checker/);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: a result.file with {run_id} only works without GUARD_RUN_TICKET, and compares no ticket", async () => {
  try {
    const env: Record<string, string | undefined> = envFor(
      manifest({ file: ".acme/runs/{run_id}/result.json" }),
    );
    delete env.GUARD_RUN_TICKET;
    const rel = ".acme/runs/run-1/result.json";
    const other = validResult({ ticket: "acme/app#99" });
    assert.equal(await gate({ cwd: gateRepo(other, rel) }, env), null);
    assert.match(
      (await gate({ cwd: gateRepo(undefined, rel) }, env)) ?? "",
      /\.acme\/runs\/run-1\/result\.json is not a valid result[\s\S]*no such file/,
    );
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: an attended run is held only to an invalid file carrying its own run id", async () => {
  try {
    assert.equal(await gate({ cwd: gateRepo() }, ATTENDED), null);
    assert.equal(await gate({ cwd: gateRepo("not json") }, ATTENDED), null);
    assert.equal(
      await gate(
        { cwd: gateRepo(validResult({ run_id: "other", ticket: 12 })) },
        ATTENDED,
      ),
      null,
    );
    assert.equal(await gate({ cwd: gateRepo(validResult()) }, ATTENDED), null);
    const events: Record<string, unknown>[] = [];
    assert.match(
      (await gate(
        { cwd: gateRepo(validResult({ ticket: 12 })) },
        ATTENDED,
        undefined,
        (e) => events.push(e),
      )) ?? "",
      /block 1 of 2[\s\S]*ticket must be a string/,
    );
    assert.deepEqual(events, [
      { result: "block", target: "result-gate", mode: "attended", blocks: 1 },
    ]);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: off, a subagent, no run or a registration without a result pass; an attended run passes without a git checkout", async () => {
  try {
    const cwd = gateRepo();
    assert.equal(
      await gate({ cwd }, { ...RUNTIME, GUARD_RESULT_GATE: "off" }),
      null,
    );
    assert.equal(await gate({ cwd, agent_id: "a1" }, RUNTIME), null);
    assert.equal(
      await gate({ cwd, hook_event_name: "SubagentStop" }, RUNTIME),
      null,
    );
    assert.equal(await gate({ cwd }, {}), null);
    assert.equal(await gate({ cwd }, envFor(manifest(null))), null);
    assert.equal(await gate({ cwd }, ATTENDED, gitFails), null);
    const events: Record<string, unknown>[] = [];
    const assertFail: SyncRunner = () => {
      assert.fail("an attended gate error fails open");
    };
    assert.equal(
      await gate({ cwd }, ATTENDED, assertFail, (e) => events.push(e)),
      null,
    );
    assert.deepEqual(
      events.map((e) => [e.result, e.target]),
      [["error", "result-gate"]],
    );
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

const UNATTENDED_BLOCK =
  /^Run result gate: could not check the result for run run-1 \((.*)\); an unattended run never fails open, so the stop stays blocked\.$/;

void test("result gate: an unattended run never fails open on a missing checkout or a throwing runner", async () => {
  try {
    const cwd = gateRepo();
    const gitOut = await gate({ cwd }, RUNTIME, gitFails);
    assert.match(gitOut ?? "", UNATTENDED_BLOCK);
    assert.match(gitOut ?? "", /git rev-parse failed/);
    const events: Record<string, unknown>[] = [];
    const throwing: SyncRunner = () => {
      throw new Error("spawn failed token=abc123");
    };
    const out = await gate({ cwd }, RUNTIME, throwing, (e) => events.push(e));
    assert.match(out ?? "", UNATTENDED_BLOCK);
    assert.match(out ?? "", /token=\*\*\*/);
    assert.deepEqual(
      events.map((e) => [e.result, e.target]),
      [["error", "result-gate"]],
    );
    // these blocks are not counted: the cap still allows two result blocks
    assert.match((await gate({ cwd }, RUNTIME)) ?? "", /block 1 of 2/);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

// A result file path that leaves the repo or lands in .git or .github is a gate error: an unattended run stays blocked.
void test(
  "result gate: a result file path through a symlink outside the repo or into .git or .github blocks an unattended run",
  posix,
  async () => {
    try {
      const outside = tmp();
      const out = gateRepo();
      symlinkSync(outside, join(out, ".acme"));
      const outOut = await gate({ cwd: out }, RUNTIME);
      assert.match(outOut ?? "", UNATTENDED_BLOCK);
      assert.match(outOut ?? "", /result file resolves outside the repo/);
      assert.doesNotMatch(outOut ?? "", /block \d of 2/);
      assert.deepEqual(readdirSync(outside), []);
      // an attended gate error fails open
      assert.equal(await gate({ cwd: out }, ATTENDED), null);
      for (const name of [
        ".git",
        ".github",
        ".GIT",
        "GIT~1",
        "github~2",
        ".git.",
        ".git ",
        ".github. .",
      ]) {
        const repo = gateRepo();
        mkdirSync(join(repo, name), { recursive: true });
        symlinkSync(name, join(repo, ".acme"));
        assert.match(
          (await gate({ cwd: repo }, RUNTIME)) ?? "",
          /result file resolves under \.git or \.github/,
          name,
        );
      }
      // a symlink that stays inside the repo is followed
      const inside = gateRepo(validResult(), "real/runs/12/result.json");
      symlinkSync("real", join(inside, ".acme"));
      assert.equal(await gate({ cwd: inside }, RUNTIME), null);
    } finally {
      delete process.env.CLAUDE_PLUGIN_DATA;
    }
  },
);

// The block counter of run-1, where stop.mts keeps it.
const counterPath = (): string =>
  join(
    process.env.CLAUDE_PLUGIN_DATA ?? "",
    "result-gate",
    `${createHash("sha256").update("run-1").digest("hex").slice(0, 16)}.txt`,
  );
const plantCounter = (plant: (file: string) => void): string => {
  const cwd = gateRepo();
  const file = counterPath();
  mkdirSync(dirname(file), { recursive: true });
  plant(file);
  return cwd;
};
const mkfifo = (file: string): void => {
  assert.equal(spawnSync("mkfifo", [file]).status, 0);
};

void test("result gate: a counter set to 2 releases an unset unattended run (the unset trust model)", async () => {
  try {
    const cwd = plantCounter((f) => {
      writeFileSync(f, "2");
    });
    assert.equal(await gate({ cwd }, RUNTIME), null);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: a malformed, empty or oversized counter counts as 0, so the block is counted", async () => {
  try {
    for (const text of ["x", "-1", "1e3", "1".repeat(70), "", "1\n2"]) {
      const cwd = plantCounter((f) => {
        writeFileSync(f, text);
      });
      assert.match(
        (await gate({ cwd }, RUNTIME)) ?? "",
        /block 1 of 2/,
        JSON.stringify(text),
      );
      assert.equal(readFileSync(counterPath(), "utf8"), "1");
    }
    const cwd = plantCounter((f) => {
      writeFileSync(f, " 1\n");
    });
    assert.match((await gate({ cwd }, RUNTIME)) ?? "", /block 2 of 2/);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test(
  "result gate: a FIFO at the counter path is read without hanging, replaced by a regular file and counted",
  posix,
  async () => {
    try {
      const cwd = plantCounter(mkfifo);
      const started = Date.now();
      assert.match((await gate({ cwd }, RUNTIME)) ?? "", /block 1 of 2/);
      assert.ok(Date.now() - started < 5000);
      assert.ok(lstatSync(counterPath()).isFile());
      assert.equal(readFileSync(counterPath(), "utf8"), "1");
    } finally {
      delete process.env.CLAUDE_PLUGIN_DATA;
    }
  },
);

void test(
  "result gate: a symlink at the counter path is not followed: replaced, counted, its target untouched",
  posix,
  async () => {
    try {
      const target = join(tmp(), "target.txt");
      writeFileSync(target, "9");
      for (const to of [target, "/dev/null"]) {
        const cwd = plantCounter((f) => {
          symlinkSync(to, f);
        });
        assert.match((await gate({ cwd }, RUNTIME)) ?? "", /block 1 of 2/);
        assert.ok(lstatSync(counterPath()).isFile());
        assert.equal(readFileSync(counterPath(), "utf8"), "1");
      }
      assert.equal(readFileSync(target, "utf8"), "9");
    } finally {
      delete process.env.CLAUDE_PLUGIN_DATA;
    }
  },
);

void test("result gate: a hardlink at the counter path is replaced and counted, the other link untouched", async () => {
  try {
    const other = join(tmp(), "other.txt");
    writeFileSync(other, "9");
    const cwd = plantCounter((f) => {
      linkSync(other, f);
    });
    assert.match((await gate({ cwd }, RUNTIME)) ?? "", /block 1 of 2/);
    assert.equal(readFileSync(other, "utf8"), "9");
    assert.equal(readFileSync(counterPath(), "utf8"), "1");
    assert.equal(lstatSync(counterPath()).nlink, 1);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: a directory at the counter path fails the write: an unattended run blocks closed, an attended one goes", async () => {
  try {
    const cwd = plantCounter((f) => {
      mkdirSync(f);
    });
    const out = (await gate({ cwd }, RUNTIME)) ?? "";
    assert.match(out, UNATTENDED_BLOCK);
    assert.doesNotMatch(out, /block \d of 2/);
    assert.deepEqual(
      readdirSync(dirname(counterPath())).filter((n) => n.endsWith(".tmp")),
      [],
    );
    assert.equal(await gate({ cwd }, ATTENDED), null);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test(
  "result gate: an unwritable counter directory blocks an unattended run closed",
  {
    skip:
      process.platform === "win32" ||
      (process.getuid?.() ?? 1) === 0 ||
      undefined,
  },
  async () => {
    try {
      const cwd = plantCounter(() => {
        // the directory exists; only its mode changes
      });
      chmodSync(dirname(counterPath()), 0);
      try {
        assert.match((await gate({ cwd }, RUNTIME)) ?? "", UNATTENDED_BLOCK);
      } finally {
        chmodSync(dirname(counterPath()), 0o700);
      }
    } finally {
      delete process.env.CLAUDE_PLUGIN_DATA;
    }
  },
);

void test("result gate: strict mode is never capped whatever sits at the counter path, and replaces a FIFO or symlink", async () => {
  try {
    for (const [text, n] of [
      ["2", 3],
      ["garbage", 1],
      ["9".repeat(70), 1],
    ] as const) {
      const cwd = plantCounter((f) => {
        writeFileSync(f, text);
      });
      assert.match(
        (await gate({ cwd }, STRICT)) ?? "",
        new RegExp(
          `block ${String(n)}; the registration names a result checker`,
        ),
        text,
      );
    }
    if (process.platform !== "win32") {
      const cwd = plantCounter(mkfifo);
      assert.match((await gate({ cwd }, STRICT)) ?? "", /block 1; the reg/);
      assert.ok(lstatSync(counterPath()).isFile());
      assert.equal(readFileSync(counterPath(), "utf8"), "1");

      const target = join(tmp(), "target.txt");
      writeFileSync(target, "untouched");
      const linked = plantCounter((f) => {
        symlinkSync(target, f);
      });
      assert.match(
        (await gate({ cwd: linked }, STRICT)) ?? "",
        /block 1; the reg/,
      );
      assert.ok(lstatSync(counterPath()).isFile());
      assert.equal(readFileSync(target, "utf8"), "untouched");
    }
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: a failure in the gate's own failure path still blocks a run", () => {
  // the first read of the payload's session id throws: the fallback decides from the environment alone
  const flaky = (agentId?: string): HookInput => {
    let reads = 0;
    const input: HookInput = { agent_id: agentId };
    Object.defineProperty(input, "session_id", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads === 1) throw new Error("boom");
        return undefined;
      },
    });
    return input;
  };
  const internal =
    "Run result gate: could not check the result for this run (internal error); the stop stays blocked.";
  for (const env of [
    RUNTIME,
    { GUARD_RUN_ID: "r" },
    { GUARD_RUN_MANIFEST: "/m.json" },
    { FACTORY_RUN_ID: "r" },
  ]) {
    assert.equal(gateFailClosed(env, flaky(), "why"), internal);
  }
  assert.equal(gateFailClosed({}, flaky(), "why"), null);
  assert.equal(gateFailClosed(RUNTIME, flaky("a"), "why"), null);
});

void test("result gate: gateFailClosed blocks an unattended or strict run, and nothing else", () => {
  const opts = { ...OUT_OF_REACH, dataDir: tmp() };
  assert.match(
    gateFailClosed(RUNTIME, { cwd: "x" }, "x", opts) ?? "",
    UNATTENDED_BLOCK,
  );
  assert.match(
    gateFailClosed(STRICT, { cwd: "x" }, "x", opts) ?? "",
    /^Run result gate: could not check the result for run run-1 \(x\); the registration names a result checker, so the stop stays blocked\.$/,
  );
  assert.equal(gateFailClosed(ATTENDED, { cwd: "x" }, "x", opts), null);
  assert.equal(
    gateFailClosed({ ...RUNTIME, GUARD_RESULT_GATE: "off" }, {}, "x", opts),
    null,
  );
  assert.equal(gateFailClosed(envFor(manifest(null)), {}, "x", opts), null);
  assert.equal(gateFailClosed(RUNTIME, { agent_id: "a" }, "x", opts), null);
  assert.equal(gateFailClosed({}, {}, "x", opts), null);
  // a failed registration blocks whatever the switch says
  assert.match(
    gateFailClosed(
      { GUARD_RUN_ID: "r", GUARD_RESULT_GATE: "off" },
      {},
      "x",
      opts,
    ) ?? "",
    /^Run registration failed: GUARD_RUN_ID is set but GUARD_RUN_MANIFEST is not/,
  );
  // a payload that is not an object counts as an empty one
  for (const bad of [null, 5, [], "x"]) {
    assert.match(
      gateFailClosed(STRICT, bad as never, "x", opts) ?? "",
      /could not check the result for run run-1/,
    );
  }
});

const STOP_HOOK = fileURLToPath(new URL("./stop.mjs", import.meta.url));
// The emitted stop hook as a harness runs it: payload on stdin, one JSON object on stdout, exit 0. No FACTORY_ or
// GUARD_ variable but the ones passed leaks in.
const runStopHook = (
  payload: string,
  extraArgs: string[],
  env: Record<string, string>,
  nodeArgs: string[] = [],
) => {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith("FACTORY_") && !k.startsWith("GUARD_"),
    ),
  );
  return spawnSync(process.execPath, [...nodeArgs, STOP_HOOK, ...extraArgs], {
    input: payload,
    encoding: "utf8",
    env: {
      ...clean,
      GUARD_STOP_CHECK: "off",
      GUARD_OTEL: "off",
      GUARD_RUN_EVENTS_FILE: "",
      FACTORY_EVENTS_FILE: "",
      CLAUDE_PLUGIN_DATA: tmp(),
      ...env,
    },
  });
};

void test("result gate: the stop hook CLI blocks a run on an uncaught exception and exits 0, a run-less stop stays silent", () => {
  const dir = tmp();
  const preload = join(dir, "crash.mjs");
  writeFileSync(
    preload,
    'setTimeout(() => { throw new Error("boom"); }, 0);\n',
  );
  const cwd = gateRepo();
  delete process.env.CLAUDE_PLUGIN_DATA;
  const payload = JSON.stringify({ cwd, hook_event_name: "Stop" });
  const run = (env: Record<string, string>) =>
    runStopHook(payload, [], env, ["--import", pathToFileURL(preload).href]);
  const blocked = run({ GUARD_RUN_ID: "run-1" });
  assert.equal(blocked.status, 0, blocked.stderr);
  const out = JSON.parse(blocked.stdout) as Record<string, unknown>;
  assert.equal(out.decision, "block");
  assert.match(String(out.reason), /^Run registration failed/);
  const free = run({});
  assert.equal(free.status, 0, free.stderr);
  assert.equal(free.stdout, "");
});

void test("result gate: a crash after the gate answered does not block the stop", () => {
  const dir = tmp();
  const preload = join(dir, "flush.mjs");
  // the final flush throws: after the gate answered, outside every try
  writeFileSync(
    preload,
    'const w = process.stdout.write.bind(process.stdout);\nprocess.stdout.write = (c, ...a) => { if (c === "") throw new Error("boom"); return w(c, ...a); };\n',
  );
  const cwd = gateRepo();
  delete process.env.CLAUDE_PLUGIN_DATA;
  const r = runStopHook(
    JSON.stringify({ cwd, hook_event_name: "Stop" }),
    [],
    {},
    ["--import", pathToFileURL(preload).href],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

void test("result gate: a counter that cannot be written blocks an unattended run and lets an attended one go", async () => {
  try {
    const cwd = gateRepo(validResult({ ticket: 12 }));
    writeFileSync(
      join(process.env.CLAUDE_PLUGIN_DATA ?? "", "result-gate"),
      "",
    );
    assert.match((await gate({ cwd }, RUNTIME)) ?? "", UNATTENDED_BLOCK);
    assert.equal(await gate({ cwd }, ATTENDED), null);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

// stopCheck reads process.env, so a run is set there for these.
const withRunEnv = async (
  env: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> => {
  Object.assign(process.env, env);
  try {
    await fn();
  } finally {
    for (const k of Object.keys(env)) Reflect.deleteProperty(process.env, k);
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
};
const realGit =
  (make: () => SyncRunner): SyncRunner =>
  (cmd, args, opts) =>
    cmd === "make"
      ? make()(cmd, args)
      : (spawnSync(
          cmd,
          args as string[],
          opts as object,
        ) as unknown as SpawnSyncReturns<string>);

void test("result gate: runs before make check, and both reasons go in one block", async () => {
  const cwd = gateRepo();
  await withRunEnv(RUNTIME, async () => {
    const run = realGit(() =>
      stopRun([], { status: 2, stdout: "FAIL z\n" }, { status: 2 }),
    );
    const gateOpts = {
      ...OUT_OF_REACH,
      dataDir: process.env.CLAUDE_PLUGIN_DATA,
    };
    const events: Record<string, unknown>[] = [];
    const out = await stopCheck({ cwd }, run, {
      strain: () => null,
      report: (e) => events.push(e),
      gate: gateOpts,
    });
    assert.deepEqual(
      events.map((e) => `${String(e.target)}:${String(e.result)}`),
      ["result-gate:block", "check:fail"],
    );
    assert.ok(out);
    assert.equal(out.decision, "block");
    assert.match(
      out.reason ?? "",
      /^Run result gate \(block 1 of 2\)[\s\S]*\n\nmake check failed[\s\S]*FAIL z$/,
    );
    assert.deepEqual(out.hookSpecificOutput, {
      hookEventName: "Stop",
      decision: "block",
      reason: out.reason,
    });
    const activeOut = await stopCheck({ cwd, stop_hook_active: true }, run, {
      strain: () => null,
      gate: gateOpts,
    });
    assert.match(
      activeOut?.reason ?? "",
      /^Run result gate \(block 2 of 2\)[\s\S]*Fix the result file[\s\S]*\.$/,
    );
    assert.equal(
      await stopCheck({ cwd, stop_hook_active: true }, run, {
        strain: () => null,
        gate: gateOpts,
      }),
      null,
    );
  });
});

void test("result gate: a failing make check never denies a stop, whether or not the gate blocked", async () => {
  const cwd = gateRepo();
  await withRunEnv(RUNTIME, async () => {
    const run: SyncRunner = (cmd, args, opts) => {
      if (cmd === "make") throw new Error("make exploded");
      return spawnSync(
        cmd,
        args as string[],
        opts as object,
      ) as unknown as SpawnSyncReturns<string>;
    };
    const gateOpts = {
      ...OUT_OF_REACH,
      dataDir: process.env.CLAUDE_PLUGIN_DATA,
    };
    const out = await stopCheck({ cwd }, run, {
      strain: () => null,
      gate: gateOpts,
    });
    assert.equal(out?.decision, "block");
    assert.match(out.reason ?? "", /^Run result gate \(block 1 of 2\)/);
    // the gate passed: a later make error does not deny the stop
    const ok = gateRepo(validResult());
    assert.equal(
      await stopCheck({ cwd: ok }, run, { strain: () => null, gate: gateOpts }),
      null,
    );
    delete process.env.GUARD_RUN_ID;
    delete process.env.GUARD_RUN_MANIFEST;
    assert.equal(
      await stopCheck({ cwd }, run, { strain: () => null, gate: gateOpts }),
      null,
    );
  });
});

void test("result gate: a broken checker blocks with the reason, and the core errors stay", async () => {
  try {
    for (const [body, reason] of [
      ["throw new Error('at import')", /did not load \(at import\)/],
      ["export const other = 1", /exports no resultErrors function/],
      [
        "export const resultErrors = () => { throw new Error('boom') }",
        /threw \(boom\)/,
      ],
    ] as const) {
      const out = await gate(
        { cwd: gateRepo(validResult()) },
        strictEnv(checkerFile(body)),
      );
      assert.match(
        out ?? "",
        /block 1; the registration names a result checker/,
      );
      assert.match(out ?? "", /\(result\.checker\) could not run: /);
      assert.match(out ?? "", reason);
    }
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: a checker the trust checks refuse fails the registration, and the stop stays blocked", async () => {
  try {
    const env = strictEnv(checkerFile(passes));
    const refuseChecker = {
      writable: (t: string) => t.endsWith("checker.mjs"),
      owner: () => false,
    };
    for (const make of [() => gateRepo(validResult()), () => gateRepo()]) {
      const cwd = make();
      const out = await gate({ cwd }, env, undefined, undefined, refuseChecker);
      assert.match(
        out ?? "",
        /^Run registration failed: .*result\.checker .*writable by this user/,
      );
      assert.match(out ?? "", / \(block 1 of 2\)$/);
    }
    // the gate switch does not turn it off
    const off = await gate(
      { cwd: gateRepo(validResult()) },
      { ...env, GUARD_RESULT_GATE: "off" },
      undefined,
      undefined,
      refuseChecker,
    );
    assert.match(off ?? "", /^Run registration failed/);
    const missing = await gate(
      { cwd: gateRepo(validResult()) },
      strictEnv(join(tmp(), "missing.mjs")),
    );
    assert.match(missing ?? "", /^Run registration failed: .*no such file/);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: a vetted checker passes a valid result, adds its errors and cannot loosen the core", async () => {
  try {
    assert.equal(await gate({ cwd: gateRepo(validResult()) }, STRICT), null);
    const added = await gate(
      { cwd: gateRepo(validResult()) },
      strictEnv(checkerFile("export const resultErrors = () => ['custom']")),
    );
    assert.match(
      added ?? "",
      /block 1; the registration names a result checker[\s\S]*\ncustom\n/,
    );
    const loose = await gate(
      { cwd: gateRepo(validResult({ run_id: "other" })) },
      STRICT,
    );
    assert.match(
      loose ?? "",
      /run_id "other" differs from GUARD_RUN_ID "run-1"/,
    );
    const dup = await gate(
      { cwd: gateRepo(validResult({ end_state: "" })) },
      strictEnv(
        checkerFile(
          "export const resultErrors = () => ['end_state must be a non-empty string, got \"\"', 'custom', 'custom']",
        ),
      ),
    );
    assert.equal(
      (dup ?? "").split("\n").filter((l) => l.startsWith("end_state must"))
        .length,
      1,
    );
    assert.equal(
      (dup ?? "").split("\n").filter((l) => l === "custom").length,
      1,
    );
    const slow = await gate(
      { cwd: gateRepo(validResult()) },
      strictEnv(checkerFile("export const resultErrors = () => { for (;;); }")),
      undefined,
      undefined,
      { timeoutMs: 300 },
    );
    assert.match(slow ?? "", /could not run: timed out after 0\.3 s/);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: the checker gets the run's environment, GUARD_RUN_FILE resolved against the session's directory", async () => {
  try {
    const cwd = gateRepo(validResult());
    const checker = checkerFile(
      "export const resultErrors = (r, env) => [`id=${env.GUARD_RUN_ID} file=${env.GUARD_RUN_FILE}`]",
    );
    const out = await gate(
      { cwd },
      strictEnv(checker, { GUARD_RUN_FILE: "run.json" }),
    );
    assert.ok(
      (out ?? "").includes(`id=run-1 file=${join(cwd, "run.json")}`),
      out ?? "null",
    );
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: strict mode is never capped, unset is capped after two blocks", async () => {
  try {
    const events: Record<string, unknown>[] = [];
    const cwd = gateRepo();
    for (let i = 1; i <= 4; i++) {
      const out = await gate({ cwd }, STRICT, undefined, (e) => events.push(e));
      assert.ok(
        out?.startsWith(
          `Run result gate (block ${String(i)}; the registration names a result checker, so the stop stays blocked until the result passes)`,
        ),
        out ?? "null",
      );
    }
    assert.deepEqual(
      events.map((e) => e.result),
      ["block", "block", "block", "block"],
    );
    const plain = gateRepo();
    assert.ok(await gate({ cwd: plain }, RUNTIME));
    assert.ok(await gate({ cwd: plain }, RUNTIME));
    assert.equal(await gate({ cwd: plain }, RUNTIME), null);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: strict mode never fails open on an internal error", async () => {
  try {
    const cwd = gateRepo();
    const events: Record<string, unknown>[] = [];
    const throwing: SyncRunner = () => {
      throw new Error("spawn failed token=abc123");
    };
    const out = await gate({ cwd }, STRICT, throwing, (e) => events.push(e));
    assert.match(
      out ?? "",
      /^Run result gate: could not check the result for run run-1 \(spawn failed token=\*\*\*\); the registration names a result checker, so the stop stays blocked\.$/,
    );
    assert.deepEqual(
      events.map((e) => e.result),
      ["error"],
    );
    assert.match(
      (await gate({ cwd }, STRICT, gitFails)) ?? "",
      /could not check the result for run run-1 \(git rev-parse failed\)/,
    );
    // the counter cannot be written: a file where the data dir should be
    const blocked = gateRepo();
    writeFileSync(
      join(process.env.CLAUDE_PLUGIN_DATA ?? "", "result-gate"),
      "",
    );
    assert.match(
      (await gate({ cwd: blocked }, STRICT)) ?? "",
      /^Run result gate: could not check the result/,
    );
    // exempt stops stay free, and an attended run without a checker still fails open
    assert.equal(await gate({ cwd, agent_id: "a" }, STRICT, throwing), null);
    assert.equal(await gate({ cwd }, ATTENDED, throwing), null);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result check: a BOM and CRLF line ends in the result file are read", async () => {
  try {
    const text = `﻿${JSON.stringify(validResult(), null, 2).replace(/\n/g, "\r\n")}`;
    assert.equal(await gate({ cwd: gateRepo(text) }, RUNTIME), null);
    assert.equal(await gate({ cwd: gateRepo(text) }, STRICT), null);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: an attended run keeps its semantics when the registration names a checker", async () => {
  try {
    const env = { ...STRICT, GUARD_RUN_MODE: "attended" };
    assert.equal(await gate({ cwd: gateRepo() }, env), null);
    assert.equal(await gate({ cwd: gateRepo("not json") }, env), null);
    assert.equal(
      await gate(
        { cwd: gateRepo(validResult({ run_id: "other", ticket: 12 })) },
        env,
      ),
      null,
    );
    assert.equal(await gate({ cwd: gateRepo("[]") }, env), null);
    assert.equal(await gate({ cwd: gateRepo(validResult()) }, env), null);
    const out = await gate(
      { cwd: gateRepo(validResult({ ticket: 12 })) },
      strictEnv(checkerFile("export const resultErrors = () => ['custom']"), {
        GUARD_RUN_MODE: "attended",
      }),
    );
    assert.match(
      out ?? "",
      /block 1; the registration names a result checker[\s\S]*ticket must be a string[\s\S]*\ncustom\n/,
    );
    // strict: its own errors do not fail open
    assert.match(
      (await gate({ cwd: gateRepo() }, env, gitFails)) ?? "",
      /could not check the result for run run-1 \(git rev-parse failed\)/,
    );
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

// A result file the agent could plant: the gate must answer promptly with a block, never hang or read it.
const plantResult = (make: (file: string) => void): string => {
  const cwd = gateRepo();
  const file = join(cwd, RESULT_REL);
  mkdirSync(dirname(file), { recursive: true });
  make(file);
  return cwd;
};

void test(
  "result gate: a FIFO or a device at the result file is a read error, never a hang",
  { skip: process.platform === "win32", timeout: 30_000 },
  async () => {
    try {
      const fifo = plantResult(mkfifo);
      for (const env of [RUNTIME, STRICT]) {
        const started = Date.now();
        const out = await gate({ cwd: fifo }, env);
        assert.match(
          out ?? "",
          /result\.json is not a valid result[\s\S]*\nnot a regular file\n/,
        );
        assert.ok(Date.now() - started < 10_000);
      }
      // a symlink to /dev/zero resolves outside the repo: a gate error, not a read
      const zero = plantResult((f) => {
        symlinkSync("/dev/zero", f);
      });
      assert.match(
        (await gate({ cwd: zero }, RUNTIME)) ?? "",
        /result file resolves outside the repo/,
      );
    } finally {
      delete process.env.CLAUDE_PLUGIN_DATA;
    }
  },
);

void test("result gate: a result file over 1 MiB is blocked as too large, not read", async () => {
  try {
    const cwd = plantResult((f) => {
      writeFileSync(f, ` ${"x".repeat(1024 * 1024)}`);
    });
    for (const env of [RUNTIME, STRICT]) {
      assert.match(
        (await gate({ cwd }, env)) ?? "",
        /\ntoo large \(over 1 MiB\)\n/,
      );
    }
    // an attended run keeps returning null on any read failure
    assert.equal(await gate({ cwd }, ATTENDED), null);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: a failed registration blocks twice per session even with the gate off, then is capped; a changed manifest fails it", async () => {
  try {
    const cwd = gateRepo();
    const events: Record<string, unknown>[] = [];
    const why =
      "Run registration failed: GUARD_RUN_ID is set but GUARD_RUN_MANIFEST is not. Every tool call in this run is denied until the runner fixes its registration; stop and report it.";
    const offEnv = { GUARD_RUN_ID: "run-1", GUARD_RESULT_GATE: "off" };
    const first = { cwd, session_id: "s-reg-a" };
    const onEvent = (e: Record<string, unknown>): void => {
      events.push(e);
    };
    assert.equal(
      await gate(first, offEnv, undefined, onEvent),
      `${why} (block 1 of 2)`,
    );
    assert.equal(
      await gate(first, offEnv, undefined, onEvent),
      `${why} (block 2 of 2)`,
    );
    assert.equal(await gate(first, offEnv, undefined, onEvent), null);
    assert.deepEqual(events, [
      {
        result: "registration",
        target: "result-gate",
        rule: "run-registration",
        blocks: 1,
      },
      {
        result: "registration",
        target: "result-gate",
        rule: "run-registration",
        blocks: 2,
      },
      { result: "capped", target: "result-gate", rule: "run-registration" },
    ]);
    // another session starts again
    assert.match(
      (await gate({ cwd, session_id: "s-reg-b" }, offEnv)) ?? "",
      / \(block 1 of 2\)$/,
    );
    // still blocks with the gate on
    assert.match(
      (await gate({ cwd, session_id: "s-reg-c" }, { GUARD_RUN_ID: "run-1" })) ??
        "",
      /^Run registration failed: .* \(block 1 of 2\)$/,
    );

    // a manifest that changes after the session pinned it
    const m = manifest();
    const env = envFor(m);
    const input = { cwd, session_id: "s-pin" };
    assert.equal(await gate(input, { ...env, GUARD_RESULT_GATE: "off" }), null);
    writeFileSync(
      m,
      JSON.stringify({
        contract: 2,
        runner: "acme-runner",
        requires: ["result-gate"],
        result: { file: ".acme/other/{ticket_number}.json" },
      }),
    );
    assert.match(
      (await gate(input, { ...env, GUARD_RESULT_GATE: "off" })) ?? "",
      /^Run registration failed: manifest changed during the session/,
    );
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("result gate: a stop that sets only legacy run variables is blocked and records one line, even with the gate off", async () => {
  try {
    const cwd = gateRepo();
    const dataDir = process.env.CLAUDE_PLUGIN_DATA ?? "";
    const eventsFile = join(tmp(), "events.jsonl");
    const env = {
      FACTORY_RUN_ID: "run-1",
      FACTORY_EVENTS_FILE: eventsFile,
      GUARD_RESULT_GATE: "off",
    };
    const events: Record<string, unknown>[] = [];
    const input = { cwd, session_id: "s-legacy" };
    const first = await gate(input, env, undefined, (e) => events.push(e));
    assert.match(
      first ?? "",
      /^Legacy run variables are set without a run registration/,
    );
    assert.match(first ?? "", /GUARD_RUN_MANIFEST/);
    assert.match(first ?? "", / \(block 1 of 2\)$/);
    const second = await gate(input, env, undefined, (e) => events.push(e));
    assert.match(second ?? "", /^Legacy run variables are set/);
    assert.match(second ?? "", / \(block 2 of 2\)$/);
    // capped like a failed registration
    assert.equal(
      await gate(input, env, undefined, (e) => events.push(e)),
      null,
    );
    assert.deepEqual(events, [
      {
        result: "registration",
        target: "result-gate",
        rule: "run-unregistered",
        blocks: 1,
      },
      {
        result: "registration",
        target: "result-gate",
        rule: "run-unregistered",
        blocks: 2,
      },
      { result: "capped", target: "result-gate", rule: "run-unregistered" },
    ]);
    for (const file of [eventsFile, join(dataDir, "run-unregistered.jsonl")]) {
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 1, file);
      assert.equal(
        (JSON.parse(lines[0] ?? "") as { rule: string }).rule,
        "run-unregistered",
      );
    }
    // a subagent's stop is exempt, and so is a session with no run
    assert.equal(await gate({ ...input, agent_id: "a" }, env), null);
    assert.equal(await gate(input, { GUARD_RESULT_GATE: "off" }), null);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

void test("stop hook CLI: a failed registration block is capped at two per session", () => {
  const cwd = gateRepo();
  const data = tmp();
  const payload = JSON.stringify({
    cwd,
    hook_event_name: "Stop",
    session_id: "s-cli-cap",
  });
  const env = { GUARD_RUN_ID: "run-1", CLAUDE_PLUGIN_DATA: data };
  for (const n of [1, 2]) {
    const r = runStopHook(payload, [], env);
    assert.match(
      (JSON.parse(r.stdout) as { reason: string }).reason,
      new RegExp(`\\(block ${String(n)} of 2\\)$`),
    );
  }
  assert.equal(runStopHook(payload, [], env).stdout, "");
  // a new session starts again
  const other = runStopHook(payload.replace("s-cli-cap", "s-cli-2"), [], env);
  assert.match(other.stdout, /block 1 of 2/);
});

void test("result check: the stop hook CLI blocks a failed registration, once, in each harness's shape", () => {
  const cwd = gateRepo();
  delete process.env.CLAUDE_PLUGIN_DATA;
  const env = { GUARD_RUN_ID: "run-1" };
  const payload = JSON.stringify({ cwd, hook_event_name: "Stop" });
  const reason = /^Run registration failed: GUARD_RUN_ID is set but/;

  const claude = runStopHook(payload, [], env);
  assert.equal(claude.status, 0, claude.stderr);
  const c = JSON.parse(claude.stdout) as Record<string, unknown>;
  assert.equal(c.decision, "block");
  assert.match(String(c.reason), reason);
  assert.match(String(c.reason), / \(block 1 of 2\)$/);
  assert.equal(
    (c.hookSpecificOutput as { decision: string }).decision,
    "block",
  );

  const codex = runStopHook(payload, ["--harness=codex"], env);
  assert.equal(codex.status, 0, codex.stderr);
  const x = JSON.parse(codex.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(x).sort(), ["decision", "reason"]);
  assert.equal(x.decision, "block");
  assert.match(String(x.reason), reason);

  const anti = runStopHook(payload, ["--harness=antigravity"], env);
  assert.equal(anti.status, 0, anti.stderr);
  const a = JSON.parse(anti.stdout) as Record<string, unknown>;
  assert.equal(a.decision, "continue");
  assert.match(String(a.reason), reason);

  // the gate switch does not turn it off
  const off = runStopHook(payload, [], { ...env, GUARD_RESULT_GATE: "off" });
  assert.equal(
    (JSON.parse(off.stdout) as { decision: string }).decision,
    "block",
  );
});

void test("result check: the stop hook CLI blocks the legacy-only tripwire and lets a stop with no run go", () => {
  const cwd = gateRepo();
  delete process.env.CLAUDE_PLUGIN_DATA;
  const payload = JSON.stringify({ cwd, hook_event_name: "Stop" });
  const eventsFile = join(tmp(), "events.jsonl");
  const blocked = runStopHook(payload, [], {
    FACTORY_RUN_ID: "run-1",
    FACTORY_EVENTS_FILE: eventsFile,
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const out = JSON.parse(blocked.stdout) as {
    decision: string;
    reason: string;
  };
  assert.equal(out.decision, "block");
  assert.match(
    out.reason,
    /^Legacy run variables are set without a run registration/,
  );
  assert.equal(readFileSync(eventsFile, "utf8").trim().split("\n").length, 1);

  const free = runStopHook(payload, [], {});
  assert.equal(free.status, 0, free.stderr);
  assert.equal(free.stdout, "");
});

void test("result check: the stop hook CLI keeps a stop blocked on an unreadable payload when a run is identified, and lets a run-less one go", () => {
  for (const [args, decision] of [
    [[], "block"],
    [["--harness=codex"], "block"],
    [["--harness=antigravity"], "continue"],
  ] as const) {
    const blocked = runStopHook("{", [...args], { GUARD_RUN_ID: "run-1" });
    assert.equal(blocked.status, 0, blocked.stderr);
    const out = JSON.parse(blocked.stdout) as {
      decision: string;
      reason: string;
    };
    assert.equal(out.decision, decision);
    assert.match(out.reason, /^Run registration failed/);
  }
  const free = runStopHook("{", [], {});
  assert.equal(free.status, 0, free.stderr);
  assert.equal(free.stdout, "");
});

void test("lint: shellcheck findings come back as context; clean, missing tool or other files pass", () => {
  const dir = lintTmp();
  const sh = join(dir, "a.sh");
  const md = join(dir, "a.md");
  writeFileSync(sh, "echo $x\n");
  writeFileSync(md, "# x\n");
  const findings: SyncRunner = () =>
    ({
      status: 1,
      stdout: "SC2086: quote this\n",
      stderr: "",
    }) as unknown as SpawnSyncReturns<string>;
  const out = lintFile(
    { tool_name: "Edit", tool_input: { file_path: sh } },
    findings,
  );
  assert.ok(out);
  assert.match(out.hookSpecificOutput.additionalContext ?? "", /SC2086/);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(out.additionalContext, out.hookSpecificOutput.additionalContext);
  assert.match(
    lintFile({ tool_name: "create", tool_input: { path: sh } }, findings)
      ?.additionalContext ?? "",
    /a\.sh/,
  );
  const okRunner: SyncRunner = () =>
    ({
      status: 0,
      stdout: "",
      stderr: "",
    }) as unknown as SpawnSyncReturns<string>;
  assert.equal(
    lintFile({ tool_name: "Write", tool_input: { file_path: sh } }, okRunner),
    null,
  );
  const errRunner: SyncRunner = () =>
    ({
      status: null,
      error: new Error("ENOENT"),
      stdout: "",
      stderr: "",
    }) as unknown as SpawnSyncReturns<string>;
  assert.equal(
    lintFile({ tool_name: "Write", tool_input: { file_path: sh } }, errRunner),
    null,
  );
  assert.equal(
    lintFile({ tool_name: "Write", tool_input: { file_path: md } }, findings),
    null,
  );
  assert.equal(
    lintFile(
      { tool_name: "Write", tool_input: { file_path: join(dir, "gone.sh") } },
      findings,
    ),
    null,
  );
  assert.equal(
    lintFile(
      { tool_name: "read_file", tool_input: { filePath: sh } },
      findings,
    ),
    null,
  );
});

void test("lint: VS Code and apply_patch spellings of the edited files", () => {
  const dir = lintTmp();
  const sh = join(dir, "a.sh");
  const findings: SyncRunner = () =>
    ({
      status: 1,
      stdout: "SC2086\n",
      stderr: "",
    }) as unknown as SpawnSyncReturns<string>;
  writeFileSync(sh, "echo $x\n");
  for (const [tool_name, tool_input] of [
    ["create_file", { filePath: sh }],
    ["replace_string_in_file", { filePath: sh }],
    [
      "multi_replace_string_in_file",
      { replacements: [{ filePath: sh }, { filePath: sh }] },
    ],
    [
      "Edit",
      "*** Begin Patch\n*** Update File: a.sh\n@@\n-x\n+y\n*** End Patch\n",
    ],
    [
      "apply_patch",
      { input: `*** Begin Patch\n*** Add File: ${sh}\n+y\n*** End Patch\n` },
    ],
  ] as const) {
    const out = lintFile({ tool_name, tool_input, cwd: dir }, findings);
    assert.equal(
      out?.additionalContext.match(/Lint findings/g)?.length,
      1,
      tool_name,
    );
  }
});

void test("lint: .ps1 goes to PSScriptAnalyzer through pwsh, powershell on Windows", () => {
  const dir = lintTmp();
  const ps1 = join(dir, "a.ps1");
  writeFileSync(ps1, "Write-Host x\n");
  let used: (string | undefined)[] | undefined;
  const run: SyncRunner = (cmd, _args, opts) => {
    const envObj = (opts as { env?: { GUARD_LINT_FILE?: string } } | undefined)
      ?.env;
    used = [cmd, envObj?.GUARD_LINT_FILE];
    return {
      status: 0,
      stdout: "RuleName : PSAvoidUsingWriteHost\n",
      stderr: "",
    } as unknown as SpawnSyncReturns<string>;
  };
  assert.match(
    lintFile(
      { tool_name: "Edit", tool_input: { file_path: ps1 } },
      run,
      "darwin",
    )?.hookSpecificOutput.additionalContext ?? "",
    /PSAvoidUsingWriteHost/,
  );
  assert.deepEqual(used, ["pwsh", ps1]);
  lintFile({ tool_name: "Edit", tool_input: { file_path: ps1 } }, run, "win32");
  assert.ok(used);
  assert.equal(used[0], "powershell");
});

void test("awake: walks past shells to the harness pid", () => {
  const tree: Record<number, { name: string; ppid: number }> = {
    10: { ppid: 9, name: "bash" },
    9: { ppid: 8, name: "/bin/zsh" },
    8: { ppid: 1, name: "claude" },
  };
  const lookup = (p: number) => {
    const item = tree[p];
    return item
      ? { ...item, name: item.name.split("/").pop() ?? item.name }
      : null;
  };
  assert.equal(harnessPid(10, lookup), 8);
  assert.equal(harnessPid(8, lookup), 8);
  assert.equal(harnessPid(42, lookup), 42);
});

void test("awake: one keeper per OS, tied to the harness pid", () => {
  assert.deepEqual(keeperArgv(8, "darwin"), ["caffeinate", "-i", "-w", "8"]);
  assert.ok(keeperArgv(8, "linux")?.includes("--pid=8"));
  const win = keeperArgv(8, "win32");
  assert.ok(win);
  assert.equal(win[0], "powershell");
  const encoded = win[win.length - 1] ?? "";
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483649\)/);
  assert.match(script, /Wait-Process -Id 8/);
  assert.equal(keeperArgv(8, "aix"), null);
});

void test("awake: a live keeper is reused across session starts; a dead one is replaced", () => {
  const dataDir = tmp();
  let launched = 0;
  const base = {
    dataDir,
    start: 8,
    lookup: () => null,
    platform: "darwin" as NodeJS.Platform,
    launch: () => 1000 + ++launched,
  };
  assert.equal(keepAwake({ ...base, isAlive: () => true })?.keeper, 1001);
  assert.equal(keepAwake({ ...base, isAlive: () => true }), null);
  assert.equal(keepAwake({ ...base, isAlive: () => false })?.keeper, 1002);
  assert.equal(
    keepAwake({ ...base, launch: () => undefined, isAlive: () => false }),
    null,
  );
});

void test(
  "stop: make runs without a terminal, so a recipe reading /dev/tty fails at once",
  { skip: process.platform === "win32" },
  async () => {
    const started = Date.now();
    const r = await runDetached("sh", ["-c", "read x < /dev/tty"], {
      cwd: tmp(),
      timeout: 20_000,
    });
    assert.notEqual(r.status, 0);
    assert.equal(r.timedOut, false);
    assert.ok(Date.now() - started < 10_000);
  },
);

void test(
  "stop: a timeout kills the whole process group, grandchildren included",
  { skip: process.platform === "win32" },
  async () => {
    const dir = tmp();
    const r = await runDetached(
      "sh",
      ["-c", "sleep 60 & echo $! > pid; wait"],
      { cwd: dir, timeout: 500 },
    );
    assert.equal(r.timedOut, true);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(pid, 0));
  },
);

void test("stop: a timeout resolves at once even when a surviving grandchild keeps the pipes open", async () => {
  const dir = tmp();
  const middle =
    "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }); require('fs').writeFileSync('pid', String(c.pid)); c.unref()";
  const started = Date.now();
  const r = await runDetached(process.execPath, ["-e", middle], {
    cwd: dir,
    timeout: 500,
  });
  try {
    assert.equal(r.timedOut, true);
    assert.ok(
      Date.now() - started < 5000,
      "resolved after " + String(Date.now() - started) + " ms",
    );
  } finally {
    try {
      process.kill(Number(readFileSync(join(dir, "pid"), "utf8")));
    } catch {}
  }
});

void test("stop: the fingerprint changes when an untracked file changes", () => {
  const dir = tmp();
  const git = (...args: readonly string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git(
    "-c",
    "user.email=a@b",
    "-c",
    "user.name=a",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  writeFileSync(join(dir, "new.py"), "a = 1\n");
  const before = fingerprint(dir);
  writeFileSync(join(dir, "new.py"), "a = 2\n");
  assert.ok(before);
  assert.notEqual(fingerprint(dir), before);
});

const docsRepo = () => {
  const dir = tmp();
  const git = (...args: readonly string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=a@b", "-c", "user.name=a", ...args],
      { cwd: dir, stdio: "ignore" },
    );
  git("init", "-q");
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "Makefile"), "check:\n\t@true\n");
  writeFileSync(join(dir, "src", "a.py"), "a = 1\n");
  writeFileSync(join(dir, "README.md"), "# r\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const checks: string[] = [];
  const run: SyncRunner = (cmd, args, opts) => {
    if (cmd !== "make") {
      return spawnSync(
        cmd,
        args as string[],
        opts as object,
      ) as unknown as SpawnSyncReturns<string>;
    }
    if (args[0] === "-n") {
      return {
        status: args[1] === "check" ? 0 : 2,
        stdout: "",
        stderr: "",
      } as unknown as SpawnSyncReturns<string>;
    }
    checks.push(args[0] ?? "");
    return {
      status: 0,
      stdout: "",
      stderr: "",
    } as unknown as SpawnSyncReturns<string>;
  };
  const stop = () => stopCheck({ cwd: dir }, run, { strain: () => null });
  return {
    dir,
    git,
    checks,
    stop,
    write: (p: string, s: string) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), s);
    },
  };
};

const withData = async (fn: () => Promise<void>): Promise<void> => {
  process.env.CLAUDE_PLUGIN_DATA = tmp();
  try {
    await fn();
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
};

void test("stop: a clean first turn and docs-only change skip make check; a code or mixed change runs it", () =>
  withData(async () => {
    const r = docsRepo();
    await r.stop();
    assert.equal(r.checks.length, 0, "clean tree: skipped");
    r.write("README.md", "# changed\n");
    r.write("docs/guide.md", "new\n");
    r.write("docs/a.png", "x");
    await r.stop();
    assert.equal(r.checks.length, 0, "docs only: skipped");
    r.write("src/a.py", "a = 2\n");
    await r.stop();
    assert.equal(r.checks.length, 1, "mixed: runs");
  }));

void test("stop: GUARD_STOP_CHECK=force runs make check on a clean tree", () =>
  withData(async () => {
    const r = docsRepo();
    process.env.GUARD_STOP_CHECK = "force";
    try {
      await r.stop();
    } finally {
      delete process.env.GUARD_STOP_CHECK;
    }
    assert.equal(r.checks.length, 1);
  }));

void test("stop: a code commit since the last green run is not hidden by a docs-only working tree", () =>
  withData(async () => {
    const r = docsRepo();
    process.env.GUARD_STOP_CHECK = "force";
    try {
      await r.stop();
    } finally {
      delete process.env.GUARD_STOP_CHECK;
    }
    r.write("src/a.py", "a = 3\n");
    r.git("commit", "-qam", "code");
    r.write("README.md", "# after\n");
    await r.stop();
    assert.equal(
      r.checks.length,
      2,
      "the diff is taken against the green run, not HEAD",
    );
    r.write("README.md", "# docs commit\n");
    r.git("commit", "-qam", "docs");
    await r.stop();
    assert.equal(
      r.checks.length,
      2,
      "only a docs commit since the last green run: skipped",
    );
  }));

void test("stop: a code file renamed into docs/ still runs the check (renames count as delete and add)", () =>
  withData(async () => {
    const r = docsRepo();
    r.git("mv", "src/a.py", "docs/a.py");
    await r.stop();
    assert.equal(r.checks.length, 1);
  }));

void test("stop: the repo's .stop-check-ignore keeps matching docs checked and extends the skip list", () =>
  withData(async () => {
    const r = docsRepo();
    r.write(".stop-check-ignore", "!docs/**\nsite/**\n");
    r.git("add", ".stop-check-ignore");
    r.git("commit", "-qm", "rules");
    r.write("site/index.html", "<p>");
    await r.stop();
    assert.equal(r.checks.length, 0, "extended skip list");
    r.write("docs/guide.md", "x\n");
    await r.stop();
    assert.equal(r.checks.length, 1, "`!docs/**`: runs");
  }));

void test("stop: GUARD_STOP_CHECK=off still disables it and force still skips only the strain deferral", () =>
  withData(async () => {
    const r = docsRepo();
    r.write("README.md", "# x\n");
    process.env.GUARD_STOP_CHECK = "force";
    try {
      const runner: SyncRunner = (c, a, o) => {
        if (c === "make" && a[0] !== "-n") {
          assert.fail("docs only");
        }
        return c === "make"
          ? ({
              status: a[1] === "check" ? 0 : 2,
            } as unknown as SpawnSyncReturns<string>)
          : (spawnSync(
              c,
              a as string[],
              o as object,
            ) as unknown as SpawnSyncReturns<string>);
      };
      await stopCheck({ cwd: r.dir }, runner, { strain: () => "load 99" });
    } finally {
      delete process.env.GUARD_STOP_CHECK;
    }
  }));

void test("stop: of two stops taking over a dead holder's lock, only one wins", () => {
  const file = join(tmp(), "x.lock");
  writeFileSync(file, "999999999");
  const first = takeLock(file);
  const second = takeLock(file);
  assert.equal(typeof first, "function");
  assert.equal(second, null);
  first?.();
  assert.equal(existsSync(file), false);
});

void test("lint: Codex apply_patch (`command`) is read; zsh scripts and temp files are skipped", () => {
  const dir = lintTmp();
  const findings: SyncRunner = () =>
    ({
      status: 1,
      stdout: "SC2086\n",
      stderr: "",
    }) as unknown as SpawnSyncReturns<string>;
  const bash = join(dir, "b.sh");
  const zsh = join(dir, "z.sh");
  writeFileSync(bash, "#!/usr/bin/env bash\necho $x\n");
  writeFileSync(zsh, "#!/bin/zsh\necho $x\n");
  const patch = `*** Begin Patch\n*** Add File: ${bash}\n+y\n*** End Patch\n`;
  assert.match(
    lintFile(
      { tool_name: "apply_patch", tool_input: { command: patch }, cwd: dir },
      findings,
    )?.additionalContext ?? "",
    /b\.sh/,
  );
  assert.equal(
    lintFile({ tool_name: "Write", tool_input: { file_path: zsh } }, findings),
    null,
  );
  const scratch = join(tmp(), "s.sh");
  writeFileSync(scratch, "echo $x\n");
  assert.equal(
    lintFile(
      { tool_name: "Write", tool_input: { file_path: scratch } },
      findings,
    ),
    null,
  );
});

void test('stop check: Antigravity hook receives { decision: "continue", reason } when blocked or passes cleanly', () => {
  const res = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "stop.mjs"), "--harness=antigravity"],
    {
      input: JSON.stringify({
        conversationId: "agy-stop-1",
        workspacePaths: ["/tmp/nonexistent"],
        terminationReason: "NO_TOOL_CALL",
      }),
      encoding: "utf8",
    },
  );
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
});

void test("result check: the stop hook CLI keeps a stop blocked on a payload that is not an object when a run is identified", () => {
  for (const payload of ["null", "5", "[]", '"x"']) {
    const blocked = runStopHook(payload, [], { GUARD_RUN_ID: "run-1" });
    assert.equal(blocked.status, 0, blocked.stderr);
    const out = JSON.parse(blocked.stdout) as { decision: string };
    assert.equal(out.decision, "block");
    assert.equal(runStopHook(payload, [], {}).stdout, "");
  }
});
