// GUARD_RULES at the hooks: each rule id switches its rule off, an enabled rule is never hidden by a disabled one, the
// older switches keep working, and a registered run keeps the rules its capabilities require.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { HostFacts } from "../core/types.mjs";
import { keepAwake } from "./awake.mjs";
import { createGuard } from "./bridge.mjs";
import { handle, pythonManager } from "./guard.mjs";
import type { ExtendedHookInput, GuardDeps, HandleResult } from "./guard.mjs";
import { type SpawnSyncFn, lintFile } from "./lint.mjs";
import { resultGate, stopCheck } from "./stop.mjs";
import type { SyncRunner } from "./stop.mjs";
import type { HookOutputPayload, HookSpecificOutput } from "./types.mjs";

for (const k of [
  "GUARD_RULES",
  "GUARD_STOP_CHECK",
  "GUARD_RESULT_GATE",
  "GUARD_UNATTENDED",
  "AGENT_RUN_ID",
  "AGENT_RUN_MANIFEST",
  "AGENT_RUN_TICKET",
  "AGENT_RUN_MODE",
]) {
  Reflect.deleteProperty(process.env, k);
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "toggles-test-"));
const LINT_ROOT = fileURLToPath(new URL("./.toggles-lint/", import.meta.url));
after(() => {
  rmSync(LINT_ROOT, { recursive: true, force: true });
});

const calm = async (): Promise<HostFacts> => {
  await Promise.resolve();
  return { load1: 1, freeGb: 100 };
};
const nothing = async (): Promise<string | null> => {
  await Promise.resolve();
  return null;
};

const setup = (
  deps: Partial<GuardDeps> = {},
): ((input: ExtendedHookInput) => Promise<HandleResult>) => {
  const dataDir = tmp();
  return (input) =>
    handle(
      { session_id: "s1", cwd: "/", ...input },
      {
        dataDir,
        env: {},
        hostFacts: calm,
        run: nothing,
        pythonManager,
        ...deps,
      },
    );
};

const pre = (tool_name: string, command: string): ExtendedHookInput => ({
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input: { command },
});
const shell = (command: string): ExtendedHookInput => pre("Bash", command);
const prompt = (text: string): ExtendedHookInput => ({
  hook_event_name: "UserPromptSubmit",
  prompt: text,
});
const parsed = (out: HandleResult): HookOutputPayload =>
  out.stdout ? (JSON.parse(out.stdout) as HookOutputPayload) : {};
const decision = (out: HandleResult): HookSpecificOutput | undefined =>
  parsed(out).hookSpecificOutput;
const verdict = (out: HandleResult): string | undefined =>
  decision(out)?.permissionDecision;

const OFF_ENV = (rules: string, more: Record<string, string> = {}) => ({
  GUARD_RULES: rules,
  ...more,
});

// ---- the rules at the PreToolUse handler: on by default, off with their id

void test("risky: the ask and its unattended deny go with -risky", async () => {
  assert.equal(verdict(await setup()(shell("rm -rf ~/x"))), "ask");
  assert.equal(
    verdict(
      await setup({ env: { GUARD_UNATTENDED: "1" } })(shell("rm -rf ~/x")),
    ),
    "deny",
  );
  for (const env of [
    OFF_ENV("-risky"),
    OFF_ENV("-risky", { GUARD_UNATTENDED: "1" }),
    OFF_ENV("none"),
  ]) {
    assert.equal(
      decision(await setup({ env })(shell("rm -rf ~/x"))),
      undefined,
      JSON.stringify(env),
    );
  }
  // the lease-push lookup is part of the rule: no facts, no ask
  const calls: string[] = [];
  await setup({
    env: OFF_ENV("-risky"),
    run: async (argv) => {
      await Promise.resolve();
      calls.push(argv.join(" "));
      return null;
    },
  })(shell("git push --force-with-lease"));
  assert.deepEqual(calls, []);
});

void test("title: a bad commit title is denied until -title", async () => {
  const bad = 'git commit -m "bad"';
  const on = setup();
  await on(prompt("/ship"));
  assert.equal(verdict(await on(shell(bad))), "deny");
  const off = setup({ env: OFF_ENV("-title") });
  await off(prompt("/ship"));
  assert.equal(decision(await off(shell(bad))), undefined);
});

