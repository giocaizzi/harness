// The in-process adapters (opencode, pi) over a fake harness API: the guard's decisions reach the harness.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

import { createGuard } from "./bridge.mjs";
import { GuardPlugin } from "./opencode.mjs";
import type { OpencodeClient } from "./opencode.mjs";
import guardExtension from "./pi.mjs";
import type { PiApp, PiContext } from "./pi.mjs";
import type { GuardDeps } from "./types.mjs";

const inheritedParentSession = process.env.GUARD_PARENT_SESSION;
const inheritedAgentId = process.env.GUARD_AGENT_ID;

beforeEach(() => {
  delete process.env.GUARD_PARENT_SESSION;
  delete process.env.GUARD_AGENT_ID;
});

afterEach(() => {
  if (inheritedParentSession === undefined)
    delete process.env.GUARD_PARENT_SESSION;
  else process.env.GUARD_PARENT_SESSION = inheritedParentSession;
  if (inheritedAgentId === undefined) delete process.env.GUARD_AGENT_ID;
  else process.env.GUARD_AGENT_ID = inheritedAgentId;
});

delete process.env.GUARD_STOP_CHECK;
delete process.env.GUARD_UNATTENDED;
for (const k of [
  "FACTORY_RUN_ID",
  "FACTORY_TICKET",
  "FACTORY_ATTENDED_RUN_ID",
  "FACTORY_ATTENDED_TICKET",
  "FACTORY_RUN_FILE",
  "FACTORY_EVENTS_FILE",
  "FACTORY_PROTECTED_PATHS",
  "FACTORY_RESULT_CHECKER",
  "GUARD_RESULT_GATE",
  "GUARD_RUN_MANIFEST",
  "GUARD_RUN_ID",
  "GUARD_RUN_TICKET",
  "GUARD_RUN_MODE",
  "GUARD_RUN_FILE",
  "GUARD_RUN_EVENTS_FILE",
]) {
  Reflect.deleteProperty(process.env, k);
}

const dir = (files: Record<string, string> = {}): string => {
  const d = mkdtempSync(join(tmpdir(), "adapter-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(d, name), content);
  }
  return d;
};

const deps = (): GuardDeps => ({
  hostFacts: async () => {
    await Promise.resolve();
    return {};
  },
  run: async () => {
    await Promise.resolve();
    return null;
  },
  emit: async () => {
    await Promise.resolve();
  },
  launch: () => null,
  dataDir: dir(),
});

const forced = async (fn: () => Promise<void>): Promise<void> => {
  process.env.GUARD_STOP_CHECK = "force";
  try {
    await fn();
  } finally {
    delete process.env.GUARD_STOP_CHECK;
  }
};

interface FakePiResult {
  api: PiApp;
  handlers: Record<string, (event: unknown, ctx: PiContext) => unknown>;
  sent: string[];
}

const fakePi = (): FakePiResult => {
  const handlers: Record<string, (event: unknown, ctx: PiContext) => unknown> =
    {};
  const sent: string[] = [];
  return {
    handlers,
    sent,
    api: {
      on: ((e: string, f: (ev: unknown, ctx: PiContext) => unknown) => {
        handlers[e] = f;
      }) as PiApp["on"],
      sendUserMessage: async (m: string) => {
        await Promise.resolve();
        sent.push(m);
      },
    },
  };
};

void test("opencode: a denied command throws, a risky one too (no ask), a plain one passes", async () => {
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
    { client: mockClient, directory: dir({ "uv.lock": "" }) },
    deps(),
  );
  const before = (command: string) =>
    hooks["tool.execute.before"](
      { tool: "bash", sessionID: "s", callID: "c" },
      { args: { command } },
    );
  await assert.rejects(before("pip install x"), /uses uv/);
  await assert.rejects(before("rm -rf ~/x"), /cannot ask/);
  await before("ls");
});

void test("opencode: the config hook appends bash asks last, and a covered risky command is left to opencode", async () => {
  const sessionPermission: {
    action?: string;
    pattern?: string;
    permission?: string;
  }[] = [];
  const client = {
    session: {
      get: async () => {
        await Promise.resolve();
        return { data: { permission: sessionPermission } };
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
  const hooks = await GuardPlugin({ client, directory: dir() }, deps());
  const cfg = {
    permission: { bash: { "rm -rf *": "allow", "*": "allow" }, "*": "allow" },
    agent: {
      scout: { permission: { edit: "deny" } },
      x: {},
    },
  };
  await hooks.config(cfg);
  assert.deepEqual(Object.keys(cfg.permission), ["*", "bash"]);
  const bash = Object.entries(cfg.permission.bash);
  assert.deepEqual(bash[0], ["*", "allow"]);
  assert.deepEqual(bash[bash.length - 1], ["security dump-keychain *", "ask"]);
  assert.equal(cfg.permission.bash["rm -rf *"], "ask");
  assert.equal(
    (cfg.agent.scout.permission as { bash?: Record<string, string> }).bash?.[
      "git reset --hard *"
    ],
    "ask",
  );
  assert.equal((cfg.agent.x as { permission?: unknown }).permission, undefined);
  const before = (command: string) =>
    hooks["tool.execute.before"](
      { tool: "bash", sessionID: "s", callID: "c" },
      { args: { command } },
    );
  await before("rm -rf build");
  await assert.rejects(before("cd . && rm -rf build"), /cannot ask/);
  await assert.rejects(before("rm -rf ~/x"), /cannot ask/);
  sessionPermission.push({
    permission: "bash",
    pattern: "*",
    action: "allow",
  });
  await assert.rejects(before("rm -rf build"), /cannot ask/);
});

void test("opencode: `run --auto` approves asks itself, so the guard denies", async () => {
  for (const flag of [
    ["--auto"],
    ["--auto=true"],
    ["--auto", "true"],
    ["--auto=1"],
  ]) {
    const client = {
      session: {
        get: async () => {
          await Promise.resolve();
          return { data: {} };
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
      { client, directory: dir() },
      {
        ...deps(),
        argv: ["bun", "/$bunfs/root/src/index.js", "run", ...flag, "go"],
      },
    );
    await hooks.config({ permission: { bash: "allow" } });
    await assert.rejects(
      hooks["tool.execute.before"](
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: "rm -rf build" } },
      ),
      /cannot ask/,
      flag.join(" "),
    );
  }
});

void test("opencode: a user deny on bash skips the asks, so the guard keeps denying", async () => {
  for (const permission of [
    "deny",
    { bash: { "rm *": "deny" } },
    { "*": "deny" },
  ]) {
    const client = {
      session: {
        get: async () => {
          await Promise.resolve();
          return { data: {} };
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
    const hooks = await GuardPlugin({ client, directory: dir() }, deps());
    const cfg = { permission };
    await hooks.config(cfg);
    assert.deepEqual(cfg.permission, permission);
    await assert.rejects(
      hooks["tool.execute.before"](
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: "rm -rf ~/x" } },
      ),
      /cannot ask/,
    );
  }
});

void test("opencode and pi: a shell file edit gets the edit-tool reminder in the tool output, once", async () => {
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
    { client: mockClient, directory: dir() },
    deps(),
  );
  const output = {
    args: { command: "sed -i 's/a/b/' f.txt" },
    output: "done",
  };
  await hooks["tool.execute.before"](
    { tool: "bash", sessionID: "e", callID: "c1" },
    output,
  );
  await hooks["tool.execute.after"](
    { tool: "bash", sessionID: "e", callID: "c1", args: output.args },
    output,
  );
  assert.match(
    output.output,
    /^done\n\nEdit files with the harness's edit tool/,
  );
  const { handlers, api } = fakePi();
  guardExtension(api, deps());
  const ctx: PiContext = {
    cwd: dir(),
    sessionManager: { getSessionId: () => "e" },
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
    await Promise.resolve();
    const fn = handlers.tool_call;
    return fn?.(
      {
        toolName: "bash",
        toolCallId: id,
        input: { command: "echo x > notes.md" },
      },
      ctx,
    );
  };
  const result = async (id: string) => {
    const fn = handlers.tool_result;
    return (await fn?.(
      { toolName: "bash", toolCallId: id, input: {}, content: [] },
      ctx,
    )) as { content?: { text?: string }[] } | undefined;
  };
  await call("t1");
  const res1 = await result("t1");
  assert.match(res1?.content?.[0]?.text ?? "", /edit tool/);
  await call("t2");
  assert.equal(await result("t2"), undefined);
});

void test("opencode: a failing make check on idle is sent back once", async () => {
  const sent: { body: { parts: { text: string; type: string }[] } }[] = [];
  const client = {
    session: {
      get: async () => {
        await Promise.resolve();
        return null;
      },
      prompt: async (p: {
        body: { parts: { text: string; type: string }[] };
      }) => {
        await Promise.resolve();
        sent.push(p);
      },
    },
    tui: {
      showToast: async () => {
        await Promise.resolve();
      },
    },
  } as unknown as OpencodeClient;
  const hooks = await GuardPlugin(
    { client, directory: dir({ Makefile: "check:\n\t@false\n" }) },
    deps(),
  );
  const idle = () =>
    hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    });
  await forced(async () => {
    await idle();
    await idle();
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0]);
  const msg0 = sent[0] as { body: { parts: { text: string }[] } };
  const part0 = msg0.body.parts[0];
  assert.ok(part0);
  assert.match(part0.text, /make check failed/);
});

void test("opencode: a subagent's idle session (it has a parent) runs no check", async () => {
  const sent: unknown[] = [];
  const client = {
    session: {
      get: async () => {
        await Promise.resolve();
        return { data: { parentID: "p" } };
      },
      prompt: async (p: unknown) => {
        await Promise.resolve();
        sent.push(p);
      },
    },
    tui: {
      showToast: async () => {
        await Promise.resolve();
      },
    },
  } as unknown as OpencodeClient;
  const hooks = await GuardPlugin(
    { client, directory: dir({ Makefile: "check:\n\t@false\n" }) },
    deps(),
  );
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "child" } },
  });
  assert.equal(sent.length, 0);
});

