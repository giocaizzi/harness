// The stacked-PR hint through the hook: shown once per agent, off with GUARD_STACK_HINT, and the same in opencode and pi.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { handle, pythonManager } from "./guard.mjs";
import type { HandleResult } from "./guard.mjs";
import { GuardPlugin } from "./opencode.mjs";
import type { OpencodeClient } from "./opencode.mjs";
import guardExtension from "./pi.mjs";
import type { PiApp, PiContext } from "./pi.mjs";
import type { HookOutputPayload } from "./types.mjs";

delete process.env.GUARD_STACK_HINT;
delete process.env.GUARD_UNATTENDED;
for (const k of [
  "FACTORY_RUN_ID",
  "FACTORY_TICKET",
  "FACTORY_ATTENDED_RUN_ID",
  "FACTORY_ATTENDED_TICKET",
]) {
  Reflect.deleteProperty(process.env, k);
}

interface FakeRunResult {
  calls: string[];
  run: (argv: readonly string[]) => Promise<string | null>;
}

// feat/b (HEAD) is built on feat/a (#7), which is not in main.
const fakeRun = (): FakeRunResult => {
  const calls: string[] = [];
  const run = async (argv: readonly string[]): Promise<string | null> => {
    await Promise.resolve();
    const a = argv.join(" ");
    calls.push(a);
    if (argv[1] === "symbolic-ref") return "origin/main\n";
    if (argv[1] === "rev-parse") return "feat/b\n";
    if (argv[0] === "gh" && argv[2] === "view") {
      return JSON.stringify({ headRefName: "feat/b", baseRefName: "main" });
    }
    if (argv[0] === "gh" && argv[2] === "list") {
      return JSON.stringify([{ number: 7, headRefName: "feat/a" }]);
    }
    if (argv[1] === "merge-base") {
      return argv[4] === "origin/main" ? null : "";
    }
    return null;
  };
  return { run, calls };
};

const tmp = (): string => mkdtempSync(join(tmpdir(), "stack-test-"));

const stackCalls = (calls: readonly string[]): string[] =>
  calls.filter((c) =>
    /symbolic-ref|merge-base|gh pr list|gh pr view|gh repo view/.test(c),
  );

const decision = (
  out: HandleResult,
):
  | {
      additionalContext?: string;
      permissionDecision?: string;
      permissionDecisionReason?: string;
    }
  | undefined =>
  out.stdout
    ? (JSON.parse(out.stdout) as HookOutputPayload).hookSpecificOutput
    : undefined;

const pre = (
  command: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  session_id: "s1",
  cwd: "/",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
  ...extra,
});

const setup = (
  env: Record<string, string | undefined> = {},
): {
  calls: string[];
  h: (input: Record<string, unknown>) => Promise<HandleResult>;
} => {
  const { run, calls } = fakeRun();
  const dataDir = tmp();
  const h = (input: Record<string, unknown>): Promise<HandleResult> =>
    handle(input, {
      dataDir,
      env: env,
      hostFacts: async () => {
        await Promise.resolve();
        return {};
      },
      run,
      pythonManager,
    });
  return { h, calls };
};

const load = (
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  session_id: "s1",
  hook_event_name: "UserPromptSubmit",
  prompt: "/ship",
  ...extra,
});

void test("the stack hint comes once per agent, each agent getting its own", async () => {
  const { h } = setup();
  await h(load());
  const first = decision(await h(pre("gh pr create --fill")));
  assert.match(
    first?.additionalContext ?? "",
    /#7 \(`feat\/a`\).*targets `main`/,
  );
  assert.equal(first?.permissionDecision, undefined);
  assert.equal(decision(await h(pre("gh pr create --fill"))), undefined);
  assert.match(
    decision(await h(pre("gh pr merge 9 --squash", { agent_id: "a2" })))
      ?.additionalContext ?? "",
    /#7/,
  );
  assert.equal(
    decision(await h(pre("gh pr merge 9 --squash", { agent_id: "a2" }))),
    undefined,
  );
});

void test("GUARD_STACK_HINT off (also 0, false) gathers nothing and shows nothing", async () => {
  for (const v of ["off", "0", "false"]) {
    const { h, calls } = setup({ GUARD_STACK_HINT: v });
    await h(load());
    assert.equal(decision(await h(pre("gh pr create --fill"))), undefined, v);
    assert.deepEqual(stackCalls(calls), [], v);
  }
});