void test("python: the pip deny in a uv repo goes with -python, its note too", async () => {
  const uv = { pythonManager: () => "uv" };
  const denied = decision(await setup(uv)(shell("pip install x")));
  assert.equal(denied?.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason ?? "", /uv/);
  assert.equal(
    decision(
      await setup({ ...uv, env: OFF_ENV("-python") })(shell("pip install x")),
    ),
    undefined,
  );
  assert.equal(
    decision(
      await setup({ ...uv, env: OFF_ENV("-python") })(shell("poetry add x")),
    ),
    undefined,
  );
  // outside a uv repo the command passes with a note, which -python also drops
  const note = { pythonManager: () => null };
  assert.match(
    decision(await setup(note)(shell("pip install x")))?.additionalContext ??
      "",
    /pip/,
  );
  assert.equal(
    decision(
      await setup({ ...note, env: OFF_ENV("-python") })(shell("pip install x")),
    ),
    undefined,
  );
});

void test("skills: the deny-once enforcer and the skill reminders go with -skills", async () => {
  assert.equal(verdict(await setup()(shell("git commit"))), "deny");
  assert.equal(
    decision(await setup({ env: OFF_ENV("-skills") })(shell("git commit"))),
    undefined,
  );
  // a reminder rule (no deny): the edit-tool hint for a watched path
  const edit = (path: string): ExtendedHookInput => ({
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: path },
  });
  const sample = "docs/adr/0001-x.md";
  const on = decision(await setup()(edit(sample)));
  assert.ok(on?.additionalContext, "a skill reminder by default");
  assert.equal(
    decision(await setup({ env: OFF_ENV("-skills") })(edit(sample))),
    undefined,
  );
});

void test("hints: the read, edit and routing hints go with -hints", async () => {
  const spawn: ExtendedHookInput = {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { prompt: "p", description: "d", subagent_type: "Plan" },
  };
  for (const [input, want] of [
    [shell("cat a.txt"), /read tool/],
    [shell("sed -i s/a/b/ f.txt"), /edit tool/i],
    [spawn, /Routing hint/],
  ] as const) {
    assert.match(
      decision(await setup({ readTool: true })(input))?.additionalContext ?? "",
      want,
    );
    assert.equal(
      decision(await setup({ readTool: true, env: OFF_ENV("-hints") })(input)),
      undefined,
      String(want),
    );
  }
});

void test("host: the strain deny and its facts go with -host and GUARD_HOST_CHECK=off", async () => {
  const strained = async (): Promise<HostFacts> => {
    await Promise.resolve();
    return { load1: 50, freeGb: 100 };
  };
  assert.equal(
    verdict(await setup({ hostFacts: strained })(shell("npm run build"))),
    "deny",
  );
  for (const env of [OFF_ENV("-host"), { GUARD_HOST_CHECK: "off" }]) {
    let calls = 0;
    const out = await setup({
      env,
      hostFacts: async () => {
        await Promise.resolve();
        calls += 1;
        return { load1: 50, freeGb: 100 };
      },
    })(shell("npm run build"));
    assert.equal(decision(out), undefined, JSON.stringify(env));
    assert.equal(calls, 0, JSON.stringify(env));
  }
});

const LEAK = {
  RuleID: "aws-access-token",
  File: "app.env",
  StartLine: 3,
  Commit: "1234567890abcdef",
};
const scanning =
  (calls: string[]) =>
  async (argv: readonly string[]): Promise<string | null> => {
    await Promise.resolve();
    calls.push(argv.join(" "));
    if (argv[0] === "gitleaks") return JSON.stringify([LEAK]);
    if (argv.includes("@{u}")) return "origin/feat/x\n";
    if (argv.includes("rev-list")) return "1\n";
    return null;
  };