void test("opencode and pi: a docs-only change runs no check on idle or settle; a code change does", async () => {
  const repo = (): string => {
    const cwd = dir({ Makefile: "check:\n\t@false\n", "a.py": "a = 1\n" });
    const git = (...args: readonly string[]) =>
      execFileSync(
        "git",
        ["-c", "user.email=a@b", "-c", "user.name=a", ...args],
        { cwd, stdio: "ignore" },
      );
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "init");
    writeFileSync(join(cwd, "README.md"), "# docs\n");
    return cwd;
  };
  Object.assign(process.env, {
    CLAUDE_PLUGIN_DATA: dir(),
    GUARD_STOP_CHECK: "force",
  });
  try {
    const sent: unknown[] = [];
    const docs = repo();
    const client = {
      session: {
        get: async () => {
          await Promise.resolve();
          return null;
        },
        prompt: async (p: unknown) => {
          await Promise.resolve();
          sent.push(p);
        },
      },
      tui: {
        showToast: async () => {
          await Promise.resolve();
        },
      },
    } as unknown as OpencodeClient;
    const hooks = await GuardPlugin({ client, directory: docs }, deps());
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    });
    const { handlers, sent: piSent, api } = fakePi();
    guardExtension(api, deps());
    const piCtx: PiContext = {
      cwd: docs,
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
    await handlers.agent_settled?.({ aborted: false }, piCtx);
    assert.equal(sent.length + piSent.length, 0);
    const code = repo();
    writeFileSync(join(code, "a.py"), "a = 2\n");
    await handlers.agent_settled?.({ aborted: false }, { ...piCtx, cwd: code });
    assert.match(piSent[0] ?? "", /make check failed/);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.GUARD_STOP_CHECK;
  }
});

// A registered run: a trusted temp manifest (out of reach of this user through the PrepareOptions probes, as
// hooks/session.test.mts does), its variables on process.env (the bridge's stop reads them there) and a data dir of
// its own. Everything is restored afterwards.
const OUT_OF_REACH = {
  writable: () => false,
  owner: () => false,
  readOnlyMount: () => false,
};
const TEMPLATE = ".acme/runs/{ticket_number}/result.json";
const trusted = (): GuardDeps => ({ ...deps(), runVet: OUT_OF_REACH });
const writeManifest = (body: Record<string, unknown>): string => {
  const file = join(dir(), "run.json");
  writeFileSync(
    file,
    JSON.stringify({ contract: 2, runner: "acme-runner", ...body }),
  );
  return file;
};
const resultManifest = (checker?: string): string =>
  writeManifest({
    requires: ["result-gate"],
    result: { file: TEMPLATE, ...(checker ? { checker } : {}) },
  });
const checkerFile = (body: string): string => {
  const file = join(dir(), "checker.mjs");
  writeFileSync(file, body);
  return file;
};
const withEnv = async (
  vars: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> => {
  const saved = Object.entries(process.env).filter(([k]) => k in vars);
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const k of Object.keys(vars)) Reflect.deleteProperty(process.env, k);
    for (const [k, v] of saved) process.env[k] = v;
  }
};
const registeredRun = async (
  manifest: string,
  fn: (cwd: string) => Promise<void>,
  extra: Record<string, string> = {},
): Promise<void> => {
  const cwd = dir();
  execFileSync("git", ["init", "-q", cwd]);
  await withEnv(
    {
      GUARD_RUN_MANIFEST: manifest,
      GUARD_RUN_ID: "run-1",
      GUARD_RUN_TICKET: "acme/app#12",
      CLAUDE_PLUGIN_DATA: dir(),
      ...extra,
    },
    () => fn(cwd),
  );
};
const ocClient = (sent?: string[]): OpencodeClient =>
  ({
    session: {
      get: async () => {
        await Promise.resolve();
        return null;
      },
      prompt: async (p: { body: { parts: { text: string }[] } }) => {
        await Promise.resolve();
        sent?.push(p.body.parts[0]?.text ?? "");
      },
    },
    tui: {
      showToast: async () => {
        await Promise.resolve();
      },
    },
  }) as unknown as OpencodeClient;
