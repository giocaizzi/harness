// The in-process adapters (opencode, pi) over a fake harness API: the guard's decisions reach the harness.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GuardPlugin } from "./opencode.mjs";
import guardExtension from "./pi.mjs";
delete process.env.GUARD_STOP_CHECK;
delete process.env.GUARD_UNATTENDED;
for (const k of [
    "FACTORY_RUN_ID",
    "FACTORY_TICKET",
    "FACTORY_ATTENDED_RUN_ID",
    "FACTORY_ATTENDED_TICKET",
    "FACTORY_RUN_FILE",
    "GUARD_RESULT_GATE",
]) {
    Reflect.deleteProperty(process.env, k);
}
const dir = (files = {}) => {
    const d = mkdtempSync(join(tmpdir(), "adapter-test-"));
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(d, name), content);
    }
    return d;
};
const deps = () => ({
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
const forced = async (fn) => {
    process.env.GUARD_STOP_CHECK = "force";
    try {
        await fn();
    }
    finally {
        delete process.env.GUARD_STOP_CHECK;
    }
};
const fakePi = () => {
    const handlers = {};
    const sent = [];
    return {
        handlers,
        sent,
        api: {
            on: ((e, f) => {
                handlers[e] = f;
            }),
            sendUserMessage: async (m) => {
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
    };
    const hooks = await GuardPlugin({ client: mockClient, directory: dir({ "uv.lock": "" }) }, deps());
    const before = (command) => hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command } });
    await assert.rejects(before("pip install x"), /uses uv/);
    await assert.rejects(before("rm -rf ~/x"), /cannot ask/);
    await before("ls");
});
void test("opencode: the config hook appends bash asks last, and a covered risky command is left to opencode", async () => {
    const sessionPermission = [];
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
    };
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
    assert.equal(cfg.agent.scout.permission.bash?.["git reset --hard *"], "ask");
    assert.equal(cfg.agent.x.permission, undefined);
    const before = (command) => hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command } });
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
        };
        const hooks = await GuardPlugin({ client, directory: dir() }, {
            ...deps(),
            argv: ["bun", "/$bunfs/root/src/index.js", "run", ...flag, "go"],
        });
        await hooks.config({ permission: { bash: "allow" } });
        await assert.rejects(hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf build" } }), /cannot ask/, flag.join(" "));
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
        };
        const hooks = await GuardPlugin({ client, directory: dir() }, deps());
        const cfg = { permission };
        await hooks.config(cfg);
        assert.deepEqual(cfg.permission, permission);
        await assert.rejects(hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf ~/x" } }), /cannot ask/);
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
    };
    const hooks = await GuardPlugin({ client: mockClient, directory: dir() }, deps());
    const output = {
        args: { command: "sed -i 's/a/b/' f.txt" },
        output: "done",
    };
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "e", callID: "c1" }, output);
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "e", callID: "c1", args: output.args }, output);
    assert.match(output.output, /^done\n\nEdit files with the harness's edit tool/);
    const { handlers, api } = fakePi();
    guardExtension(api, deps());
    const ctx = {
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
    const call = async (id) => {
        await Promise.resolve();
        const fn = handlers.tool_call;
        return fn?.({
            toolName: "bash",
            toolCallId: id,
            input: { command: "echo x > notes.md" },
        }, ctx);
    };
    const result = async (id) => {
        const fn = handlers.tool_result;
        return (await fn?.({ toolName: "bash", toolCallId: id, input: {}, content: [] }, ctx));
    };
    await call("t1");
    const res1 = await result("t1");
    assert.match(res1?.content?.[0]?.text ?? "", /edit tool/);
    await call("t2");
    assert.equal(await result("t2"), undefined);
});
void test("opencode: a failing make check on idle is sent back once", async () => {
    const sent = [];
    const client = {
        session: {
            get: async () => {
                await Promise.resolve();
                return null;
            },
            prompt: async (p) => {
                await Promise.resolve();
                sent.push(p);
            },
        },
        tui: {
            showToast: async () => {
                await Promise.resolve();
            },
        },
    };
    const hooks = await GuardPlugin({ client, directory: dir({ Makefile: "check:\n\t@false\n" }) }, deps());
    const idle = () => hooks.event({
        event: { type: "session.idle", properties: { sessionID: "s" } },
    });
    await forced(async () => {
        await idle();
        await idle();
    });
    assert.equal(sent.length, 1);
    assert.ok(sent[0]);
    const msg0 = sent[0];
    const part0 = msg0.body.parts[0];
    assert.ok(part0);
    assert.match(part0.text, /make check failed/);
});
void test("opencode: a subagent's idle session (it has a parent) runs no check", async () => {
    const sent = [];
    const client = {
        session: {
            get: async () => {
                await Promise.resolve();
                return { data: { parentID: "p" } };
            },
            prompt: async (p) => {
                await Promise.resolve();
                sent.push(p);
            },
        },
        tui: {
            showToast: async () => {
                await Promise.resolve();
            },
        },
    };
    const hooks = await GuardPlugin({ client, directory: dir({ Makefile: "check:\n\t@false\n" }) }, deps());
    await hooks.event({
        event: { type: "session.idle", properties: { sessionID: "child" } },
    });
    assert.equal(sent.length, 0);
});
void test("opencode and pi: a docs-only change runs no check on idle or settle; a code change does", async () => {
    const repo = () => {
        const cwd = dir({ Makefile: "check:\n\t@false\n", "a.py": "a = 1\n" });
        const git = (...args) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd, stdio: "ignore" });
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
        const sent = [];
        const docs = repo();
        const client = {
            session: {
                get: async () => {
                    await Promise.resolve();
                    return null;
                },
                prompt: async (p) => {
                    await Promise.resolve();
                    sent.push(p);
                },
            },
            tui: {
                showToast: async () => {
                    await Promise.resolve();
                },
            },
        };
        const hooks = await GuardPlugin({ client, directory: docs }, deps());
        await hooks.event({
            event: { type: "session.idle", properties: { sessionID: "s" } },
        });
        const { handlers, sent: piSent, api } = fakePi();
        guardExtension(api, deps());
        const piCtx = {
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
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
        delete process.env.GUARD_STOP_CHECK;
    }
});
const factoryRun = async (id, fn) => {
    const cwd = dir();
    execFileSync("git", ["init", "-q", cwd]);
    Object.assign(process.env, {
        FACTORY_RUN_ID: id,
        FACTORY_TICKET: "acme/app#12",
        CLAUDE_PLUGIN_DATA: dir(),
    });
    try {
        await fn(cwd);
    }
    finally {
        for (const k of [
            "FACTORY_RUN_ID",
            "FACTORY_TICKET",
            "CLAUDE_PLUGIN_DATA",
        ]) {
            Reflect.deleteProperty(process.env, k);
        }
    }
};
void test("opencode: a factory run without a valid result.json is sent the result gate on idle, twice at most", async () => {
    await factoryRun("oc-run", async (cwd) => {
        const sent = [];
        const client = {
            session: {
                get: async () => {
                    await Promise.resolve();
                    return null;
                },
                prompt: async (p) => {
                    await Promise.resolve();
                    sent.push(p);
                },
            },
            tui: {
                showToast: async () => {
                    await Promise.resolve();
                },
            },
        };
        const hooks = await GuardPlugin({ client, directory: cwd }, deps());
        for (let i = 0; i < 3; i++) {
            await hooks.event({
                event: { type: "session.idle", properties: { sessionID: "s" } },
            });
        }
        assert.equal(sent.length, 2);
        assert.ok(sent[0]);
        const msg0 = sent[0];
        const part0 = msg0.body.parts[0];
        assert.ok(part0);
        assert.match(part0.text, /^Factory result gate \(block 1 of 2\)[\s\S]*write-result\.mjs/);
    });
});
void test("pi: deny blocks, ask confirms through the UI and blocks without one", async () => {
    const { handlers, api } = fakePi();
    guardExtension(api, deps());
    const cwd = dir({ "uv.lock": "" });
    const ctx = (confirm) => ({
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
    const call = async (command, c) => {
        const fn = handlers.tool_call;
        return (await fn?.({ toolName: "bash", toolCallId: "t", input: { command } }, c));
    };
    const res1 = await call("pip install x", ctx());
    assert.match(res1?.reason ?? "", /uses uv/);
    assert.equal(await call("rm -rf ~/x", ctx(true)), undefined);
    assert.equal((await call("rm -rf ~/x", ctx(false)))?.block, true);
    assert.equal((await call("rm -rf ~/x", ctx()))?.block, true);
});
void test("opencode and pi: GUARD_UNATTENDED turns a risky ask into a deny, even with a UI that would confirm", async () => {
    const env = { GUARD_UNATTENDED: "1" };
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
    };
    const oc = await GuardPlugin({ client: mockClient, directory: dir() }, { ...deps(), env });
    await assert.rejects(oc["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf ~/x" } }), /Unattended run/);
    const { handlers, api } = fakePi();
    guardExtension(api, { ...deps(), env });
    const ctx = {
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
    const blocked = (await handlers.tool_call?.({ toolName: "bash", toolCallId: "t", input: { command: "rm -rf ~/x" } }, ctx));
    assert.ok(blocked);
    assert.equal(blocked.block, true);
    assert.match(blocked.reason ?? "", /Unattended run/);
});
void test("opencode and pi: GUARD_TRACEPARENT adds trace_id and span_id to the events file line, a malformed one adds neither", async () => {
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const lines = (file) => readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
    const cases = [
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
        };
        const oc = await GuardPlugin({ client: mockClient, directory: dir() }, {
            ...deps(),
            env: { FACTORY_EVENTS_FILE: ocFile, GUARD_TRACEPARENT: value },
        });
        await assert.rejects(oc["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: 'git commit -m "bad title"' } }), /Conventional/);
        const piFile = join(dir(), "events.jsonl");
        const { handlers, api } = fakePi();
        guardExtension(api, {
            ...deps(),
            env: { FACTORY_EVENTS_FILE: piFile, GUARD_TRACEPARENT: value },
        });
        const blocked = (await handlers.tool_call?.({
            toolName: "bash",
            toolCallId: "t",
            input: { command: 'git commit -m "bad title"' },
        }, {
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
        }));
        assert.equal(blocked?.block, true);
        for (const file of [ocFile, piFile]) {
            const line = lines(file)[0];
            assert.equal(line?.decision, "deny");
            assert.deepEqual([line.trace_id, line.span_id], want, `${file} ${value}`);
        }
    }
});
void test("pi: the default emit sends the guard.decision OTLP record with traceId and spanId", async () => {
    const sent = [];
    const keys = [
        "GUARD_OTEL",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "GUARD_OTEL_EXPORTER_OTLP_ENDPOINT",
        "GUARD_TRACEPARENT",
        "FACTORY_EVENTS_FILE",
    ];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const realFetch = globalThis.fetch;
    Object.assign(process.env, {
        GUARD_OTEL: "",
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
        GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
        GUARD_TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        FACTORY_EVENTS_FILE: "",
    });
    globalThis.fetch = (async (_, init) => {
        await Promise.resolve();
        sent.push(JSON.parse(init.body));
        return { ok: true };
    });
    try {
        const { handlers, api } = fakePi();
        const rest = { ...deps() };
        Reflect.deleteProperty(rest, "emit");
        guardExtension(api, rest);
        const blocked = (await handlers.tool_call?.({
            toolName: "bash",
            toolCallId: "t",
            input: { command: 'git commit -m "bad title"' },
        }, {
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
        }));
        assert.equal(blocked?.block, true);
        for (let i = 0; i < 50 && !sent.length; i++) {
            await new Promise((r) => setTimeout(r, 10));
        }
    }
    finally {
        globalThis.fetch = realFetch;
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) {
                Reflect.deleteProperty(process.env, k);
            }
            else {
                process.env[k] = v;
            }
        }
    }
    const rec = sent
        .flatMap((b) => b.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [])
        .find((r) => r.body.stringValue === "guard.decision");
    assert.deepEqual([rec?.traceId, rec?.spanId], ["4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"]);
});
void test("pi: every ask outcome is logged as guard.ask_result with its class; no UI is unavailable via no-ui", async () => {
    const { handlers, api } = fakePi();
    const events = [];
    guardExtension(api, {
        ...deps(),
        emit: async (event, attrs) => {
            await Promise.resolve();
            events.push([event, attrs.result, attrs.via, attrs.cmd_class]);
        },
    });
    const cwd = dir();
    const ctx = (confirm) => ({
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
    const call = async (c) => {
        const fn = handlers.tool_call;
        return (await fn?.({ toolName: "bash", toolCallId: "t", input: { command: "rm -rf ~/x" } }, c));
    };
    await call(ctx(true));
    assert.match((await call(ctx(false)))?.reason ?? "", /The user denied this command/);
    assert.match((await call(ctx()))?.reason ?? "", /No UI to confirm/);
    assert.deepEqual(events.filter(([e]) => e === "guard.ask_result"), [
        ["guard.ask_result", "allow", undefined, "files"],
        ["guard.ask_result", "deny", undefined, "files"],
        ["guard.ask_result", "unavailable", "no-ui", "files"],
    ]);
});
void test("pi: a failing make check on settle is sent back once, an aborted run is left alone", async () => {
    const { handlers, sent, api } = fakePi();
    guardExtension(api, deps());
    const ctx = {
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
void test("pi: a factory run without a valid result.json is sent the result gate on settle, twice at most", async () => {
    await factoryRun("pi-run", async (cwd) => {
        const { handlers, sent, api } = fakePi();
        guardExtension(api, deps());
        const ctx = {
            cwd,
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
        for (let i = 0; i < 3; i++) {
            await handlers.agent_settled?.({ aborted: false }, ctx);
        }
        assert.equal(sent.length, 2);
        assert.match(sent[1] ?? "", /^Factory result gate \(block 2 of 2\)/);
    });
});
void test("usage: opencode and pi report each assistant message once, as their own service", async () => {
    const sent = [];
    const report = async (event, attrs) => {
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
    };
    const hooks = await GuardPlugin({ client: mockClient, directory: dir() }, { ...deps(), report });
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
    const handlers = {};
    const mockPiApp = {
        on: ((e, f) => {
            handlers[e] = f;
        }),
        sendUserMessage: async () => {
            await Promise.resolve();
        },
    };
    guardExtension(mockPiApp, { ...deps(), report });
    const ctx = {
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
    await handlers.message_end?.({
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
    }, ctx);
    assert.deepEqual(sent, [
        ["api_request", "gpt-6.1-sol", 10, 3, 0.002, "s1"],
        ["api_request", "claude-sonnet-5-5", 7, 1, 0.0001, "p1"],
    ]);
});
void test("opencode and pi: the approval label is denied while FACTORY_RUN_ID is set, allowed without", async () => {
    const command = "gh issue edit 70 --add-label agent-ok";
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
    };
    const oc = await GuardPlugin({ client: mockClient, directory: dir() }, { ...deps(), env: { FACTORY_RUN_ID: "r1" } });
    await assert.rejects(oc["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command } }), /approval label/);
    const free = await GuardPlugin({ client: mockClient, directory: dir() }, { ...deps(), env: {} });
    await free["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command } });
    const { handlers, api } = fakePi();
    guardExtension(api, { ...deps(), env: { FACTORY_RUN_ID: "r1" } });
    const blocked = (await handlers.tool_call?.({ toolName: "bash", toolCallId: "c", input: { command } }, {
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
    }));
    assert.ok(blocked);
    assert.equal(blocked.block, true);
    assert.match(blocked.reason ?? "", /approval label/);
});
void test("opencode and pi: the takeover label is denied while FACTORY_RUN_ID is set, allowed without", async () => {
    const command = "gh issue edit 70 --add-label factory-takeover";
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
    };
    const oc = await GuardPlugin({ client: mockClient, directory: dir() }, { ...deps(), env: { FACTORY_RUN_ID: "r1" } });
    await assert.rejects(oc["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command } }), /takeover label/);
    const free = await GuardPlugin({ client: mockClient, directory: dir() }, { ...deps(), env: {} });
    await free["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command } });
    const { handlers, api } = fakePi();
    guardExtension(api, { ...deps(), env: { FACTORY_RUN_ID: "r1" } });
    const blocked = (await handlers.tool_call?.({ toolName: "bash", toolCallId: "c", input: { command } }, {
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
    }));
    assert.ok(blocked);
    assert.equal(blocked.block, true);
    assert.match(blocked.reason ?? "", /takeover label/);
});
void test("opencode and pi: a stale-plugin notice reaches the user (toast, notify) and the agent (the tool output)", async () => {
    const plugins = dir();
    const root = join(plugins, "guard");
    const manifest = (v) => {
        mkdirSync(join(root, ".claude-plugin"), { recursive: true });
        writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: v }));
    };
    manifest("1.0.0");
    const toasts = [];
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
            showToast: async ({ body }) => {
                await Promise.resolve();
                toasts.push(body.message);
            },
        },
    };
    const oc = await GuardPlugin({ client, directory: dir() }, { ...deps(), pluginRoot: root });
    const ocCall = async (id) => {
        await oc["tool.execute.before"]({ tool: "bash", sessionID: "oc", callID: id }, { args: { command: "ls" } });
        const out = { output: "" };
        await oc["tool.execute.after"]({ tool: "bash", sessionID: "oc", callID: id, args: {} }, out);
        return out.output;
    };
    await ocCall("c1");
    const { handlers, api } = fakePi();
    const notified = [];
    guardExtension(api, { ...deps(), pluginRoot: root });
    const ctx = {
        cwd: dir(),
        hasUI: true,
        ui: {
            confirm: async () => {
                await Promise.resolve();
                return true;
            },
            notify: (t) => notified.push(t),
        },
        sessionManager: { getSessionId: () => "pi" },
    };
    await handlers.tool_call?.({ toolName: "bash", toolCallId: "t1", input: { command: "ls" } }, ctx);
    manifest("1.1.0");
    assert.match(await ocCall("c2"), /guard 1\.0\.0 → 1\.1\.0\): restart the session to load them\. Only the user can do this/);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(toasts, [
        "Harness plugins updated (guard 1.0.0 → 1.1.0): restart the session to load them.",
    ]);
    await handlers.tool_call?.({ toolName: "bash", toolCallId: "t2", input: { command: "ls" } }, ctx);
    assert.deepEqual(notified, [
        "Harness plugins updated (guard 1.0.0 → 1.1.0): run `/reload` to load them.",
    ]);
});
void test("pi: a notify that throws does not block the call", async () => {
    const plugins = dir();
    const root = join(plugins, "guard");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
    const { handlers, api } = fakePi();
    guardExtension(api, { ...deps(), pluginRoot: root });
    const ctx = {
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
    await handlers.tool_call?.({ toolName: "bash", toolCallId: "t1", input: { command: "ls" } }, ctx);
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.1.0" }));
    assert.equal(await handlers.tool_call?.({ toolName: "bash", toolCallId: "t2", input: { command: "ls" } }, ctx), undefined);
});
void test("opencode: a child session runs as its own agent of the root session; pi: a subagent child as its own agent of the parent (#172)", async () => {
    const sessions = {
        child: { parentID: "root" },
        root: {},
    };
    const client = {
        session: {
            get: async ({ path }) => {
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
    };
    const dataDir = dir();
    const oc = await GuardPlugin({ client, directory: dir() }, { ...deps(), dataDir });
    const before = (sessionID, args) => oc["tool.execute.before"]({ tool: "skill", sessionID, callID: "c" }, { args });
    await before("child", { name: "ship" });
    const facts = readFileSync(join(dataDir, "sessions", "root.jsonl"), "utf8");
    assert.match(facts, /"loaded":"ship"/, "the child's skill counts for the root session");
    let answer = () => new Promise(() => {
        /* noop */
    });
    const hungClient = {
        session: {
            get: (q) => answer(q),
            prompt: async () => {
                await Promise.resolve();
            },
        },
        tui: {
            showToast: async () => {
                await Promise.resolve();
            },
        },
    };
    const hung = await GuardPlugin({ client: hungClient, directory: dir() }, { ...deps(), dataDir, rootTimeoutMs: 20 });
    await hung["tool.execute.before"]({ tool: "skill", sessionID: "lone", callID: "c" }, { args: { name: "land" } });
    assert.match(readFileSync(join(dataDir, "sessions", "lone.jsonl"), "utf8"), /"loaded":"land"/);
    answer = async ({ path }) => {
        await Promise.resolve();
        return {
            data: path.id === "lone" ? { parentID: "root" } : {},
        };
    };
    await hung["tool.execute.before"]({ tool: "skill", sessionID: "lone", callID: "c2" }, { args: { name: "wt" } });
    assert.match(readFileSync(join(dataDir, "sessions", "root.jsonl"), "utf8"), /"loaded":"wt"/, "retried after the server recovered");
    process.env.GUARD_PARENT_SESSION = "p1";
    process.env.GUARD_AGENT_ID = "scout-t1";
    try {
        const { handlers, api } = fakePi();
        const piData = dir();
        guardExtension(api, { ...deps(), dataDir: piData });
        await handlers.tool_call?.({ toolName: "skill", toolCallId: "t", input: { name: "land" } }, {
            cwd: dir(),
            hasUI: false,
            sessionManager: { getSessionId: () => undefined },
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
        assert.match(readFileSync(join(piData, "sessions", "p1.jsonl"), "utf8"), /"loaded":"land"/);
    }
    finally {
        delete process.env.GUARD_PARENT_SESSION;
        delete process.env.GUARD_AGENT_ID;
    }
});
void test("opencode: session.created of a root session sends guard.session, a subagent child session does not", async () => {
    const events = [];
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
    };
    const hooks = await GuardPlugin({ client: mockClient, directory: dir() }, {
        ...deps(),
        emit: async (e, a) => {
            await Promise.resolve();
            events.push([e, a.session_id, a.source]);
        },
    });
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
    const events = [];
    const { handlers, api } = fakePi();
    guardExtension(api, {
        ...deps(),
        emit: async (e, a) => {
            await Promise.resolve();
            events.push([e, a.session_id]);
        },
    });
    const ctx = {
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
    }
    finally {
        delete process.env.GUARD_PARENT_SESSION;
    }
    assert.equal(events.length, 1);
});