void test("push-scan: the secret scan before a push goes with -push-scan and GUARD_PUSH_SCAN=off", async () => {
  const calls: string[] = [];
  assert.equal(
    verdict(
      await setup({ env: { GUARD_PUSH_SCAN: "on" }, run: scanning(calls) })(
        shell("git push"),
      ),
    ),
    "deny",
  );
  assert.ok(calls.some((c) => c.startsWith("gitleaks")));
  for (const env of [
    OFF_ENV("-push-scan", { GUARD_PUSH_SCAN: "on" }),
    { GUARD_PUSH_SCAN: "off" },
  ]) {
    const seen: string[] = [];
    const out = await setup({ env, run: scanning(seen) })(shell("git push"));
    assert.equal(decision(out), undefined, JSON.stringify(env));
    assert.ok(!seen.some((c) => c.startsWith("gitleaks")), JSON.stringify(env));
  }
});

// feat/new has no PR yet; PR #7 (feat/old) touches the same file.
const batching = async (argv: readonly string[]): Promise<string | null> => {
  await Promise.resolve();
  const line = argv.join(" ");
  if (line === "git branch --show-current") return "feat/new\n";
  if (line === "git symbolic-ref --short refs/remotes/origin/HEAD")
    return "origin/main\n";
  if (line === "git rev-parse --show-toplevel") return "/r\n";
  if (argv[1] === "merge-base") return "base\n";
  if (argv[1] === "diff") return "src/a.ts\n";
  if (argv[1] === "worktree")
    return "worktree /r\nbranch refs/heads/feat/new\n";
  if (argv[0] === "gh")
    return JSON.stringify([
      { number: 7, headRefName: "feat/old", files: [{ path: "src/a.ts" }] },
    ]);
  return null;
};

void test("pr-batch: the overlapping-PR deny goes with -pr-batch", async () => {
  const env = { GUARD_PUSH_SCAN: "off", GUARD_STACK_HINT: "off" };
  const on = setup({ env, run: batching });
  await on(prompt("/ship"));
  const denied = decision(await on(shell("gh pr create --fill")));
  assert.equal(denied?.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason ?? "", /PR #7 already touches/);
  const off = setup({
    env: { ...env, GUARD_RULES: "-pr-batch" },
    run: batching,
  });
  await off(prompt("/ship"));
  assert.equal(decision(await off(shell("gh pr create --fill"))), undefined);
});

// feat/b is built on feat/a (#7), which is not in main.
const stacked = (calls: string[]) => async (argv: readonly string[]) => {
  await Promise.resolve();
  calls.push(argv.join(" "));
  if (argv[1] === "symbolic-ref") return "origin/main\n";
  if (argv[1] === "rev-parse") return "feat/b\n";
  if (argv[0] === "gh" && argv[2] === "view")
    return JSON.stringify({ headRefName: "feat/b", baseRefName: "main" });
  if (argv[0] === "gh" && argv[2] === "list")
    return JSON.stringify([{ number: 7, headRefName: "feat/a" }]);
  if (argv[1] === "merge-base") return argv[4] === "origin/main" ? null : "";
  return null;
};

void test("stack-hint: the stacked-PR hint goes with -stack-hint and GUARD_STACK_HINT=off", async () => {
  const create = "SPLIT_REASON=other-owner gh pr create --fill";
  const base = { GUARD_PUSH_SCAN: "off" };
  const on = setup({ env: base, run: stacked([]) });
  await on(prompt("/ship"));
  assert.match(
    decision(await on(shell(create)))?.additionalContext ?? "",
    /#7/,
  );
  for (const env of [
    { ...base, GUARD_RULES: "-stack-hint" },
    { ...base, GUARD_STACK_HINT: "off" },
  ]) {
    const calls: string[] = [];
    const off = setup({ env, run: stacked(calls) });
    await off(prompt("/ship"));
    assert.equal(decision(await off(shell(create))), undefined);
    assert.deepEqual(
      calls.filter((c) => /merge-base|gh pr list|gh pr view/.test(c)),
      [],
    );
  }
});

// Claude Code's layout: this session loaded guard 0.52.0, the registry says 0.53.0 is installed.
const stalePlugin = (): string => {
  const plugins = join(tmp(), "plugins");
  for (const v of ["0.52.0", "0.53.0"]) {
    const dir = join(plugins, "cache", "acme", "guard", v);
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "guard", version: v }),
    );
  }
  writeFileSync(
    join(plugins, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "guard@acme": [{ scope: "user", version: "0.53.0" }] },
    }),
  );
  return join(plugins, "cache", "acme", "guard", "0.52.0");
};