const piCtx = (cwd: string): PiContext => ({
  cwd,
  sessionManager: { getSessionId: () => "p1" },
  ui: {
    confirm: async () => {
      await Promise.resolve();
      return true;
    },
    notify: () => {
      /* noop */
    },
  },
});
const idle = (hooks: Awaited<ReturnType<typeof GuardPlugin>>) =>
  hooks.event({
    event: { type: "session.idle", properties: { sessionID: "s" } },
  });

void test("opencode: a registered run without a valid result.json is sent the result gate on idle, twice at most", async () => {
  await registeredRun(resultManifest(), async (cwd) => {
    const sent: string[] = [];
    const hooks = await GuardPlugin(
      { client: ocClient(sent), directory: cwd },
      trusted(),
    );
    for (let i = 0; i < 3; i++) await idle(hooks);
    assert.equal(sent.length, 2);
    assert.match(
      sent[0] ?? "",
      /^Run result gate \(block 1 of 2\)[\s\S]*Fix the result file/,
    );
    assert.match(sent[1] ?? "", /^Run result gate \(block 2 of 2\)/);
  });
});

void test("pi: deny blocks, ask confirms through the UI and blocks without one", async () => {
  const { handlers, api } = fakePi();
  guardExtension(api, deps());
  const cwd = dir({ "uv.lock": "" });
  const ctx = (confirm?: boolean): PiContext => ({
    cwd,
    hasUI: confirm !== undefined,
    ui: {
      confirm: async () => {
        await Promise.resolve();
        return confirm ?? false;
      },
      notify: () => {
        /* noop */
      },
    },
    sessionManager: { getSessionId: () => "s" },
  });
  const call = async (command: string, c: PiContext) => {
    const fn = handlers.tool_call;
    return (await fn?.(
      { toolName: "bash", toolCallId: "t", input: { command } },
      c,
    )) as { block?: boolean; reason?: string } | undefined;
  };
  const res1 = await call("pip install x", ctx());
  assert.match(res1?.reason ?? "", /uses uv/);
  assert.equal(await call("rm -rf ~/x", ctx(true)), undefined);
  assert.equal((await call("rm -rf ~/x", ctx(false)))?.block, true);
  assert.equal((await call("rm -rf ~/x", ctx()))?.block, true);
});

void test("opencode and pi: GUARD_UNATTENDED turns a risky ask into a deny, even with a UI that would confirm", async () => {
  const env: NodeJS.ProcessEnv = { GUARD_UNATTENDED: "1" };
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
  const oc = await GuardPlugin(
    { client: mockClient, directory: dir() },
    { ...deps(), env },
  );
  await assert.rejects(
    oc["tool.execute.before"](
      { tool: "bash", sessionID: "s", callID: "c" },
      { args: { command: "rm -rf ~/x" } },
    ),
    /Unattended run/,
  );
  const { handlers, api } = fakePi();
  guardExtension(api, { ...deps(), env });
  const ctx: PiContext = {
    cwd: dir(),
    hasUI: true,
    ui: {
      confirm: async () => {
        await Promise.resolve();
        return true;
      },
      notify: () => {
        /* noop */
      },
    },
    sessionManager: { getSessionId: () => "s" },
  };
  const blocked = (await handlers.tool_call?.(
    { toolName: "bash", toolCallId: "t", input: { command: "rm -rf ~/x" } },
    ctx,
  )) as { block?: boolean; reason?: string } | undefined;
  assert.ok(blocked);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason ?? "", /Unattended run/);
});

interface EventFileLine {
  cmd_hash?: string;
  decision?: string;
  span_id?: string;
  trace_id?: string;
}

void test("opencode and pi: GUARD_TRACEPARENT adds trace_id and span_id to the events file line, a malformed one adds neither", async () => {
  const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const lines = (file: string): EventFileLine[] =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as EventFileLine);

  const cases: readonly (readonly [
    string,
    readonly [string | undefined, string | undefined],
  ])[] = [
    [tp, ["4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"]],
    [tp.toUpperCase(), [undefined, undefined]],
  ];
  for (const [value, want] of cases) {
    const ocFile = join(dir(), "events.jsonl");
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
    const oc = await GuardPlugin(
      { client: mockClient, directory: dir() },
      {
        ...deps(),
        env: { GUARD_RUN_EVENTS_FILE: ocFile, GUARD_TRACEPARENT: value },
      },
    );
    await assert.rejects(
      oc["tool.execute.before"](
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: 'git commit -m "bad title"' } },
      ),
      /Conventional/,
    );
    const piFile = join(dir(), "events.jsonl");
    const { handlers, api } = fakePi();
    guardExtension(api, {
      ...deps(),
      env: { GUARD_RUN_EVENTS_FILE: piFile, GUARD_TRACEPARENT: value },
    });
    const blocked = (await handlers.tool_call?.(
      {
        toolName: "bash",
        toolCallId: "t",
        input: { command: 'git commit -m "bad title"' },
      },
      {
        cwd: dir(),
        hasUI: false,
        sessionManager: { getSessionId: () => "s" },
        ui: {
          confirm: async () => {
            await Promise.resolve();
            return true;
          },
          notify: () => {
            /* noop */
          },
        },
      },
    )) as { block?: boolean } | undefined;
    assert.equal(blocked?.block, true);
    for (const file of [ocFile, piFile]) {
      const line = lines(file)[0];
      assert.equal(line?.decision, "deny");
      assert.deepEqual([line.trace_id, line.span_id], want, `${file} ${value}`);
    }
  }
});

interface OtelExportBody {
  resourceLogs: {
    scopeLogs: {
      logRecords: {
        body: { stringValue: string };
        spanId: string;
        traceId: string;
      }[];
    }[];
  }[];
}

void test("pi: the default emit sends the guard.decision OTLP record with traceId and spanId", async () => {
  const sent: OtelExportBody[] = [];
  const keys = [
    "GUARD_OTEL",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "GUARD_OTEL_EXPORTER_OTLP_ENDPOINT",
    "GUARD_TRACEPARENT",
    "GUARD_RUN_EVENTS_FILE",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  Object.assign(process.env, {
    GUARD_OTEL: "",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
    GUARD_TRACEPARENT:
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    GUARD_RUN_EVENTS_FILE: "",
  });
  globalThis.fetch = (async (_: unknown, init: { body: string }) => {
    await Promise.resolve();
    sent.push(JSON.parse(init.body) as OtelExportBody);
    return { ok: true } as Response;
  }) as typeof fetch;

  try {
    const { handlers, api } = fakePi();
    const rest = { ...deps() };
    Reflect.deleteProperty(rest, "emit");
    guardExtension(api, rest);
    const blocked = (await handlers.tool_call?.(
      {
        toolName: "bash",
        toolCallId: "t",
        input: { command: 'git commit -m "bad title"' },
      },
      {
        cwd: dir(),
        hasUI: false,
        sessionManager: { getSessionId: () => "s" },
        ui: {
          confirm: async () => {
            await Promise.resolve();
            return true;
          },
          notify: () => {
            /* noop */
          },
        },
      },
    )) as { block?: boolean } | undefined;
    assert.equal(blocked?.block, true);
    for (let i = 0; i < 50 && !sent.length; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        Reflect.deleteProperty(process.env, k);
      } else {
        process.env[k] = v;
      }
    }
  }
  const rec = sent
    .flatMap((b) => b.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [])
    .find((r) => r.body.stringValue === "guard.decision");
  assert.deepEqual(
    [rec?.traceId, rec?.spanId],
    ["4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"],
  );
});

