import { test } from "node:test";
import assert from "node:assert/strict";
import hudExtension, { PI_DEFAULTS, piFacts, piOptions, piStatus, readRepo, rewriteMessage, } from "./pi.mjs";
import { repoOf } from "./links.mjs";
import { createFacts } from "./rewrite.mjs";
void test("rewriteMessage: text blocks of an assistant message are rewritten; other roles and blocks are left alone", () => {
    const msg = {
        role: "assistant",
        content: [
            { type: "thinking", thinking: "x" },
            { type: "text", text: "fixed x" },
        ],
    };
    const out = rewriteMessage(msg, (t) => t.replace(/x$/, "y"));
    assert.ok(out);
    assert.equal(out.content[0], msg.content[0]);
    assert.equal(out.content[1]?.text, "fixed y");
    assert.equal(rewriteMessage({ role: "user", content: [{ type: "text", text: "x" }] }, () => "y"), null);
    assert.equal(rewriteMessage({ role: "assistant", content: [{ type: "text", text: "none" }] }, (t) => t), null);
});
void test("piOptions: hud.json in the config dir over the pi defaults; none or broken JSON gives the defaults", () => {
    const seen = [];
    const read = (p) => {
        seen.push(p);
        return '{"editor":"zed","replyTimes":"on"}';
    };
    assert.deepEqual(piOptions({ PI_CODING_AGENT_DIR: "/cfg" }, read), {
        replyTimes: "on",
        editor: "zed",
    });
    assert.match(seen[0] ?? "", /cfg[\/\\]hud\.json$/);
    piOptions({ HOME: "/h" }, read);
    assert.match(seen[1] ?? "", /h[\/\\]\.pi[\/\\]agent[\/\\]hud\.json$/);
    assert.deepEqual(piOptions({ HOME: "/h" }, () => "not json"), PI_DEFAULTS);
    assert.deepEqual(piOptions({ HOME: "/h" }, () => {
        throw new Error("ENOENT");
    }), PI_DEFAULTS);
});
void test("piFacts: stat, commit and state through node and the runner", async () => {
    const calls = [];
    const f = piFacts("/repo", async (argv, cwd) => {
        await Promise.resolve();
        calls.push([argv.join(" "), cwd ?? ""]);
        return argv[1] === "cat-file" && argv[3] === "abc1234^{commit}" ? "" : null;
    });
    f.stat(import.meta.dirname);
    f.stat("/no/such/path/here");
    f.commit("abc1234");
    f.commit("def5678");
    await f.settle();
    assert.equal(f.stat(import.meta.dirname), "dir");
    assert.equal(f.stat("/no/such/path/here"), null);
    assert.equal(f.commit("abc1234"), true);
    assert.equal(f.commit("def5678"), false);
    assert.deepEqual(calls[0], ["git cat-file -e abc1234^{commit}", "/repo"]);
});
void test("message_end rewrites the reply once the repo is read; without a UI that takes links only secrets are masked", async () => {
    const handlers = {};
    const origin = repoOf("git@github.com:o/r.git");
    let links = true;
    const facts = () => createFacts({
        state: async () => {
            await Promise.resolve();
            return { kind: "pr", state: "merged" };
        },
    });
    hudExtension({
        on: (e, fn) => {
            handlers[e] = fn;
        },
    }, {
        readRepo: async () => {
            await Promise.resolve();
            return { ahead: 0, behind: 0, changes: null, pr: null, links: origin };
        },
        hyperlinks: async () => {
            await Promise.resolve();
            return links;
        },
        options: {},
        facts,
    });
    const ctx = {
        hasUI: true,
        cwd: "/r",
        getContextUsage: () => null,
        ui: {
            setStatus: () => {
                /* noop */
            },
        },
    };
    handlers.session_start?.({}, ctx);
    await new Promise((r) => setTimeout(r, 0));
    const e = {
        message: {
            role: "assistant",
            content: [
                { type: "text", text: "see #3, key ghp_abcdefghijklmnopqrstuvwx1234" },
            ],
        },
    };
    const res = (await handlers.message_end?.(e, ctx));
    const text = res.message.content[0].text;
    assert.match(text, /\[ #3\]\(https:\/\/github\.com\/o\/r\/issues\/3\)/);
    assert.match(text, / ghp_••••••••/);
    assert.doesNotMatch(text, /[]/);
    const plainRes = (await handlers.message_end?.(e, {
        ...ctx,
        hasUI: false,
    }));
    const plain = plainRes.message.content[0].text;
    assert.equal(plain, "see #3, key ghp_••••••••");
    links = false;
    const res3 = (await handlers.message_end?.(e, ctx));
    assert.equal(res3.message.content[0].text, plain);
    assert.equal(await handlers.message_end?.({
        message: {
            role: "assistant",
            content: [{ type: "text", text: "see #3" }],
        },
    }, { ...ctx, hasUI: false }), undefined);
});
void test("before_agent_start adds the rule for references of other repositories once, after the repo is read", async () => {
    const handlers = {};
    hudExtension({
        on: (e, fn) => {
            handlers[e] = fn;
        },
    }, {
        readRepo: async () => {
            await Promise.resolve();
            return {
                ahead: 0,
                behind: 0,
                changes: null,
                pr: null,
                links: repoOf("git@github.com:o/r.git"),
            };
        },
        options: {},
    });
    const e = { systemPromptOptions: {} };
    handlers.before_agent_start?.(e, {});
    const spo = e.systemPromptOptions;
    assert.equal(spo.promptGuidelines, undefined);
    handlers.session_start?.({}, { hasUI: false, cwd: "/r" });
    await new Promise((r) => setTimeout(r, 0));
    handlers.before_agent_start?.(e, {});
    handlers.before_agent_start?.(e, {});
    const updatedSpo = e.systemPromptOptions;
    const guidelines = updatedSpo.promptGuidelines ?? [];
    assert.equal(guidelines.length, 1);
    assert.match(guidelines[0] ?? "", /bare `#N` means an issue or pull request of o\/r.*write `owner\/repo#N`/);
});
void test("/refresh-refs makes the next reply look its references up again", async () => {
    const handlers = {};
    const commands = {};
    let made = 0;
    const facts = () => {
        made++;
        return createFacts({
            state: async () => {
                await Promise.resolve();
                return { kind: "pr", state: "merged" };
            },
        });
    };
    hudExtension({
        on: (e, fn) => {
            handlers[e] = fn;
        },
        registerCommand: (n, c) => {
            commands[n] = c;
        },
    }, {
        readRepo: async () => {
            await Promise.resolve();
            return {
                ahead: 0,
                behind: 0,
                changes: null,
                pr: null,
                links: repoOf("git@github.com:o/r.git"),
            };
        },
        hyperlinks: async () => {
            await Promise.resolve();
            return true;
        },
        options: {},
        facts,
    });
    const ctx = {
        hasUI: true,
        cwd: "/r",
        getContextUsage: () => null,
        ui: {
            setStatus: () => {
                /* noop */
            },
            notify: () => {
                /* noop */
            },
        },
    };
    handlers.session_start?.({}, ctx);
    await new Promise((r) => setTimeout(r, 0));
    const e = {
        message: { role: "assistant", content: [{ type: "text", text: "see #3" }] },
    };
    await handlers.message_end?.(e, ctx);
    await handlers.message_end?.(e, ctx);
    assert.equal(made, 1);
    await commands["refresh-refs"]?.handler("", ctx);
    await handlers.message_end?.(e, ctx);
    assert.equal(made, 2);
});
void test("piStatus: context, model, PR with checks, sync and changes; missing parts left out", () => {
    const repo = {
        pr: {
            number: 7,
            url: null,
            state: "open",
            ci: "pass",
            passed: 3,
            total: 3,
        },
        ahead: 2,
        behind: 0,
        changes: { files: 1, added: 4, removed: 1, untracked: 1 },
    };
    const s = piStatus({ pct: 42.4, model: "gpt-x", repo });
    for (const part of ["ctx:42%", "gpt-x", "#7 3/3", "↑2 ↓0", "2 +4 -1"])
        assert.ok(s.includes(part), part);
    assert.equal(piStatus({ pct: null, model: null, repo: null }), "");
    assert.match(piStatus({
        repo: {
            pr: {
                number: 7,
                url: null,
                state: "merged",
                ci: null,
                passed: 0,
                total: 0,
            },
            ahead: 0,
            behind: 0,
            changes: null,
        },
    }), /#7 merged/);
});
void test("readRepo: the GitHub PR and git counts through the injected runner", async () => {
    const out = {
        "git remote get-url origin": "git@github.com:o/r.git\n",
        "gh pr view --json number,url,state,statusCheckRollup": JSON.stringify({
            number: 9,
            state: "OPEN",
            statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
        }),
        "git rev-list --left-right --count @{u}...HEAD": "0\t1\n",
    };
    const r = await readRepo("/x", async (argv) => {
        await Promise.resolve();
        return out[argv.join(" ")] ?? null;
    });
    assert.ok(r.pr);
    assert.equal(r.pr.number, 9);
    assert.equal(r.pr.ci, "pass");
    assert.equal(r.ahead, 1);
});
void test("the footer is drawn at session start, and a dead context is ignored", async () => {
    const handlers = {};
    const set = [];
    hudExtension({
        on: (e, fn) => {
            handlers[e] = fn;
        },
    }, {
        readRepo: async () => {
            await Promise.resolve();
            return null;
        },
    });
    const ctx = {
        hasUI: true,
        getContextUsage: () => ({ percent: 10 }),
        model: { id: "m" },
        ui: { setStatus: (k, v) => set.push([k, v]) },
    };
    handlers.session_start?.({}, ctx);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(set.at(-1)?.[0], "hud");
    assert.match(set.at(-1)?.[1] ?? "", /ctx:10%/);
    const dead = {
        get hasUI() {
            throw new Error("stale");
        },
    };
    assert.doesNotThrow(() => handlers.turn_end?.({}, dead));
});
void test("footer: each running subagent call with its agent and model, gone when it ends", () => {
    const handlers = {};
    const drawn = [];
    hudExtension({
        on: (e, fn) => {
            handlers[e] = fn;
        },
    }, {
        readRepo: async () => {
            await Promise.resolve();
            return null;
        },
        options: {},
    });
    const ctx = {
        hasUI: true,
        cwd: "/r",
        model: { provider: "p", id: "m-1" },
        getContextUsage: () => null,
        ui: { setStatus: (_k, t) => drawn.push(t) },
    };
    handlers.tool_execution_start?.({
        toolCallId: "a",
        toolName: "subagent",
        args: { agent: "scout", task: "t" },
    }, ctx);
    handlers.tool_execution_start?.({ toolCallId: "b", toolName: "bash", args: {} }, ctx);
    handlers.tool_execution_start?.({
        toolCallId: "c",
        toolName: "subagent",
        args: { agent: "escalate", task: "t" },
    }, ctx);
    assert.equal(drawn.at(-1), "[ m-1] [ scout · m-1] [ escalate · m-1]");
    handlers.tool_execution_end?.({ toolCallId: "a", toolName: "subagent", isError: false }, ctx);
    handlers.tool_execution_end?.({ toolCallId: "b", toolName: "bash", isError: false }, ctx);
    assert.equal(drawn.at(-1), "[ m-1] [ escalate · m-1]");
    assert.equal(drawn.length, 3);
    assert.equal(piStatus({ agents: [{ agent: "scout" }] }), "[ scout]");
});
void test("footer: the effort a subagent call reports for its child, none before", () => {
    const handlers = {};
    const drawn = [];
    hudExtension({
        on: (e, fn) => {
            handlers[e] = fn;
        },
    }, {
        readRepo: async () => {
            await Promise.resolve();
            return null;
        },
        options: {},
    });
    const ctx = {
        hasUI: true,
        cwd: "/r",
        model: { provider: "p", id: "m-1" },
        getContextUsage: () => null,
        ui: { setStatus: (_k, t) => drawn.push(t) },
    };
    handlers.tool_execution_start?.({
        toolCallId: "a",
        toolName: "subagent",
        args: { agent: "scout", task: "t" },
    }, ctx);
    handlers.tool_execution_update?.({ toolCallId: "a", toolName: "subagent", partialResult: { content: [] } }, ctx);
    assert.equal(drawn.at(-1), "[ m-1] [ scout · m-1]");
    handlers.tool_execution_update?.({
        toolCallId: "a",
        toolName: "subagent",
        partialResult: {
            content: [],
            details: { model: "p/m-2", thinking: "high" },
        },
    }, ctx);
    assert.equal(drawn.at(-1), "[ m-1] [ scout · m-2 · high]");
    handlers.tool_execution_update?.({
        toolCallId: "b",
        toolName: "bash",
        partialResult: { details: { thinking: "x" } },
    }, ctx);
    assert.equal(drawn.length, 2);
});