void test("stale-plugins: the stale-plugins note goes with -stale-plugins", async () => {
  const pluginRoot = stalePlugin();
  const skill: ExtendedHookInput = {
    hook_event_name: "PreToolUse",
    tool_name: "Skill",
    tool_input: { skill: "ship" },
  };
  const on = await setup({ pluginRoot, harness: "claude" })(skill);
  assert.match(
    decision(on)?.additionalContext ?? "",
    /guard 0\.52\.0 → 0\.53\.0/,
  );
  const off = await setup({
    pluginRoot,
    harness: "claude",
    env: OFF_ENV("-stale-plugins"),
  })(skill);
  assert.equal(decision(off), undefined);
  assert.equal(parsed(off).systemMessage, undefined);
});

void test("lifecycle: the sweep, its notice and the queued notes go with -lifecycle and GUARD_LIFECYCLE=off", async () => {
  const lifecycleFor = (env: Record<string, string>) => {
    const seen: string[] = [];
    const h = setup({
      pluginRoot: tmp(),
      env: { GUARD_PUSH_SCAN: "off", ...env },
      lifecycle: {
        startSessionSweep: () => {
          seen.push("sweep");
        },
        sweepNotice: () => {
          seen.push("notice");
          return "sweep: removed 12 local branches";
        },
        takeAgentNotes: () => {
          seen.push("notes");
          return ["note"];
        },
      },
    });
    return { h, seen };
  };
  const session: ExtendedHookInput = {
    hook_event_name: "SessionStart",
    source: "startup",
    cwd: "/r",
  };
  const on = lifecycleFor({ GUARD_LIFECYCLE: "on" });
  await on.h(session);
  assert.match(
    decision(await on.h(shell("ls")))?.additionalContext ?? "",
    /sweep: removed 12/,
  );
  assert.deepEqual(on.seen, ["sweep", "notice", "notes"]);
  for (const env of [OFF_ENV("-lifecycle"), { GUARD_LIFECYCLE: "off" }]) {
    const off = lifecycleFor(env);
    await off.h(session);
    assert.equal(decision(await off.h(shell("ls"))), undefined);
    assert.deepEqual(off.seen, [], JSON.stringify(env));
  }
});

// ---- the stop hook

const makeRun =
  (calls: string[]): SyncRunner =>
  (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    const status = cmd === "make" && args[0] !== "-n" ? 2 : 0;
    return {
      status,
      stdout: cmd === "git" ? "x" : "FAIL x\n",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    };
  };

const withEnv = async <T,>(
  env: Record<string, string>,
  body: () => Promise<T>,
): Promise<T> => {
  Object.assign(process.env, env);
  try {
    return await body();
  } finally {
    for (const k of Object.keys(env)) Reflect.deleteProperty(process.env, k);
  }
};

void test("stop-check: make check on stop goes with -stop-check and GUARD_STOP_CHECK=off", async () => {
  process.env.CLAUDE_PLUGIN_DATA = tmp();
  try {
    const stop = async () => {
      const calls: string[] = [];
      const out = await stopCheck({ cwd: "/r" }, makeRun(calls), {
        strain: () => null,
        reminder: false,
      });
      return { out, calls };
    };
    const on = await stop();
    assert.equal(on.out?.decision, "block");
    const envs: Record<string, string>[] = [
      { GUARD_RULES: "-stop-check" },
      { GUARD_RULES: "none" },
      { GUARD_STOP_CHECK: "off" },
    ];
    for (const env of envs) {
      const off = await withEnv(env, stop);
      assert.equal(off.out, null, JSON.stringify(env));
      assert.ok(
        !off.calls.some((c) => c === "make check"),
        JSON.stringify(env),
      );
    }
  } finally {
    Reflect.deleteProperty(process.env, "CLAUDE_PLUGIN_DATA");
  }
});

