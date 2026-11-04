import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readStdin } from "./stdin.mjs";
import { crashAnswer, stopCheck } from "./stop.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = { deadlineMs: 20_000 };
void test("readStdin: a slow writer's chunks are joined, however far apart", async () => {
    const s = new PassThrough();
    const p = readStdin(s, big);
    for (const part of ['{"a":', '"b",', '"c":1}\n']) {
        s.write(part);
        await sleep(300);
    }
    s.end();
    assert.deepEqual(await p, { ok: true, text: '{"a":"b","c":1}\n' });
});
void test("readStdin: a large payload in small chunks arrives whole", async () => {
    const s = new PassThrough();
    const json = JSON.stringify({ x: "y".repeat(5 * 1024 * 1024) });
    const p = readStdin(s, big);
    const buf = Buffer.from(json);
    for (let i = 0; i < buf.length; i += 65536) {
        s.write(buf.subarray(i, i + 65536));
        await new Promise((r) => setImmediate(r));
    }
    s.end();
    const r = await p;
    assert.ok(r.ok);
    assert.equal(r.text.length, json.length);
    assert.doesNotThrow(() => JSON.parse(r.text));
});
void test("readStdin: a payload over the cap is refused", async () => {
    const s = new PassThrough();
    const p = readStdin(s, { ...big, maxBytes: 1024 });
    s.write("x".repeat(2048));
    const r = await p;
    assert.ok(!r.ok);
    assert.match(r.why, /over/);
});
void test("readStdin: the cap in the reason is derived from maxBytes", async () => {
    const s = new PassThrough();
    const p = readStdin(s, { ...big, maxBytes: 2 * 1024 * 1024 });
    s.write(Buffer.alloc(3 * 1024 * 1024));
    const r = await p;
    assert.ok(!r.ok);
    assert.equal(r.why, "input over 2 MiB");
});
void test("readStdin: partial JSON then end is returned as it came, empty then end is empty", async () => {
    const a = new PassThrough();
    const pa = readStdin(a, big);
    a.write('{"a":');
    a.end();
    assert.deepEqual(await pa, { ok: true, text: '{"a":' });
    const b = new PassThrough();
    const pb = readStdin(b, big);
    b.end();
    assert.deepEqual(await pb, { ok: true, text: "" });
});
void test("readStdin: complete JSON without a trailing newline, then end", async () => {
    const s = new PassThrough();
    const p = readStdin(s, big);
    s.write('{"a":1}');
    s.end();
    assert.deepEqual(await p, { ok: true, text: '{"a":1}' });
});
void test("readStdin: complete JSON with the stream left open resolves", async () => {
    const s = new PassThrough();
    const p = readStdin(s, big);
    s.write('{"a":{"b":1}');
    await sleep(50);
    s.write("}\n");
    assert.deepEqual(await p, { ok: true, text: '{"a":{"b":1}}\n' });
});
void test("readStdin: a stream that never completes times out", async () => {
    const s = new PassThrough();
    const p = readStdin(s, { deadlineMs: 100 });
    s.write('{"a":');
    const r = await p;
    assert.ok(!r.ok);
    assert.match(r.why, /within/);
});
void test("readStdin: a stream error is a failure", async () => {
    const s = new PassThrough();
    const p = readStdin(s, big);
    s.write('{"a":');
    s.emit("error", new Error("boom"));
    const r = await p;
    assert.ok(!r.ok);
    assert.match(r.why, /could not be read/);
});
void test("readStdin: a multi-byte character split across chunks survives", async () => {
    const s = new PassThrough();
    const p = readStdin(s, big);
    const bytes = Buffer.from('{"a":"€"}');
    const cut = bytes.indexOf(0xe2) + 1;
    s.write(bytes.subarray(0, cut));
    await sleep(20);
    s.end(bytes.subarray(cut));
    assert.deepEqual(await p, { ok: true, text: '{"a":"€"}' });
});
// The emitted hooks as a harness runs them, over a real pipe.
const GUARD = fileURLToPath(new URL("./guard.mjs", import.meta.url));
const STOP = fileURLToPath(new URL("./stop.mjs", import.meta.url));
const hook = (script, args, chunks, { gapMs = 0, end = true, env = {} } = {}) => new Promise((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FACTORY_") && !k.startsWith("GUARD_")));
    const child = spawn(process.execPath, [script, ...args], {
        env: {
            ...clean,
            GUARD_OTEL: "off",
            GUARD_STOP_CHECK: "off",
            FACTORY_EVENTS_FILE: "",
            FACTORY_RUN_ID: "",
            GUARD_UNATTENDED: "",
            CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), "guard-stdin-")),
            ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => {
        resolve({ status, stdout, stderr });
    });
    child.stdin.on("error", () => {
        // the hook may exit before reading it all
    });
    void (async () => {
        for (const c of chunks) {
            child.stdin.write(c);
            if (gapMs)
                await sleep(gapMs);
        }
        if (end)
            child.stdin.end();
    })();
});
const claudeDeny = (r) => {
    const o = JSON.parse(r.stdout);
    assert.equal(o.hookSpecificOutput.hookEventName, "PreToolUse");
    return {
        decision: o.hookSpecificOutput.permissionDecision,
        reason: o.hookSpecificOutput.permissionDecisionReason,
    };
};
void test("guard hook: an unreadable PreToolUse payload is denied in each harness's shape", async () => {
    for (const args of [
        ["PreToolUse"],
        ["PreToolUse", "--no-ask", "--harness=codex"],
    ]) {
        const r = await hook(GUARD, args, ['{"tool_name":"Bash","tool_input":']);
        assert.equal(r.status, 0, r.stderr);
        const d = claudeDeny(r);
        assert.equal(d.decision, "deny");
        assert.match(d.reason, /could not read/);
    }
    const agy = await hook(GUARD, ["PreToolUse", "--harness=antigravity"], ['{"toolCall":']);
    assert.equal(agy.status, 0, agy.stderr);
    const a = JSON.parse(agy.stdout);
    assert.equal(a.decision, "deny");
    assert.match(a.reason, /could not read/);
});
void test("guard hook: empty and non-object PreToolUse payloads are denied", async () => {
    for (const body of [[], ["[]"], ["null"]]) {
        const r = await hook(GUARD, ["PreToolUse"], body);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(claudeDeny(r).decision, "deny");
    }
});
void test("guard hook: other events stay quiet on an unreadable payload", async () => {
    const r = await hook(GUARD, ["SessionStart"], ['{"session_id":']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
});
void test("guard hook: a payload that trickles in is judged whole", async () => {
    const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: 'git commit -m "bad title"' },
        cwd: tmpdir(),
        session_id: "s1",
    });
    const third = Math.ceil(payload.length / 3);
    const r = await hook(GUARD, ["PreToolUse"], [
        payload.slice(0, third),
        payload.slice(third, 2 * third),
        payload.slice(2 * third),
    ], { gapMs: 300 });
    assert.equal(r.status, 0, r.stderr);
    const d = claudeDeny(r);
    assert.equal(d.decision, "deny");
    assert.match(d.reason, /not a Conventional Commit header/);
});
const RUNTIME = { FACTORY_RUN_ID: "run-1", FACTORY_TICKET: "acme/app#12" };
void test("stop hook: a payload that never completes blocks a runtime run, and lets an attended stop go", async () => {
    // stdin stays open on a partial payload, so the reader runs out its deadline
    const [runtime, attended] = await Promise.all([
        hook(STOP, [], ['{"cwd":'], { end: false, env: RUNTIME }),
        hook(STOP, [], ['{"cwd":'], { end: false }),
    ]);
    assert.equal(runtime.status, 0, runtime.stderr);
    const o = JSON.parse(runtime.stdout);
    assert.equal(o.decision, "block");
    assert.match(o.reason, /could not read the hook input/);
    assert.equal(attended.status, 0, attended.stderr);
    assert.equal(attended.stdout, "");
});
void test("crashAnswer: a passed gate stays passed, a blocked gate keeps its block, an unfinished gate fails closed", () => {
    const input = { hook_event_name: "Stop" };
    const env = { ...RUNTIME };
    assert.equal(crashAnswer({ done: true, reason: null }, env, input), null);
    const blocked = crashAnswer({ done: true, reason: "gate says no" }, env, input);
    assert.equal(blocked?.decision, "block");
    assert.equal(blocked.reason, "gate says no");
    assert.equal(blocked.hookSpecificOutput?.decision, "block");
    const open = crashAnswer({ done: false, reason: null }, env, input, "why");
    assert.equal(open?.decision, "block");
    assert.match(open.reason ?? "", /could not check the result for run run-1 \(why\)/);
    assert.equal(crashAnswer({ done: false, reason: null }, {}, input), null);
});
void test("stopCheck: the gate's answer is reported before the make check starts", async () => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) {
        if (k.startsWith("FACTORY_") || k.startsWith("GUARD_")) {
            Reflect.deleteProperty(process.env, k);
        }
    }
    try {
        const order = [];
        const run = () => {
            order.push("run");
            return {
                status: 1,
                stdout: "",
                stderr: "",
            };
        };
        await stopCheck({ cwd: tmpdir() }, run, {
            onGate: (reason) => order.push(`gate:${String(reason)}`),
        });
        assert.equal(order[0], "gate:null");
        assert.ok(order.includes("run"));
    }
    finally {
        Object.assign(process.env, saved);
    }
});