void test("other commands and a spent hint cost no lookups", async () => {
  const { h, calls } = setup();
  await h(load());
  await h(pre("gh pr view 3"));
  await h(pre("git status"));
  assert.deepEqual(stackCalls(calls), []);
  await h(pre("gh pr create --fill"));
  const n = calls.length;
  await h(pre("gh pr create --fill"));
  assert.equal(calls.length, n);
});

void test("opencode and pi: the hint reaches the model through the tool output, once", async () => {
  const deps = () => ({
    hostFacts: async () => {
      await Promise.resolve();
      return {};
    },
    run: fakeRun().run,
    emit: async () => {
      await Promise.resolve();
    },
    launch: () => null,
    dataDir: tmp(),
  });
  const mockClient = {
    session: {
      get: async () => {
        await Promise.resolve();
        return null;
      },
      prompt: async () => {
        await Promise.resolve();
      },
    },
    tui: {
      showToast: async () => {
        await Promise.resolve();
      },
    },
  } as unknown as OpencodeClient;
  const hooks = await GuardPlugin(
    { client: mockClient, directory: tmp() },
    deps(),
  );

  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "bash", sessionID: "e", callID: "c0" },
      { args: { command: "gh pr create --fill" } },
    ),
  );
  const output = { args: { command: "gh pr create --fill" }, output: "done" };
  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "e", callID: "c1" },
    output,
  );
  await hooks["tool.execute.after"](
    { tool: "bash", sessionID: "e", callID: "c1", args: output.args },
    output,
  );
  assert.match(output.output, /^done\n\n.*#7 \(`feat\/a`\)/);

  const handlers: Record<string, (e: unknown, ctx: PiContext) => unknown> = {};
  const mockPiApp: PiApp = {
    on: ((e: string, f: (ev: unknown, ctx: PiContext) => unknown) => {
      handlers[e] = f;
    }) as PiApp["on"],
    sendUserMessage: async () => {
      await Promise.resolve();
    },
  };
  guardExtension(mockPiApp, deps());

  const ctx: PiContext = {
    cwd: tmp(),
    sessionManager: { getSessionId: () => "p" },
    ui: {
      confirm: async () => {
        await Promise.resolve();
        return true;
      },
      notify: () => {
        /* noop */
      },
    },
  };
  const call = async (id: string) => {
    const fn = handlers.tool_call;
    return (await fn?.(
      {
        toolName: "bash",
        toolCallId: id,
        input: { command: "gh pr create --fill" },
      },
      ctx,
    )) as { block?: boolean } | undefined;
  };
  const result = async (id: string) => {
    const fn = handlers.tool_result;
    return (await fn?.(
      { toolName: "bash", toolCallId: id, input: {}, content: [] },
      ctx,
    )) as { content?: { text?: string }[] } | undefined;
  };

  assert.equal((await call("t0"))?.block, true);
  await call("t1");
  const res1 = await result("t1");
  assert.match(res1?.content?.[0]?.text ?? "", /#7 \(`feat\/a`\)/);
  await call("t2");
  assert.equal(await result("t2"), undefined);
});

void test("the hint lookups share one deadline: no call starts after it, and each timeout fits what is left", async () => {
  const seen: (number | undefined)[] = [];
  const run = async (
    argv: readonly string[],
    _cwd?: string,
    ms?: number,
  ): Promise<string | null> => {
    seen.push(ms);
    await new Promise((r) => setTimeout(r, 40));
    if (argv[1] === "symbolic-ref") return "origin/main\n";
    if (argv[1] === "rev-parse") return "feat/b\n";
    if (argv[2] === "list") {
      return JSON.stringify([{ number: 7, headRefName: "feat/a" }]);
    }
    return null;
  };
  const dataDir = tmp();
  const h = (input: Record<string, unknown>): Promise<HandleResult> =>
    handle(input, {
      dataDir,
      env: {},
      hostFacts: async () => {
        await Promise.resolve();
        return {};
      },
      run,
      pythonManager,
      factsMs: 100,
    });
  await h(load());
  const out = await h(pre("gh pr create --fill"));
  assert.equal(decision(out), undefined);
  assert.ok(seen.length >= 1);
  assert.ok(
    seen.every(
      (ms): ms is number => typeof ms === "number" && ms > 0 && ms <= 100,
    ),
    String(seen),
  );
  const n = seen.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(seen.length, n, "no call starts after the deadline");
});