// A registered run in a git repo whose manifest requires the result gate: the result file is missing, so the gate blocks.
const gatedRun = () => {
  const root = tmp();
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const manifest = join(root, "m.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      contract: 3,
      runner: "acme-runner",
      requires: ["result-gate"],
      result: { file: ".acme/runs/{ticket_number}/result.json" },
    }),
  );
  const env: Record<string, string> = {
    AGENT_RUN_ID: "r1",
    AGENT_RUN_TICKET: "acme/app#12",
    AGENT_RUN_MANIFEST: manifest,
  };
  const vet = {
    writable: () => false,
    owner: () => false,
    readOnlyMount: () => false,
    dataDir: join(root, "data"),
  };
  return {
    gate: async (extra: Record<string, string> = {}) =>
      resultGate(
        { cwd: repo, session_id: "s1" },
        undefined,
        { ...env, ...extra },
        undefined,
        vet,
      ),
    stranger: async (extra: Record<string, string>) =>
      resultGate(
        { cwd: repo, session_id: "s1" },
        undefined,
        extra,
        undefined,
        vet,
      ),
  };
};

void test("result-gate: a run requiring it keeps it under GUARD_RULES=none; GUARD_RESULT_GATE=off still switches it off; no run, no gate", async () => {
  const { gate, stranger } = gatedRun();
  assert.match((await gate()) ?? "", /is not a valid result/);
  for (const rules of ["none", "-result-gate", "none,risky"]) {
    assert.match(
      (await gate({ GUARD_RULES: rules })) ?? "",
      /is not a valid result/,
      rules,
    );
  }
  assert.equal(await gate({ GUARD_RESULT_GATE: "off" }), null);
  assert.equal(
    await gate({ GUARD_RESULT_GATE: "off", GUARD_RULES: "none" }),
    null,
  );
  assert.equal(await stranger({ GUARD_RULES: "none" }), null);
});

// ---- post-edit lint and keep-awake

void test("lint: the post-edit lint goes with -lint", () => {
  mkdirSync(LINT_ROOT, { recursive: true });
  const dir = mkdtempSync(join(LINT_ROOT, "x-"));
  const sh = join(dir, "a.sh");
  writeFileSync(sh, "echo $x\n");
  let calls = 0;
  const findings = (() => {
    calls += 1;
    return { status: 1, stdout: "SC2086: quote this\n", stderr: "" };
  }) as unknown as SpawnSyncFn;
  const input = { tool_name: "Edit", tool_input: { file_path: sh } };
  assert.match(lintFile(input, findings)?.additionalContext ?? "", /SC2086/);
  assert.equal(calls, 1);
  for (const GUARD_RULES of ["-lint", "none"]) {
    assert.equal(
      lintFile(input, findings, undefined, { GUARD_RULES }),
      null,
      GUARD_RULES,
    );
  }
  assert.equal(calls, 1, "a disabled lint runs nothing");
});

void test("awake: the keep-awake keeper goes with -awake", () => {
  const base = {
    dataDir: tmp(),
    start: 8,
    lookup: () => null,
    platform: "darwin" as NodeJS.Platform,
  };
  let launched = 0;
  const launch = () => 1000 + ++launched;
  for (const GUARD_RULES of ["-awake", "none"]) {
    assert.equal(keepAwake({ ...base, launch, env: { GUARD_RULES } }), null);
  }
  assert.equal(launched, 0);
  assert.equal(keepAwake({ ...base, launch, env: {} })?.keeper, 1001);
});

void test("the in-process bridge (opencode, pi) reads the same toggles for lint, awake and the tool hooks", async () => {
  mkdirSync(LINT_ROOT, { recursive: true });
  const dir = mkdtempSync(join(LINT_ROOT, "b-"));
  const sh = join(dir, "a.sh");
  writeFileSync(sh, "echo $x\n");
  const findings = () => ({
    status: 1,
    stdout: "SC2086: quote this\n",
    stderr: "",
  });
  let launched = 0;
  const bridge = (env: Record<string, string>) =>
    createGuard({
      harness: "pi",
      dataDir: tmp(),
      deps: {
        env,
        spawnSync: findings,
        launch: () => 1000 + ++launched,
        hostFacts: calm,
        run: nothing,
      },
    });
  const on = bridge({ GUARD_PUSH_SCAN: "off" });
  assert.match(
    on.postTool({ tool: "Edit", input: { file_path: sh } }) ?? "",
    /SC2086/,
  );
  const off = bridge({ GUARD_RULES: "-lint,-awake,-risky" });
  assert.equal(off.postTool({ tool: "Edit", input: { file_path: sh } }), null);
  off.awake();
  assert.equal(launched, 0);
  const asked = await on.preTool({
    tool: "bash",
    input: { command: "rm -rf ~/x" },
  });
  assert.equal(asked.decision, "ask");
  const skipped = await off.preTool({
    tool: "bash",
    input: { command: "rm -rf ~/x" },
  });
  assert.equal(skipped.decision, undefined);
});