void test("pi: every ask outcome is logged as guard.ask_result with its class; no UI is unavailable via no-ui", async () => {
  const { handlers, api } = fakePi();
  const events: [string, unknown, unknown, unknown][] = [];
  guardExtension(api, {
    ...deps(),
    emit: async (event, attrs) => {
      await Promise.resolve();
      events.push([event, attrs.result, attrs.via, attrs.cmd_class]);
    },
  });
  const cwd = dir();
  const ctx = (confirm?: boolean): PiContext => ({
    cwd,
    hasUI: confirm !== undefined,
    ui: {
      confirm: async () => {
        await Promise.resolve();
        return confirm ?? false;
      },
      notify: () => {
        /* noop */
      },
    },
    sessionManager: { getSessionId: () => "s" },
  });
  const call = async (c: PiContext) => {
    const fn = handlers.tool_call;
    return (await fn?.(
      { toolName: "bash", toolCallId: "t", input: { command: "rm -rf ~/x" } },
      c,
    )) as { reason?: string } | undefined;
  };
  await call(ctx(true));
  assert.match(
    (await call(ctx(false)))?.reason ?? "",
    /The user denied this command/,
  );
  assert.match((await call(ctx()))?.reason ?? "", /No UI to confirm/);
  assert.deepEqual(
    events.filter(([e]) => e === "guard.ask_result"),
    [
      ["guard.ask_result", "allow", undefined, "files"],
      ["guard.ask_result", "deny", undefined, "files"],
      ["guard.ask_result", "unavailable", "no-ui", "files"],
    ],
  );
});

void test("pi: ask confirms pass timeout option and handle timeout vs deny vs allow", async () => {
  const { handlers, api } = fakePi();
  const events: [string, unknown, unknown][] = [];
  guardExtension(api, {
    ...deps(),
    emit: async (event, attrs) => {
      await Promise.resolve();
      events.push([event, attrs.result, attrs.waitMs !== undefined]);
    },
  });
  const cwd = dir();
  let capturedOpts: { signal?: AbortSignal; timeout?: number } | undefined;

  const makeCtx = (
    confirmFn: (
      title: string,
      msg?: string,
      opts?: { signal?: AbortSignal; timeout?: number },
    ) => Promise<boolean | undefined>,
  ): PiContext => ({
    cwd,
    hasUI: true,
    ui: {
      confirm: async (title, msg, opts) => {
        capturedOpts = opts;
        return confirmFn(title, msg, opts);
      },
      notify: () => {
        /* noop */
      },
    },
    sessionManager: { getSessionId: () => "s" },
  });

  const call = async (c: PiContext) => {
    const fn = handlers.tool_call;
    return (await fn?.(
      { toolName: "bash", toolCallId: "t", input: { command: "rm -rf ~/x" } },
      c,
    )) as { block?: boolean; reason?: string } | undefined;
  };

  // 1. By default, passes { timeout: 60000 }
  // When confirm returns undefined (timeout), records "timeout" and returns block with "No answer"
  capturedOpts = undefined;
  const timeoutRes = await call(
    makeCtx(async () => {
      await Promise.resolve();
      return undefined;
    }),
  );
  assert.deepEqual(capturedOpts, { timeout: 60000 });
  assert.equal(timeoutRes?.block, true);
  assert.match(
    timeoutRes.reason ?? "",
    /No answer: nobody confirmed this command within 60s/,
  );

  // 2. When confirm returns false (explicit deny), records "deny" and returns block with "user denied"
  const denyRes = await call(
    makeCtx(async () => {
      await Promise.resolve();
      return false;
    }),
  );
  assert.equal(denyRes?.block, true);
  assert.match(denyRes.reason ?? "", /The user denied this command/);

  // 3. When confirm returns true (allow), records "allow" and does not block
  const allowRes = await call(
    makeCtx(async () => {
      await Promise.resolve();
      return true;
    }),
  );
  assert.equal(allowRes, undefined);

  // 4. GUARD_ASK_TIMEOUT_MS=0 passes undefined for timeout
  const oldEnv = process.env.GUARD_ASK_TIMEOUT_MS;
  try {
    process.env.GUARD_ASK_TIMEOUT_MS = "0";
    capturedOpts = undefined;
    await call(
      makeCtx(async () => {
        await Promise.resolve();
        return true;
      }),
    );
    assert.equal(capturedOpts, undefined);
  } finally {
    if (oldEnv === undefined) delete process.env.GUARD_ASK_TIMEOUT_MS;
    else process.env.GUARD_ASK_TIMEOUT_MS = oldEnv;
  }

  assert.deepEqual(
    events.filter(([e]) => e === "guard.ask_result").map(([, res]) => res),
    ["timeout", "deny", "allow", "allow"],
  );
});

