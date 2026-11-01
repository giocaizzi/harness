import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import subagentExtension, { childEnv, loadAgents, MAX_DEPTH, piArgs, } from "./subagent.mjs";
const inheritedParentSession = process.env.GUARD_PARENT_SESSION;
const inheritedAgentId = process.env.GUARD_AGENT_ID;
beforeEach(() => {
    delete process.env.GUARD_PARENT_SESSION;
    delete process.env.GUARD_AGENT_ID;
});
afterEach(() => {
    if (inheritedParentSession === undefined)
        delete process.env.GUARD_PARENT_SESSION;
    else
        process.env.GUARD_PARENT_SESSION = inheritedParentSession;
    if (inheritedAgentId === undefined)
        delete process.env.GUARD_AGENT_ID;
    else
        process.env.GUARD_AGENT_ID = inheritedAgentId;
});
const captureTool = (deps) => {
    let registered;
    subagentExtension({
        registerTool: (t) => {
            registered = t;
        },
    }, deps);
    assert.ok(registered);
    return registered;
};
void test("loadAgents: every plugin agent, with Claude tools mapped to pi tools", () => {
    const agents = Object.fromEntries(loadAgents().map((a) => [a.name, a]));
    for (const name of ["scout", "escalate", "api-reviewer"]) {
        assert.ok(agents[name], name);
    }
    assert.deepEqual(agents.scout?.tools, ["read", "grep", "find", "ls", "bash"]);
    assert.equal(agents.escalate?.tools, null);
    assert.equal(agents.scout.thinking, "low");
    assert.match(agents.scout.prompt, /read-only scout/);
});
void test("piArgs: session model, narrowed tools, the prompt file and the task", () => {
    assert.deepEqual(piArgs({ tools: ["read"] }, "look", "/p.md", "prov/m"), [
        "-p",
        "--no-session",
        "--model",
        "prov/m",
        "--tools",
        "read",
        "--append-system-prompt",
        "/p.md",
        "Task: look",
    ]);
    assert.deepEqual(piArgs({ tools: null }, "go", "/p.md"), [
        "-p",
        "--no-session",
        "--append-system-prompt",
        "/p.md",
        "Task: go",
    ]);
    assert.deepEqual(piArgs({ tools: null, thinking: "medium" }, "go", "/p.md"), [
        "-p",
        "--no-session",
        "--thinking",
        "medium",
        "--append-system-prompt",
        "/p.md",
        "Task: go",
    ]);
});
void test("the model and thinking level reach onUpdate before the child starts, for hud (#219)", async () => {
    const events = [];
    const agents = [
        {
            name: "scout",
            description: "d",
            tools: null,
            thinking: "low",
            prompt: "p",
        },
        { name: "plain", description: "d", tools: null, prompt: "p" },
    ];
    const tool = captureTool({
        loadAgents: () => agents,
        run: (argv) => {
            events.push({ kind: "run", argv });
            return Promise.resolve({ code: 0, out: "ok", err: "" });
        },
    });
    const onUpdate = (update) => {
        events.push({ kind: "update", update });
    };
    await tool.execute("t1", { agent: "scout", task: "x" }, undefined, onUpdate, {
        cwd: "/",
        model: { provider: "p", id: "m" },
    });
    assert.deepEqual(events[0], {
        kind: "update",
        update: { content: [], details: { model: "p/m", thinking: "low" } },
    });
    const firstRun = events[1];
    assert.equal(firstRun?.kind, "run");
    assert.ok(firstRun.argv.join(" ").includes("--model p/m --thinking low"));
    events.length = 0;
    await tool.execute("t2", { agent: "plain", task: "x" }, undefined, onUpdate, {
        cwd: "/",
        model: { provider: "p", id: "m" },
    });
    assert.deepEqual(events[0], {
        kind: "update",
        update: { content: [], details: { model: "p/m" } },
    });
    const secondRun = events[1];
    assert.equal(secondRun?.kind, "run");
    assert.ok(!secondRun.argv.includes("--thinking"));
});
void test("the tool runs the agent and returns its answer, or throws on failure", async () => {
    const agents = [
        { name: "scout", description: "d", tools: ["read"], prompt: "p" },
    ];
    const tool = captureTool({
        loadAgents: () => agents,
        run: (argv) => Promise.resolve({
            code: 0,
            out: `ran ${argv.at(-1) ?? ""}\n`,
            err: "",
        }),
    });
    assert.match(tool.description, /- scout: d/);
    const r = await tool.execute("id", { agent: "scout", task: "x" }, undefined, undefined, { cwd: "/", model: { provider: "p", id: "m" } });
    assert.equal(r.content[0]?.text, "ran Task: x");
    await assert.rejects(tool.execute("id", { agent: "nope", task: "x" }, undefined, undefined, {}), /Unknown agent/);
    const failingTool = captureTool({
        loadAgents: () => agents,
        run: () => Promise.resolve({ code: 2, out: "", err: "boom" }),
    });
    await assert.rejects(failingTool.execute("id", { agent: "scout", task: "x" }, undefined, undefined, {}), /exit 2.*boom/);
});
void test("a subagent's pi runs without the guard's stop check and result gate: the parent's stop runs them", () => {
    assert.deepEqual(childEnv({ PATH: "/bin" }), {
        PATH: "/bin",
        GUARD_STOP_CHECK: "off",
        GUARD_RESULT_GATE: "off",
        PI_SUBAGENT_DEPTH: "1",
    });
});
void test("the child names the parent session and itself, so the guard keeps its reminders apart and shares its skills (#172)", async () => {
    assert.deepEqual(childEnv({}, { session: "s1", agent: "scout-t1" }), {
        GUARD_STOP_CHECK: "off",
        GUARD_RESULT_GATE: "off",
        PI_SUBAGENT_DEPTH: "1",
        GUARD_PARENT_SESSION: "s1",
        GUARD_AGENT_ID: "scout-t1",
    });
    let ids;
    const tool = captureTool({
        loadAgents: () => [
            { name: "scout", description: "d", tools: null, prompt: "p" },
        ],
        run: (_argv, _cwd, _signal, i) => {
            ids = i;
            return Promise.resolve({ code: 0, out: "ok", err: "" });
        },
    });
    await tool.execute("t1", { agent: "scout", task: "x" }, undefined, undefined, { cwd: "/", sessionManager: { getSessionId: () => "s1" } });
    assert.deepEqual(ids, { session: "s1", agent: "scout-t1" });
});
void test("nesting is counted in the child and refused past MAX_DEPTH, so a driver can fan out but a loop cannot", async () => {
    assert.equal(childEnv({ PI_SUBAGENT_DEPTH: "1" }).PI_SUBAGENT_DEPTH, "2");
    const agents = [
        { name: "worker", description: "d", tools: ["read"], prompt: "p" },
    ];
    const tool = captureTool({
        loadAgents: () => agents,
        run: () => Promise.resolve({ code: 0, out: "ok", err: "" }),
    });
    const saved = process.env.PI_SUBAGENT_DEPTH;
    try {
        process.env.PI_SUBAGENT_DEPTH = String(MAX_DEPTH - 1);
        const res = await tool.execute("id", { agent: "worker", task: "x" }, undefined, undefined, {});
        assert.equal(res.content[0]?.text, "ok");
        process.env.PI_SUBAGENT_DEPTH = String(MAX_DEPTH);
        await assert.rejects(tool.execute("id", { agent: "worker", task: "x" }, undefined, undefined, {}), /nest at most 3 deep; return the split/);
    }
    finally {
        if (saved === undefined)
            delete process.env.PI_SUBAGENT_DEPTH;
        else
            process.env.PI_SUBAGENT_DEPTH = saved;
    }
});