// ---- a run: the floor, and the rules its capabilities do not require

const REG_DIR = tmp();
let regCount = 0;
const registered = (
  reg: Record<string, unknown>,
  requires: string[],
  env: Record<string, string> = {},
) => {
  const file = join(REG_DIR, `m${String(regCount++)}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      contract: 3,
      runner: "acme-runner",
      ...reg,
      requires: [...requires].sort(),
    }),
  );
  return setup({
    env: {
      AGENT_RUN_ID: "r1",
      AGENT_RUN_TICKET: "acme/app#7",
      AGENT_RUN_MANIFEST: file,
      CLAUDE_PLUGIN_DATA: tmp(),
      GUARD_PUSH_SCAN: "off",
      ...env,
    },
    runVet: {
      writable: () => false,
      owner: () => false,
      readOnlyMount: () => false,
    },
  });
};

const LABELS = { labels: { approval: "agent-ok" } };
const PROTECTED = { protected_paths: { globs: [".factory/**"] } };
const LABEL_CMD = "gh issue edit 7 --add-label agent-ok";
const WRITE_CMD = "echo x > .github/workflows/ci.yml";

void test("a registered unattended run keeps run-labels and protected-paths under GUARD_RULES=none", async () => {
  const h = registered(
    { ...LABELS, ...PROTECTED },
    ["labels", "protected-paths"],
    {
      GUARD_RULES: "none",
    },
  );
  const label = decision(await h(shell(LABEL_CMD)));
  assert.equal(label?.permissionDecision, "deny");
  assert.match(label.permissionDecisionReason ?? "", /agent-ok/);
  const write = decision(await h(shell(WRITE_CMD)));
  assert.equal(write?.permissionDecision, "deny");
  assert.match(write.permissionDecisionReason ?? "", /protected path/);
  // every other rule is off: a risky command passes
  assert.equal(decision(await h(shell("rm -rf ~/x"))), undefined);
});

void test("a registered run keeps the protected-path deny on an edit tool under GUARD_RULES=none", async () => {
  const repo = tmp();
  mkdirSync(join(repo, ".git"));
  const h = registered(PROTECTED, ["protected-paths"], { GUARD_RULES: "none" });
  const out = await h({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: {
      file_path: join(repo, ".github", "workflows", "ci.yml"),
      content: "x",
    },
    cwd: repo,
  });
  assert.equal(verdict(out), "deny");
  assert.match(decision(out)?.permissionDecisionReason ?? "", /protected path/);
});

void test("a run that does not require a capability can switch its rule off", async () => {
  // labels required only: the protected-path rule is not floored
  const h = registered(LABELS, ["labels"], { GUARD_RULES: "-protected-paths" });
  assert.notEqual(verdict(await h(shell(WRITE_CMD))), "deny");
  assert.equal(verdict(await h(shell(LABEL_CMD))), "deny");
  const on = registered(LABELS, ["labels"]);
  assert.equal(verdict(await on(shell(WRITE_CMD))), "deny");
  // the edit tool follows the same switch
  const repo = tmp();
  mkdirSync(join(repo, ".git"));
  const edit: ExtendedHookInput = {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: {
      file_path: join(repo, ".github", "workflows", "ci.yml"),
      content: "x",
    },
    cwd: repo,
  };
  assert.equal(verdict(await on(edit)), "deny");
  assert.notEqual(verdict(await h(edit)), "deny");

  // protected paths required only: the label rules are not floored (a gh alias the guard cannot read is the label rule's)
  const spelled = "gh alias set co pr";
  const p = registered(PROTECTED, ["protected-paths"]);
  assert.equal(verdict(await p(shell(spelled))), "deny");
  const q = registered(PROTECTED, ["protected-paths"], {
    GUARD_RULES: "-run-labels",
  });
  assert.notEqual(verdict(await q(shell(spelled))), "deny");
});

void test("a registration failure denies whatever GUARD_RULES says", async () => {
  const h = setup({
    env: {
      AGENT_RUN_ID: "r1",
      AGENT_RUN_MANIFEST: "/no/such/manifest.json",
      GUARD_RULES: "none",
    },
  });
  const out = await h(shell("ls"));
  assert.equal(verdict(out), "deny");
  assert.match(decision(out)?.permissionDecisionReason ?? "", /registration/i);
});

// ---- no run, GUARD_RULES=none

void test("GUARD_RULES=none with no run: a risky command and a bad title pass, make check does not run", async () => {
  const h = setup({ env: OFF_ENV("none") });
  assert.equal(decision(await h(shell("rm -rf ~/x"))), undefined);
  assert.equal(decision(await h(shell('git commit -m "bad"'))), undefined);
  assert.equal(decision(await h(shell("git reset --hard"))), undefined);
  const calls: string[] = [];
  const out = await withEnv({ GUARD_RULES: "none" }, () =>
    stopCheck({ cwd: "/r" }, makeRun(calls), {
      strain: () => null,
      reminder: false,
    }),
  );
  assert.equal(out, null);
  assert.ok(!calls.some((c) => c === "make check"));
});

// ---- a disabled rule never hides an enabled one

void test("a disabled rule never hides an enabled one on the same command", async () => {
  const both = 'git commit -m "bad" && rm -rf ~/build';
  // title off, risky on: the risky step still asks
  const a = setup({ env: OFF_ENV("-title") });
  await a(prompt("/ship"));
  assert.equal(verdict(await a(shell(both))), "ask");
  // risky off, title on: the bad title still denies (with risky on, its ask comes first)
  const b = setup({ env: OFF_ENV("-risky") });
  await b(prompt("/ship"));
  const denied = decision(await b(shell(both)));
  assert.equal(denied?.permissionDecision, "deny");
  assert.match(
    denied.permissionDecisionReason ?? "",
    /not a Conventional Commit/,
  );
  const c = setup();
  await c(prompt("/ship"));
  assert.equal(verdict(await c(shell(both))), "ask");
  // skills off, title on
  const d = setup({ env: OFF_ENV("-skills") });
  assert.equal(verdict(await d(shell('git commit -m "bad"'))), "deny");
  // hints off, skills on: the skill deny still comes
  const e = setup({ env: OFF_ENV("-hints") });
  assert.equal(verdict(await e(shell("git commit"))), "deny");
  // risky off, a secret in the push still denies
  const seen: string[] = [];
  const f = setup({
    env: OFF_ENV("-risky", { GUARD_PUSH_SCAN: "on" }),
    run: scanning(seen),
  });
  assert.equal(verdict(await f(shell("git push --force-with-lease"))), "deny");
});

// ---- an invalid value

void test("an invalid GUARD_RULES keeps every rule on and says so once per session", async () => {
  const events: [string, Record<string, unknown>][] = [];
  const h = setup({
    env: OFF_ENV("none,rsiky"),
    emit: (e, a) => {
      events.push([e, a]);
    },
  });
  const first = await h(shell("ls"));
  assert.match(decision(first)?.additionalContext ?? "", /GUARD_RULES.*rsiky/);
  assert.match(parsed(first).systemMessage ?? "", /rsiky/);
  const second = await h(shell("ls"));
  assert.equal(decision(second), undefined);
  assert.equal(parsed(second).systemMessage, undefined);
  assert.deepEqual(
    events.filter(([e]) => e === "guard.reminder").map(([, a]) => a.rule),
    ["guard-rules"],
  );
  // defaults apply: the risky ask is still there, the bad title still denied
  assert.equal(verdict(await h(shell("rm -rf ~/x"))), "ask");
});