void test("pi: a failing make check on settle is sent back once, an aborted run is left alone", async () => {
  const { handlers, sent, api } = fakePi();
  guardExtension(api, deps());
  const ctx: PiContext = {
    cwd: dir({ Makefile: "check:\n\t@false\n" }),
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
  await forced(async () => {
    await handlers.agent_settled?.({ aborted: true }, ctx);
    await handlers.agent_settled?.({ aborted: false }, ctx);
    await handlers.agent_settled?.({ aborted: false }, ctx);
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /make check failed/);
});

void test("pi: a registered run without a valid result.json is sent the result gate on settle, twice at most", async () => {
  await registeredRun(resultManifest(), async (cwd) => {
    const { handlers, sent, api } = fakePi();
    guardExtension(api, trusted());
    for (let i = 0; i < 3; i++) {
      await handlers.agent_settled?.({ aborted: false }, piCtx(cwd));
    }
    assert.equal(sent.length, 2);
    assert.match(sent[0] ?? "", /^Run result gate \(block 1 of 2\)/);
    assert.match(sent[1] ?? "", /^Run result gate \(block 2 of 2\)/);
  });
});

void test("opencode and pi: a registered run that names a checker is sent the result gate on every idle and settle, with no cap", async () => {
  const checker = checkerFile("export const resultErrors = () => []");
  await registeredRun(resultManifest(checker), async (cwd) => {
    const sentOc: string[] = [];
    const hooks = await GuardPlugin(
      { client: ocClient(sentOc), directory: cwd },
      trusted(),
    );
    for (let i = 0; i < 4; i++) await idle(hooks);
    assert.equal(sentOc.length, 4);
    assert.match(
      sentOc[3] ?? "",
      /^Run result gate \(block 4; the registration names a result checker/,
    );

    const { handlers, sent, api } = fakePi();
    guardExtension(api, trusted());
    for (let i = 0; i < 4; i++) {
      await handlers.agent_settled?.({ aborted: false }, piCtx(cwd));
    }
    assert.equal(sent.length, 4);
    assert.match(sent[3] ?? "", /^Run result gate \(block 8; /);
  });
});

void test("bridge: an internal error in strict mode is a reason, not null", async () => {
  const checker = checkerFile("export const resultErrors = () => []");
  const make = (manifest: string) => {
    const spawn = () => {
      throw new Error("spawn exploded");
    };
    // the gate reports its own error through emit, which throws: that escapes the gate's catch and stopCheck, so
    // only the bridge's own catch can answer
    const emit = () => {
      throw new Error("emit exploded");
    };
    return {
      manifest,
      guard: createGuard({
        harness: "test",
        deps: { ...trusted(), spawnSync: spawn, emit },
      }),
    };
  };
  const strict = make(resultManifest(checker));
  await registeredRun(strict.manifest, async (cwd) => {
    assert.match(
      (await strict.guard.stop({ cwd })) ?? "",
      /^Run result gate: could not check the result for run run-1 \(internal error\); the registration names a result checker, so the stop stays blocked\.$/,
    );
  });
  const plain = make(resultManifest());
  await registeredRun(plain.manifest, async (cwd) => {
    assert.match(
      (await plain.guard.stop({ cwd })) ?? "",
      /^Run result gate: could not check the result for run run-1 \(internal error\); an unattended run never fails open, so the stop stays blocked\.$/,
    );
  });
  // an attended run still fails open
  const attended = make(resultManifest());
  await registeredRun(
    attended.manifest,
    async (cwd) => {
      assert.equal(await attended.guard.stop({ cwd }), null);
    },
    { GUARD_RUN_MODE: "attended" },
  );
});

void test("opencode and pi: a throwing gate in an unattended run is sent the unattended reason, an attended run nothing", async () => {
  const throwing = () => {
    throw new Error("spawn exploded");
  };
  const unattendedReason =
    /^Run result gate: could not check the result for run run-1 \(spawn exploded\); an unattended run never fails open, so the stop stays blocked\.$/;
  const send = async (cwd: string) => {
    const sentOc: string[] = [];
    const hooks = await GuardPlugin(
      { client: ocClient(sentOc), directory: cwd },
      { ...trusted(), spawnSync: throwing },
    );
    for (let i = 0; i < 3; i++) await idle(hooks);
    const { handlers, sent, api } = fakePi();
    guardExtension(api, { ...trusted(), spawnSync: throwing });
    for (let i = 0; i < 3; i++) {
      await handlers.agent_settled?.({ aborted: false }, piCtx(cwd));
    }
    return { sent, sentOc };
  };
  await registeredRun(resultManifest(), async (cwd) => {
    const { sent, sentOc } = await send(cwd);
    // no cap on a failed check
    assert.equal(sentOc.length, 3);
    assert.equal(sent.length, 3);
    for (const m of [...sentOc, ...sent]) assert.match(m, unattendedReason);
  });
  await registeredRun(
    resultManifest(),
    async (cwd) => {
      const attended = await send(cwd);
      assert.equal(attended.sentOc.length, 0);
      assert.equal(attended.sent.length, 0);
    },
    { GUARD_RUN_MODE: "attended" },
  );
});

void test("usage: opencode and pi report each assistant message once, as their own service", async () => {
  const sent: unknown[][] = [];
  const report = async (event: string, attrs: Record<string, unknown>) => {
    await Promise.resolve();
    sent.push([
      event,
      attrs.model,
      attrs.input_tokens,
      attrs.cache_read_tokens,
      attrs.cost_usd,
      attrs["session.id"],
    ]);
  };
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
    { client: mockClient, directory: dir() },
    { ...deps(), report },
  );
  const info = {
    id: "m1",
    role: "assistant",
    sessionID: "s1",
    modelID: "gpt-6.1-sol",
    providerID: "openai",
    time: { completed: true },
    tokens: {
      input: 10,
      output: 5,
      reasoning: 0,
      cache: { read: 3, write: 0 },
    },
    cost: 0.002,
  };
  await hooks.event({
    event: {
      type: "message.updated",
      properties: { info: { ...info, time: {} } },
    },
  });
  await hooks.event({
    event: { type: "message.updated", properties: { info } },
  });
  await hooks.event({
    event: { type: "message.updated", properties: { info } },
  });

  const handlers: Record<string, (e: unknown, ctx: PiContext) => unknown> = {};
  const mockPiApp: PiApp = {
    on: ((e: string, f: (ev: unknown, ctx: PiContext) => unknown) => {
      handlers[e] = f;
    }) as PiApp["on"],
    sendUserMessage: async () => {
      await Promise.resolve();
    },
  };
  guardExtension(mockPiApp, { ...deps(), report });
  const ctx: PiContext = {
    cwd: dir(),
    sessionManager: { getSessionId: () => "p1" },
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
  await handlers.message_end?.({ message: { role: "user" } }, ctx);
  await handlers.message_end?.(
    {
      message: {
        role: "assistant",
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        usage: {
          input: 7,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          cost: { total: 0.0001 },
        },
      },
    },
    ctx,
  );
  assert.deepEqual(sent, [
    ["api_request", "gpt-6.1-sol", 10, 3, 0.002, "s1"],
    ["api_request", "claude-sonnet-5-5", 7, 1, 0.0001, "p1"],
  ]);
});

void test("opencode and pi: the approval label is denied in a registered run, allowed without", async () => {
  const command = "gh issue edit 70 --add-label acme:approved";
  const manifest = writeManifest({
    requires: ["labels"],
    labels: { approval: "acme:approved", takeover: "acme:takeover" },
  });
  const env = { GUARD_RUN_MANIFEST: manifest, GUARD_RUN_ID: "run-1" };
  const why = /`acme:approved` label is registered for this run/;
  const oc = await GuardPlugin(
    { client: ocClient(), directory: dir() },
    { ...trusted(), env },
  );
  await assert.rejects(
    oc["tool.execute.before"](
      { tool: "bash", sessionID: "s", callID: "c" },
      { args: { command } },
    ),
    why,
  );
  const free = await GuardPlugin(
    { client: ocClient(), directory: dir() },
    { ...trusted(), env: {} },
  );
  await free["tool.execute.before"](
    { tool: "bash", sessionID: "s", callID: "c" },
    { args: { command } },
  );
  const { handlers, api } = fakePi();
  guardExtension(api, { ...trusted(), env });
  const blocked = (await handlers.tool_call?.(
    { toolName: "bash", toolCallId: "c", input: { command } },
    piCtx(dir()),
  )) as { block?: boolean; reason?: string } | undefined;
  assert.ok(blocked);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason ?? "", why);
  const piFree = fakePi();
  guardExtension(piFree.api, { ...trusted(), env: {} });
  const allowed = (await piFree.handlers.tool_call?.(
    { toolName: "bash", toolCallId: "c", input: { command } },
    piCtx(dir()),
  )) as { block?: boolean } | undefined;
  assert.notEqual(allowed?.block, true);
});

void test("opencode and pi: the takeover label is denied in a registered run, allowed without", async () => {
  const command = "gh issue edit 70 --add-label acme:takeover";
  const manifest = writeManifest({
    requires: ["labels"],
    labels: { approval: "acme:approved", takeover: "acme:takeover" },
  });
  const env = { GUARD_RUN_MANIFEST: manifest, GUARD_RUN_ID: "run-1" };
  const why = /`acme:takeover` label is registered for this run/;
  const oc = await GuardPlugin(
    { client: ocClient(), directory: dir() },
    { ...trusted(), env },
  );
  await assert.rejects(
    oc["tool.execute.before"](
      { tool: "bash", sessionID: "s", callID: "c" },
      { args: { command } },
    ),
    why,
  );
  const free = await GuardPlugin(
    { client: ocClient(), directory: dir() },
    { ...trusted(), env: {} },
  );
  await free["tool.execute.before"](
    { tool: "bash", sessionID: "s", callID: "c" },
    { args: { command } },
  );
  const { handlers, api } = fakePi();
  guardExtension(api, { ...trusted(), env });
  const blocked = (await handlers.tool_call?.(
    { toolName: "bash", toolCallId: "c", input: { command } },
    piCtx(dir()),
  )) as { block?: boolean; reason?: string } | undefined;
  assert.ok(blocked);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason ?? "", why);
  const piFree = fakePi();
  guardExtension(piFree.api, { ...trusted(), env: {} });
  const allowed = (await piFree.handlers.tool_call?.(
    { toolName: "bash", toolCallId: "c", input: { command } },
    piCtx(dir()),
  )) as { block?: boolean } | undefined;
  assert.notEqual(allowed?.block, true);
});

void test("opencode and pi: a stale-plugin notice reaches the user (toast, notify) and the agent (the tool output)", async () => {
  const plugins = dir();
  const root = join(plugins, "guard");
  const manifest = (v: string): void => {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ version: v }),
    );
  };
  manifest("1.0.0");
  const toasts: (string | undefined)[] = [];
  const client = {
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
      showToast: async ({ body }: { body: { message?: string } }) => {
        await Promise.resolve();
        toasts.push(body.message);
      },
    },
  } as unknown as OpencodeClient;
  const oc = await GuardPlugin(
    { client, directory: dir() },
    { ...deps(), pluginRoot: root },
  );
  const ocCall = async (id: string): Promise<string> => {
    await oc["tool.execute.before"](
      { tool: "bash", sessionID: "oc", callID: id },
      { args: { command: "ls" } },
    );
    const out = { output: "" };
    await oc["tool.execute.after"](
      { tool: "bash", sessionID: "oc", callID: id, args: {} },
      out,
    );
    return out.output;
  };
  await ocCall("c1");
  const { handlers, api } = fakePi();
  const notified: string[] = [];
  guardExtension(api, { ...deps(), pluginRoot: root });
  const ctx: PiContext = {
    cwd: dir(),
    hasUI: true,
    ui: {
      confirm: async () => {
        await Promise.resolve();
        return true;
      },
      notify: (t: string) => notified.push(t),
    },
    sessionManager: { getSessionId: () => "pi" },
  };
  await handlers.tool_call?.(
    { toolName: "bash", toolCallId: "t1", input: { command: "ls" } },
    ctx,
  );
  manifest("1.1.0");
  assert.match(
    await ocCall("c2"),
    /guard 1\.0\.0 → 1\.1\.0\): restart the session to load them\. Only the user can do this/,
  );
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(toasts, [
    "Harness plugins updated (guard 1.0.0 → 1.1.0): restart the session to load them.",
  ]);
  await handlers.tool_call?.(
    { toolName: "bash", toolCallId: "t2", input: { command: "ls" } },
    ctx,
  );
  assert.deepEqual(notified, [
    "Harness plugins updated (guard 1.0.0 → 1.1.0): run `/reload` to load them.",
  ]);
});

void test("pi: a notify that throws does not block the call", async () => {
  const plugins = dir();
  const root = join(plugins, "guard");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  const { handlers, api } = fakePi();
  guardExtension(api, { ...deps(), pluginRoot: root });
  const ctx: PiContext = {
    cwd: dir(),
    hasUI: true,
    ui: {
      confirm: async () => {
        await Promise.resolve();
        return true;
      },
      notify: () => {
        throw new Error("no UI");
      },
    },
    sessionManager: { getSessionId: () => "pi2" },
  };
  await handlers.tool_call?.(
    { toolName: "bash", toolCallId: "t1", input: { command: "ls" } },
    ctx,
  );
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ version: "1.1.0" }),
  );
  assert.equal(
    await handlers.tool_call?.(
      { toolName: "bash", toolCallId: "t2", input: { command: "ls" } },
      ctx,
    ),
    undefined,
  );
});

void test("opencode: a child session runs as its own agent of the root session; pi: a subagent child as its own agent of the parent (#172)", async () => {
  const sessions: Record<string, { parentID?: string }> = {
    child: { parentID: "root" },
    root: {},
  };
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        await Promise.resolve();
        return {
          data: sessions[path.id],
        };
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
  const dataDir = dir();
  const oc = await GuardPlugin(
    { client, directory: dir() },
    { ...deps(), dataDir },
  );
  const before = (sessionID: string, args: Record<string, unknown>) =>
    oc["tool.execute.before"](
      { tool: "skill", sessionID, callID: "c" },
      { args },
    );
  await before("child", { name: "ship" });
  const facts = readFileSync(join(dataDir, "sessions", "root.jsonl"), "utf8");
  assert.match(
    facts,
    /"loaded":"ship"/,
    "the child's skill counts for the root session",
  );

  let answer: (q: { path: { id: string } }) => Promise<unknown> = () =>
    new Promise<never>(() => {
      /* noop */
    });
  const hungClient = {
    session: {
      get: (q: { path: { id: string } }) => answer(q),
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
  const hung = await GuardPlugin(
    { client: hungClient, directory: dir() },
    { ...deps(), dataDir, rootTimeoutMs: 20 },
  );
  await hung["tool.execute.before"](
    { tool: "skill", sessionID: "lone", callID: "c" },
    { args: { name: "land" } },
  );
  assert.match(
    readFileSync(join(dataDir, "sessions", "lone.jsonl"), "utf8"),
    /"loaded":"land"/,
  );
  answer = async ({ path }: { path: { id: string } }) => {
    await Promise.resolve();
    return {
      data: path.id === "lone" ? { parentID: "root" } : {},
    };
  };
  await hung["tool.execute.before"](
    { tool: "skill", sessionID: "lone", callID: "c2" },
    { args: { name: "wt" } },
  );
  assert.match(
    readFileSync(join(dataDir, "sessions", "root.jsonl"), "utf8"),
    /"loaded":"wt"/,
    "retried after the server recovered",
  );

  process.env.GUARD_PARENT_SESSION = "p1";
  process.env.GUARD_AGENT_ID = "scout-t1";
  try {
    const { handlers, api } = fakePi();
    const piData = dir();
    guardExtension(api, { ...deps(), dataDir: piData });
    await handlers.tool_call?.(
      { toolName: "skill", toolCallId: "t", input: { name: "land" } },
      {
        cwd: dir(),
        hasUI: false,
        sessionManager: { getSessionId: () => undefined as unknown as string },
        ui: {
          confirm: async () => {
            await Promise.resolve();
            return true;
          },
          notify: () => {
            /* noop */
          },
        },
      },
    );
    assert.match(
      readFileSync(join(piData, "sessions", "p1.jsonl"), "utf8"),
      /"loaded":"land"/,
    );
  } finally {
    delete process.env.GUARD_PARENT_SESSION;
    delete process.env.GUARD_AGENT_ID;
  }
});

void test("opencode: session.created of a root session sends guard.session, a subagent child session does not", async () => {
  const events: [string, unknown, unknown][] = [];
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
    { client: mockClient, directory: dir() },
    {
      ...deps(),
      emit: async (e, a) => {
        await Promise.resolve();
        events.push([e, a.session_id, a.source]);
      },
    },
  );
  await hooks.event({
    event: {
      type: "session.created",
      properties: { info: { id: "child", parentID: "root" } },
    },
  });
  assert.deepEqual(events, []);
  await hooks.event({
    event: {
      type: "session.created",
      properties: { info: { id: "root" } },
    },
  });
  assert.deepEqual(events, [["guard.session", "root", "startup"]]);
});

void test("pi: session_start sends guard.session, a dev-tools subagent child does not", async () => {
  const events: [string, unknown][] = [];
  const { handlers, api } = fakePi();
  guardExtension(api, {
    ...deps(),
    emit: async (e, a) => {
      await Promise.resolve();
      events.push([e, a.session_id]);
    },
  });
  const ctx: PiContext = {
    cwd: dir(),
    sessionManager: { getSessionId: () => "p1" },
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
  await handlers.session_start?.({}, ctx);
  assert.deepEqual(events, [["guard.session", "p1"]]);
  process.env.GUARD_PARENT_SESSION = "parent";
  try {
    await handlers.session_start?.({}, ctx);
  } finally {
    delete process.env.GUARD_PARENT_SESSION;
  }
  assert.equal(events.length, 1);
});

// A run whose registration cannot be trusted (GUARD_RUN_ID without a manifest), and a session that sets only the
// legacy run variables (the tripwire): both deny every tool call and block the stop twice at most, in every adapter,
// with no trusted file involved.
const FAILED_RUNS: readonly {
  env: Record<string, string>;
  name: string;
  stop: RegExp;
  tool: RegExp;
}[] = [
  {
    name: "registration",
    env: { GUARD_RUN_ID: "run-1" },
    tool: /^Run registration failed: GUARD_RUN_ID is set but GUARD_RUN_MANIFEST is not\./,
    stop: /^Run registration failed: GUARD_RUN_ID is set but GUARD_RUN_MANIFEST is not\./,
  },
  {
    name: "tripwire",
    env: { FACTORY_RUN_ID: "run-1" },
    tool: /^Legacy run variables are set without a run registration/,
    stop: /^Legacy run variables are set without a run registration/,
  },
];

const eventLines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

// The tripwire's line: fixed keys, no path and no env value.
const assertTripwireLine = (file: string): void => {
  const lines = eventLines(file);
  assert.equal(lines.length, 1, "the tripwire writes its line once");
  assert.deepEqual(Object.keys(lines[0] ?? {}), [
    "ts",
    "event",
    "decision",
    "rule",
    "reason",
  ]);
  assert.equal(lines[0]?.rule, "run-unregistered");
  assert.equal(lines[0]?.decision, "deny");
};

void test("opencode: a failed registration or the legacy-only tripwire denies every tool call and re-prompts the idle twice at most", async () => {
  for (const c of FAILED_RUNS) {
    const events = join(dir(), "events.jsonl");
    await withEnv(
      { ...c.env, CLAUDE_PLUGIN_DATA: dir(), FACTORY_EVENTS_FILE: events },
      async () => {
        const sent: string[] = [];
        const hooks = await GuardPlugin(
          { client: ocClient(sent), directory: dir() },
          deps(),
        );
        for (let i = 0; i < 2; i++) {
          await assert.rejects(
            hooks["tool.execute.before"](
              { tool: "bash", sessionID: "s", callID: "c" },
              { args: { command: "ls" } },
            ),
            new RegExp(c.tool.source.replace(/^\^/, "")),
            c.name,
          );
        }
        if (c.name === "tripwire") assertTripwireLine(events);
        for (let i = 0; i < 3; i++) await idle(hooks);
        assert.equal(sent.length, 2, c.name);
        assert.match(sent[0] ?? "", c.stop);
        assert.match(sent[0] ?? "", / \(block 1 of 2\)$/);
        assert.match(sent[1] ?? "", / \(block 2 of 2\)$/);
      },
    );
  }
});

void test("pi: a failed registration or the legacy-only tripwire blocks every tool call and re-prompts the settle twice at most", async () => {
  for (const c of FAILED_RUNS) {
    const events = join(dir(), "events.jsonl");
    await withEnv(
      { ...c.env, CLAUDE_PLUGIN_DATA: dir(), FACTORY_EVENTS_FILE: events },
      async () => {
        const { handlers, sent, api } = fakePi();
        guardExtension(api, deps());
        for (let i = 0; i < 2; i++) {
          const blocked = (await handlers.tool_call?.(
            { toolName: "bash", toolCallId: "c", input: { command: "ls" } },
            piCtx(dir()),
          )) as { block?: boolean; reason?: string } | undefined;
          assert.equal(blocked?.block, true, c.name);
          assert.match(blocked?.reason ?? "", c.tool);
        }
        if (c.name === "tripwire") assertTripwireLine(events);
        const ctx = piCtx(dir());
        for (let i = 0; i < 3; i++) {
          await handlers.agent_settled?.({ aborted: false }, ctx);
        }
        assert.equal(sent.length, 2, c.name);
        assert.match(sent[0] ?? "", c.stop);
        assert.match(sent[0] ?? "", / \(block 1 of 2\)$/);
        assert.match(sent[1] ?? "", / \(block 2 of 2\)$/);
      },
    );
  }
});

// The real hook processes, as each harness's own hooks file starts them.
const GUARD_PLUGIN = fileURLToPath(new URL("../", import.meta.url));
const hookArgs = (file: string, event: string): string[] => {
  const json = JSON.parse(readFileSync(join(GUARD_PLUGIN, file), "utf8")) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  const command = json.hooks[event]?.[0]?.hooks[0]?.command ?? "";
  const tokens = (
    command
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", GUARD_PLUGIN.replace(/[\\/]$/, ""))
      .match(/"[^"]*"|\S+/g) ?? []
  ).map((t) => t.replace(/^"|"$/g, ""));
  assert.equal(tokens[0], "node", command);
  return tokens.slice(1);
};
let sessionCounter = 0;
const spawnHook = (
  args: string[],
  payload: Record<string, unknown>,
  env: Record<string, string>,
) => {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.startsWith("FACTORY_") &&
        !k.startsWith("GUARD_") &&
        !k.endsWith("_PLUGIN_DATA") &&
        k !== "CLAUDE_PLUGIN_ROOT",
    ),
  );
  sessionCounter += 1;
  const r = spawnSync(process.execPath, args, {
    input: JSON.stringify({
      cwd: dir(),
      session_id: `adapters-${String(process.pid)}-${String(sessionCounter)}`,
      ...payload,
    }),
    encoding: "utf8",
    env: {
      ...clean,
      GUARD_OTEL: "off",
      GUARD_STOP_CHECK: "off",
      GUARD_RUN_EVENTS_FILE: "",
      ...env,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Record<string, unknown>;
};
const shell = (tool: string, command = "ls") => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: { command },
});

void test("command harnesses: a failed registration or the legacy-only tripwire denies PreToolUse in each harness's shape", () => {
  const claudeArgs = hookArgs("hooks/hooks.json", "PreToolUse");
  const codexArgs = hookArgs(".generated/codex/hooks.json", "PreToolUse");
  assert.ok(codexArgs.includes("--harness=codex"));
  const antigravityArgs = [
    join(GUARD_PLUGIN, "hooks", "guard.mjs"),
    "PreToolUse",
    "--harness=antigravity",
  ];
  for (const c of FAILED_RUNS) {
    const events = join(dir(), "events.jsonl");
    const withEvents = (extra: Record<string, string>) => ({
      ...c.env,
      FACTORY_EVENTS_FILE: events,
      ...extra,
    });
    const harnesses: [
      string,
      string[],
      Record<string, unknown>,
      Record<string, string>,
    ][] = [
      ["claude", claudeArgs, shell("Bash"), { CLAUDE_PLUGIN_DATA: dir() }],
      ["copilot", claudeArgs, shell("bash"), { COPILOT_PLUGIN_DATA: dir() }],
      [
        "vscode",
        claudeArgs,
        shell("run_in_terminal"),
        { CLAUDE_PLUGIN_ROOT: GUARD_PLUGIN },
      ],
      ["codex", codexArgs, shell("Bash"), { CLAUDE_PLUGIN_DATA: dir() }],
    ];
    for (const [name, args, payload, extra] of harnesses) {
      const out = spawnHook(args, payload, withEvents(extra)) as {
        hookSpecificOutput?: {
          permissionDecision?: string;
          permissionDecisionReason?: string;
        };
      };
      assert.equal(
        out.hookSpecificOutput?.permissionDecision,
        "deny",
        `${c.name} ${name}`,
      );
      assert.match(
        out.hookSpecificOutput?.permissionDecisionReason ?? "",
        c.tool,
        `${c.name} ${name}`,
      );
    }
    const anti = spawnHook(
      antigravityArgs,
      {
        hook_event_name: "PreToolUse",
        toolCall: { name: "run_command", args: { CommandLine: "ls" } },
      },
      withEvents({ CLAUDE_PLUGIN_DATA: dir() }),
    );
    assert.equal(anti.decision, "deny", c.name);
    assert.match(String(anti.reason), c.tool);
    // each spawned session writes its own tripwire line, one per session and none from a failed registration
    if (c.name === "tripwire") {
      const lines = eventLines(events);
      assert.equal(lines.length, 5);
      for (const l of lines) assert.equal(l.rule, "run-unregistered");
    }
  }
});

void test("command harnesses: the legacy-only tripwire writes its line once per session", () => {
  const events = join(dir(), "events.jsonl");
  const data = dir();
  const args = hookArgs("hooks/hooks.json", "PreToolUse");
  const env = {
    FACTORY_RUN_ID: "run-1",
    FACTORY_EVENTS_FILE: events,
    CLAUDE_PLUGIN_DATA: data,
  };
  for (let i = 0; i < 3; i++) {
    const out = spawnHook(
      args,
      { ...shell("Bash"), session_id: "adapters-one-session" },
      env,
    ) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
  }
  assertTripwireLine(events);
});

void test("command harnesses: a failed registration or the legacy-only tripwire blocks Stop in each harness's shape, twice at most", () => {
  const claudeArgs = hookArgs("hooks/hooks.json", "Stop");
  const codexArgs = hookArgs(".generated/codex/hooks.json", "Stop");
  const antigravityArgs = [
    join(GUARD_PLUGIN, "hooks", "stop.mjs"),
    "Stop",
    "--harness=antigravity",
  ];
  const stop = { hook_event_name: "Stop" };
  for (const c of FAILED_RUNS) {
    const claude = spawnHook(claudeArgs, stop, {
      ...c.env,
      CLAUDE_PLUGIN_DATA: dir(),
    });
    assert.equal(claude.decision, "block", c.name);
    assert.match(String(claude.reason), c.stop);
    assert.match(String(claude.reason), / \(block 1 of 2\)$/);
    const codex = spawnHook(codexArgs, stop, {
      ...c.env,
      CLAUDE_PLUGIN_DATA: dir(),
    });
    assert.deepEqual(Object.keys(codex).sort(), ["decision", "reason"]);
    assert.equal(codex.decision, "block");
    assert.match(String(codex.reason), c.stop);
    const anti = spawnHook(antigravityArgs, stop, {
      ...c.env,
      CLAUDE_PLUGIN_DATA: dir(),
    });
    assert.equal(anti.decision, "continue", c.name);
    assert.match(String(anti.reason), c.stop);
    // the cap: the same session and data dir blocks twice, then lets go
    const data = dir();
    const capped = { ...c.env, CLAUDE_PLUGIN_DATA: data };
    const session = { ...stop, session_id: `adapters-cap-${c.name}` };
    const first = spawnHook(claudeArgs, session, capped);
    const second = spawnHook(claudeArgs, session, capped);
    assert.match(String(first.reason), / \(block 1 of 2\)$/);
    assert.match(String(second.reason), / \(block 2 of 2\)$/);
    const third = spawnSync(process.execPath, claudeArgs, {
      input: JSON.stringify({ cwd: dir(), ...session }),
      encoding: "utf8",
      env: {
        ...process.env,
        ...capped,
        GUARD_OTEL: "off",
        GUARD_STOP_CHECK: "off",
      },
    });
    assert.equal(third.status, 0, third.stderr);
    assert.equal(third.stdout.trim(), "", c.name);
  }
});
