import assert from "node:assert/strict";
import { execFileSync, spawnSync, } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { harnessPid, keepAwake, keeperArgv } from "./awake.mjs";
import { lintFile } from "./lint.mjs";
import { fingerprint, gateFailClosed, resultGate, runDetached, stopCheck, takeLock, } from "./stop.mjs";
const tmp = () => mkdtempSync(join(tmpdir(), "guard-test-"));
const LINT_ROOT = fileURLToPath(new URL("./.lint-test/", import.meta.url));
const lintTmp = () => {
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
    "FACTORY_TICKET",
    "FACTORY_ATTENDED_RUN_ID",
    "FACTORY_ATTENDED_TICKET",
    "FACTORY_RUN_FILE",
    "GUARD_RESULT_GATE",
]) {
    Reflect.deleteProperty(process.env, k);
}
const stopRun = (calls, make, git = {
    status: 0,
    stdout: "x",
}, targets = ["check"]) => (cmd, args) => {
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
    const calls = [];
    const make = {
        status: 2,
        stdout: "ok\n".repeat(50) + "FAIL x\n",
        stderr: "",
    };
    const out = await stopCheck({ cwd: "/r" }, stopRun(calls, make, { status: 2 }), { strain: () => null });
    assert.ok(out);
    assert.equal(out.decision, "block");
    assert.match(out.reason ?? "", /make check failed[\s\S]*FAIL x$/);
    assert.deepEqual(out.hookSpecificOutput, {
        hookEventName: "Stop",
        decision: "block",
        reason: out.reason,
    });
    assert.ok((out.reason ?? "").split("\n").length <= 41);
    assert.deepEqual(calls.filter((c) => c.startsWith("make")), ["make -n check-fast", "make -n check", "make check"]);
});
void test("stop: a failure is reported with the failing target and its last line, scrubbed", async () => {
    const events = [];
    const make = {
        status: 2,
        stdout: "ok\n",
        stderr: "make[1]: *** [Makefile:3: test] Error 1\nAPI_TOKEN=supersecret leaked",
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
    const calls = [];
    const make = { status: 2, stdout: "FAIL y\n", stderr: "" };
    const out = await stopCheck({ cwd: "/r" }, stopRun(calls, make, { status: 2 }, ["check-fast", "check"]), { strain: () => null });
    assert.match(out?.reason ?? "", /^make check-fast failed/);
    assert.deepEqual(calls.filter((c) => c.startsWith("make")), ["make -n check-fast", "make check-fast"]);
});
void test("stop: passes when stop_hook_active, no check target, no make, or green", async () => {
    process.env.CLAUDE_PLUGIN_DATA = tmp();
    try {
        const never = () => {
            assert.fail("must not run");
        };
        assert.equal(await stopCheck({ stop_hook_active: true }, never), null);
        const failRunner = () => ({
            status: 2,
            stdout: "",
            stderr: "",
        });
        assert.equal(await stopCheck({}, failRunner), null);
        const errRunner = () => ({
            status: null,
            error: new Error("ENOENT"),
            stdout: "",
            stderr: "",
        });
        assert.equal(await stopCheck({}, errRunner), null);
        const okRunner = () => ({
            status: 0,
            stdout: "",
            stderr: "",
        });
        assert.equal(await stopCheck({}, okRunner, { strain: () => null }), null);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("stop: skips make check when the repo is unchanged since the last green run", async () => {
    const dir = tmp();
    process.env.CLAUDE_PLUGIN_DATA = dir;
    try {
        const calls = [];
        const run = stopRun(calls, { status: 0 });
        assert.equal(await stopCheck({ cwd: "/r" }, run, { strain: () => null }), null);
        assert.equal(calls.filter((c) => c === "make check").length, 1);
        assert.equal(await stopCheck({ cwd: "/r" }, run, { strain: () => null }), null);
        assert.equal(calls.filter((c) => c === "make check").length, 1);
        const changed = stopRun(calls, { status: 0 }, { status: 0, stdout: "y" });
        assert.equal(await stopCheck({ cwd: "/r" }, changed, { strain: () => null }), null);
        assert.equal(calls.filter((c) => c === "make check").length, 2);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("stop: a strained host or a check already running in the repo defers it, and the next stop runs it", async () => {
    const dir = tmp();
    process.env.CLAUDE_PLUGIN_DATA = dir;
    try {
        const calls = [];
        const events = [];
        const report = (e) => events.push(e);
        const out = await stopCheck({ cwd: "/r" }, stopRun(calls, { status: 0 }), {
            strain: () => "load 45",
            report,
        });
        assert.match(out?.systemMessage ?? "", /make check deferred \(host strained: load 45\)/);
        assert.equal(calls.filter((c) => c === "make check").length, 0);
        const busy = async (cmd, args) => {
            const busyOut = await stopCheck({ cwd: "/r" }, stopRun(calls, { status: 0 }), { strain: () => null, report });
            assert.match(busyOut?.systemMessage ?? "", /another stop check/);
            const res = stopRun(calls, { status: 0 })(cmd, args);
            return {
                status: res.status,
                stdout: res.stdout,
                stderr: res.stderr,
                timedOut: false,
            };
        };
        assert.equal(await stopCheck({ cwd: "/r" }, stopRun(calls, { status: 0 }), {
            exec: busy,
            strain: () => null,
            report,
        }), null);
        assert.deepEqual(events.map((e) => e.result), ["deferred", "deferred", "pass"]);
        assert.equal(typeof events[2]?.duration_ms, "number");
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("stop: a timeout is deferred, not blocked, and never marks green", async () => {
    const dir = tmp();
    process.env.CLAUDE_PLUGIN_DATA = dir;
    process.env.GUARD_STOP_TIMEOUT_MS = "5000";
    try {
        const calls = [];
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
        assert.match(out?.systemMessage ?? "", /make check deferred \(did not finish within 5 s\)/);
        await stopCheck({ cwd: "/r" }, stopRun(calls, { status: 0 }), {
            strain: () => null,
        });
        assert.equal(calls.filter((c) => c === "make check").length, 2);
    }
    finally {
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
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
        delete process.env.GUARD_STOP_CHECK;
    }
});
void test("stop: GUARD_STOP_CHECK=off disables it", async () => {
    process.env.GUARD_STOP_CHECK = "off";
    try {
        assert.equal(await stopCheck({}, () => {
            assert.fail("must not run");
        }), null);
    }
    finally {
        delete process.env.GUARD_STOP_CHECK;
    }
});
const gateRepo = (result) => {
    const repo = tmp();
    execFileSync("git", ["init", "-q", repo]);
    if (result !== undefined) {
        mkdirSync(join(repo, ".factory", "runs", "12"), { recursive: true });
        writeFileSync(join(repo, ".factory", "runs", "12", "result.json"), typeof result === "string" ? result : JSON.stringify(result));
    }
    process.env.CLAUDE_PLUGIN_DATA = tmp();
    return repo;
};
const validResult = (over = {}) => ({
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
const RUNTIME = {
    FACTORY_RUN_ID: "run-1",
    FACTORY_TICKET: "acme/app#12",
};
const ATTENDED = {
    FACTORY_ATTENDED_RUN_ID: "run-1",
    FACTORY_ATTENDED_TICKET: "acme/app#12",
};
void test("result gate: a runtime run with no result.json is blocked twice, then may stop", async () => {
    const cwd = gateRepo();
    try {
        const first = await resultGate({ cwd }, undefined, RUNTIME);
        assert.match(first ?? "", /block 1 of 2\): .*result\.json is not a valid result for run run-1:\nno such file\n/);
        assert.match(first ?? "", /write-result\.mjs, never by hand/);
        const events = [];
        assert.match((await resultGate({ cwd, stop_hook_active: true }, undefined, RUNTIME, (e) => events.push(e))) ?? "", /block 2 of 2[\s\S]*A subagent \(such as the verifier\) ignores this/);
        assert.equal(await resultGate({ cwd }, undefined, RUNTIME, (e) => events.push(e)), null);
        assert.deepEqual(events, [
            {
                result: "block",
                target: "result-gate",
                runner: "runtime",
                blocks: 2,
            },
            { result: "capped", target: "result-gate", runner: "runtime" },
        ]);
        assert.match((await resultGate({ cwd }, undefined, {
            ...RUNTIME,
            FACTORY_RUN_ID: "run-2",
        })) ?? "", /block 1 of 2/);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: a runtime run's invalid result, broken JSON or another run's file blocks with the errors; a valid one passes", async () => {
    try {
        assert.match((await resultGate({ cwd: gateRepo(validResult({ ticket: 12 })) }, undefined, RUNTIME)) ?? "", /ticket must be a string of the form/);
        assert.match((await resultGate({ cwd: gateRepo('{"schema": 2,') }, undefined, RUNTIME)) ?? "", /not valid JSON/);
        assert.match((await resultGate({ cwd: gateRepo(validResult({ run_id: "run-0" })) }, undefined, RUNTIME)) ?? "", /run_id "run-0" differs from FACTORY_RUN_ID "run-1"/);
        assert.equal(await resultGate({ cwd: gateRepo(validResult()) }, undefined, RUNTIME), null);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: a group run's tasks follow FACTORY_RUN_FILE, a relative path read from the session's directory", async () => {
    const task = (n) => ({
        ticket: "acme/app#" + String(n),
        outcome: "done",
        reason: "",
        reason_code: null,
        pr_link: "closes",
    });
    const group = validResult({
        schema: 3,
        pr: "https://github.com/acme/app/pull/20",
        tasks: [task(12), task(13)],
    });
    const withRun = (members) => {
        const cwd = gateRepo(group);
        writeFileSync(join(cwd, "run.json"), JSON.stringify({
            schema: 1,
            run_id: "run-1",
            lead: "acme/app#12",
            members: members.map((n) => ({ ticket: "acme/app#" + String(n) })),
        }));
        return cwd;
    };
    const env = { ...RUNTIME, FACTORY_RUN_FILE: "run.json" };
    try {
        assert.equal(await resultGate({ cwd: withRun([12, 13]) }, undefined, env), null);
        assert.match((await resultGate({ cwd: withRun([12, 14]) }, undefined, env)) ?? "", /block 1 of 2[\s\S]*differ from the run file's members/);
        assert.match((await resultGate({ cwd: gateRepo(group) }, undefined, env)) ?? "", /block 1 of 2[\s\S]*cannot check against the run file/);
        const single = (over) => {
            const cwd = gateRepo(validResult(over));
            writeFileSync(join(cwd, "run.json"), JSON.stringify({
                schema: 1,
                run_id: "run-1",
                lead: "acme/app#12",
                members: [{ ticket: "acme/app#12" }],
            }));
            return cwd;
        };
        assert.match((await resultGate({ cwd: single() }, undefined, env)) ?? "", /block 1 of 2[\s\S]*FACTORY_RUN_FILE is set, so this group run's result needs tasks/);
        assert.equal(await resultGate({
            cwd: single({
                end_state: "failed",
                reason: "refuse: not approved",
                reason_code: "auth",
            }),
        }, undefined, env), null);
        assert.match((await resultGate({
            cwd: single({
                end_state: "failed",
                reason: "refuse: not approved",
                reason_code: "auth",
                pr: "https://github.com/acme/app/pull/20",
            }),
        }, undefined, env)) ?? "", /block 1 of 2[\s\S]*needs tasks/);
        const merged = validResult({
            schema: 3,
            end_state: "parked",
            reason: "the PR waits on an owner merge",
            reason_code: "merge_gate",
            pr: "https://github.com/acme/app/pull/20",
            tasks: [task(12), task(13)],
        });
        const mergedRepo = () => {
            const cwd = gateRepo(merged);
            writeFileSync(join(cwd, "run.json"), JSON.stringify({
                schema: 1,
                run_id: "run-1",
                lead: "acme/app#12",
                members: [{ ticket: "acme/app#12" }, { ticket: "acme/app#13" }],
            }));
            return cwd;
        };
        assert.equal(await resultGate({ cwd: mergedRepo() }, undefined, env), null);
        const mixed = validResult({
            schema: 3,
            pr: "https://github.com/acme/app/pull/20",
            tasks: [
                task(12),
                {
                    ...task(13),
                    outcome: "parked",
                    reason: "waits",
                    reason_code: "question",
                    pr_link: "refs",
                },
            ],
        });
        const mixedRepo = () => {
            const cwd = gateRepo(mixed);
            writeFileSync(join(cwd, "run.json"), JSON.stringify({
                schema: 1,
                run_id: "run-1",
                lead: "acme/app#12",
                members: [{ ticket: "acme/app#12" }, { ticket: "acme/app#13" }],
            }));
            return cwd;
        };
        assert.match((await resultGate({ cwd: mixedRepo() }, undefined, env)) ?? "", /block 1 of 2[\s\S]*allow end_state parked at most, got "done"/);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: an attended run is held only to an invalid file carrying its own run id", async () => {
    try {
        assert.equal(await resultGate({ cwd: gateRepo() }, undefined, ATTENDED), null);
        assert.equal(await resultGate({ cwd: gateRepo("not json") }, undefined, ATTENDED), null);
        assert.equal(await resultGate({ cwd: gateRepo(validResult({ run_id: "other", ticket: 12 })) }, undefined, ATTENDED), null);
        assert.equal(await resultGate({ cwd: gateRepo(validResult()) }, undefined, ATTENDED), null);
        assert.match((await resultGate({ cwd: gateRepo(validResult({ ticket: 12 })) }, undefined, ATTENDED)) ?? "", /block 1 of 2[\s\S]*ticket must be a string/);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: off, a subagent, no factory run or a bad ticket pass; an attended run passes without a git checkout", async () => {
    try {
        const cwd = gateRepo();
        assert.equal(await resultGate({ cwd }, undefined, {
            ...RUNTIME,
            GUARD_RESULT_GATE: "off",
        }), null);
        assert.equal(await resultGate({ cwd, agent_id: "a1" }, undefined, RUNTIME), null);
        assert.equal(await resultGate({ cwd, hook_event_name: "SubagentStop" }, undefined, RUNTIME), null);
        assert.equal(await resultGate({ cwd }, undefined, {}), null);
        assert.equal(await resultGate({ cwd }, undefined, {
            ...RUNTIME,
            FACTORY_TICKET: "12",
        }), null);
        const mockGitFail = () => ({
            status: 128,
            stdout: "",
            stderr: "",
        });
        assert.equal(await resultGate({ cwd }, mockGitFail, ATTENDED), null);
        const events = [];
        const assertFail = () => {
            assert.fail("an attended gate error fails open");
        };
        assert.equal(await resultGate({ cwd }, assertFail, ATTENDED, (e) => events.push(e)), null);
        assert.deepEqual(events.map((e) => [e.result, e.target]), [["error", "result-gate"]]);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
const RUNTIME_BLOCK = /^Factory result gate: could not check the result for run run-1 \((.*)\); a runtime run never fails open, so the stop stays blocked\.$/;
void test("result gate: a runtime run never fails open on a missing checkout or a throwing runner", async () => {
    try {
        const cwd = gateRepo();
        const mockGitFail = () => ({
            status: 128,
            stdout: "",
            stderr: "",
        });
        const gitOut = await resultGate({ cwd }, mockGitFail, RUNTIME);
        assert.match(gitOut ?? "", RUNTIME_BLOCK);
        assert.match(gitOut ?? "", /git rev-parse failed/);
        const events = [];
        const throwing = () => {
            throw new Error("spawn failed token=abc123");
        };
        const out = await resultGate({ cwd }, throwing, RUNTIME, (e) => events.push(e));
        assert.match(out ?? "", RUNTIME_BLOCK);
        assert.match(out ?? "", /token=\*\*\*/);
        assert.deepEqual(events.map((e) => [e.result, e.target]), [["error", "result-gate"]]);
        // these blocks are not counted: the cap still allows two result blocks
        assert.match((await resultGate({ cwd }, undefined, RUNTIME)) ?? "", /block 1 of 2/);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
// The block counter of run-1, where stop.mts keeps it.
const counterPath = () => join(process.env.CLAUDE_PLUGIN_DATA ?? "", "result-gate", `${createHash("sha256").update("run-1").digest("hex").slice(0, 16)}.txt`);
const plantCounter = (plant) => {
    const cwd = gateRepo();
    const file = counterPath();
    mkdirSync(dirname(file), { recursive: true });
    plant(file);
    return cwd;
};
const mkfifo = (file) => {
    assert.equal(spawnSync("mkfifo", [file]).status, 0);
};
const posix = process.platform === "win32" ? { skip: "no mkfifo" } : {};
void test("result gate: a counter set to 2 releases an unset runtime run (the unset trust model)", async () => {
    try {
        const cwd = plantCounter((f) => {
            writeFileSync(f, "2");
        });
        assert.equal(await resultGate({ cwd }, undefined, RUNTIME), null);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: a malformed or oversized counter counts as the cap reached", async () => {
    try {
        for (const text of ["x", "-1", "1e3", "1".repeat(70), "", "1\n2"]) {
            const cwd = plantCounter((f) => {
                writeFileSync(f, text);
            });
            assert.equal(await resultGate({ cwd }, undefined, RUNTIME), null, JSON.stringify(text));
        }
        const cwd = plantCounter((f) => {
            writeFileSync(f, " 1\n");
        });
        assert.match((await resultGate({ cwd }, undefined, RUNTIME)) ?? "", /block 2 of 2/);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: a FIFO at the counter path is read without hanging, as the cap reached", posix, async () => {
    try {
        const cwd = plantCounter(mkfifo);
        const started = Date.now();
        assert.equal(await resultGate({ cwd }, undefined, RUNTIME), null);
        assert.ok(Date.now() - started < 5000);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: a directory at the counter path counts as the cap reached", async () => {
    try {
        const cwd = plantCounter((f) => {
            mkdirSync(f);
        });
        assert.equal(await resultGate({ cwd }, undefined, RUNTIME), null);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: strict mode stays blocked whatever sits at the counter path, and replaces a FIFO or symlink", async () => {
    try {
        for (const text of ["2", "garbage", "9".repeat(70)]) {
            const cwd = plantCounter((f) => {
                writeFileSync(f, text);
            });
            assert.match((await resultGate({ cwd }, undefined, strictEnv(""))) ?? "", /block 3; FACTORY_RESULT_CHECKER is set/, text);
        }
        if (process.platform !== "win32") {
            const cwd = plantCounter(mkfifo);
            assert.match((await resultGate({ cwd }, undefined, strictEnv(""))) ?? "", /block 3; FACTORY_RESULT_CHECKER is set/);
            assert.ok(lstatSync(counterPath()).isFile());
            assert.equal(readFileSync(counterPath(), "utf8"), "3");
            const target = join(tmp(), "target.txt");
            writeFileSync(target, "untouched");
            const linked = plantCounter((f) => {
                symlinkSync(target, f);
            });
            assert.match((await resultGate({ cwd: linked }, undefined, strictEnv(""))) ?? "", /block 3; FACTORY_RESULT_CHECKER is set/);
            assert.ok(lstatSync(counterPath()).isFile());
            assert.equal(readFileSync(target, "utf8"), "untouched");
        }
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: a counter that cannot be written blocks a runtime run and lets an attended one go", async () => {
    try {
        const cwd = gateRepo(validResult({ ticket: 12 }));
        writeFileSync(join(process.env.CLAUDE_PLUGIN_DATA ?? "", "result-gate"), "");
        assert.match((await resultGate({ cwd }, undefined, RUNTIME)) ?? "", RUNTIME_BLOCK);
        assert.equal(await resultGate({ cwd }, undefined, ATTENDED), null);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: runs before make check, and both reasons go in one block", async () => {
    const cwd = gateRepo();
    Object.assign(process.env, RUNTIME);
    try {
        const run = (cmd, args, opts) => cmd === "make"
            ? stopRun([], { status: 2, stdout: "FAIL z\n" }, { status: 2 })(cmd, args)
            : spawnSync(cmd, args, opts);
        const events = [];
        const out = await stopCheck({ cwd }, run, {
            strain: () => null,
            report: (e) => events.push(e),
        });
        assert.deepEqual(events.map((e) => `${String(e.target)}:${String(e.result)}`), ["result-gate:block", "check:fail"]);
        assert.ok(out);
        assert.equal(out.decision, "block");
        assert.match(out.reason ?? "", /^Factory result gate \(block 1 of 2\)[\s\S]*\n\nmake check failed[\s\S]*FAIL z$/);
        assert.deepEqual(out.hookSpecificOutput, {
            hookEventName: "Stop",
            decision: "block",
            reason: out.reason,
        });
        const activeOut = await stopCheck({ cwd, stop_hook_active: true }, run, {
            strain: () => null,
        });
        assert.match(activeOut?.reason ?? "", /^Factory result gate \(block 2 of 2\)[\s\S]*write-result\.mjs[\s\S]*\.$/);
        assert.equal(await stopCheck({ cwd, stop_hook_active: true }, run, {
            strain: () => null,
        }), null);
    }
    finally {
        for (const k of Object.keys(RUNTIME))
            Reflect.deleteProperty(process.env, k);
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
// A checker module written into its own temp dir, and the hooks that make prepareChecker treat it as out of reach.
const checkerFile = (body) => {
    const p = join(tmp(), "checker.mjs");
    writeFileSync(p, body);
    return p;
};
const OUT_OF_REACH = { writable: () => false, owner: () => false };
const strictEnv = (checker) => ({
    ...RUNTIME,
    FACTORY_RESULT_CHECKER: checker,
});
const passes = "export const resultErrors = () => []";
void test("result gate: a broken build copy blocks with the reason, a missing one means the core check alone", async () => {
    try {
        for (const [body, reason] of [
            ["throw new Error('at import')", /did not load \(at import\)/],
            ["export const other = 1", /exports no resultErrors function/],
            [
                "export const resultErrors = () => { throw new Error('boom') }",
                /threw \(boom\)/,
            ],
        ]) {
            const out = await resultGate({ cwd: gateRepo(validResult()) }, undefined, RUNTIME, undefined, { buildCopy: checkerFile(body) });
            assert.match(out ?? "", /block 1 of 2/);
            assert.match(out ?? "", /\(FACTORY_RESULT_CHECKER\) could not run: /);
            assert.match(out ?? "", reason);
        }
        assert.equal(await resultGate({ cwd: gateRepo(validResult()) }, undefined, RUNTIME, undefined, { buildCopy: join(tmp(), "none.mjs") }), null);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: unset keeps the write-result hand-back, strict gives the generic one", async () => {
    try {
        const unset = await resultGate({ cwd: gateRepo() }, undefined, RUNTIME);
        assert.match(unset ?? "", /write-result\.mjs, never by hand/);
        const strict = await resultGate({ cwd: gateRepo() }, undefined, strictEnv(checkerFile(passes)), undefined, OUT_OF_REACH);
        assert.match(strict ?? "", /\nFix result\.json until it passes the core check and the launcher's checker; never edit the checker\.\nA subagent/);
        assert.doesNotMatch(strict ?? "", /write-result/);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: a refused FACTORY_RESULT_CHECKER blocks with the reason and the core errors", async () => {
    try {
        const dir = tmp();
        const cases = [
            ["", /could not run: empty$/m],
            ["   ", /could not run: empty$/m],
            ["rel/c.mjs", /could not run: not an absolute path$/m],
            ["file:///x/c.mjs", /could not run: a URL or module specifier/],
            ["node:fs", /could not run: a URL or module specifier/],
            [join(dir, "missing.mjs"), /could not run: no such file$/m],
            [dir, /could not run: not a \.mjs file$/m],
        ];
        for (const [raw, reason] of cases) {
            const valid = await resultGate({ cwd: gateRepo(validResult()) }, undefined, strictEnv(raw));
            assert.match(valid ?? "", /block 1; FACTORY_RESULT_CHECKER is set/);
            assert.match(valid ?? "", reason);
            assert.doesNotMatch(valid ?? "", /differs from/);
            const bad = await resultGate({ cwd: gateRepo(validResult({ ticket: 12, run_id: "other" })) }, undefined, strictEnv(raw));
            assert.match(bad ?? "", reason);
            assert.match(bad ?? "", /ticket must be a string/);
            assert.match(bad ?? "", /run_id "other" differs from FACTORY_RUN_ID/);
            const missing = await resultGate({ cwd: gateRepo() }, undefined, strictEnv(raw));
            assert.match(missing ?? "", /\nno such file\n/);
            assert.match(missing ?? "", reason);
        }
        const unwritable = await resultGate({ cwd: gateRepo(validResult()) }, undefined, strictEnv(checkerFile(passes)), undefined, { writable: () => true, owner: () => false });
        assert.match(unwritable ?? "", /could not run: writable by this user/);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: a vetted checker passes a valid result, adds its errors and cannot loosen the core", async () => {
    try {
        assert.equal(await resultGate({ cwd: gateRepo(validResult()) }, undefined, strictEnv(checkerFile(passes)), undefined, OUT_OF_REACH), null);
        const added = await resultGate({ cwd: gateRepo(validResult()) }, undefined, strictEnv(checkerFile("export const resultErrors = () => ['custom']")), undefined, OUT_OF_REACH);
        assert.match(added ?? "", /block 1; FACTORY_RESULT_CHECKER is set[\s\S]*\ncustom\n/);
        const loose = await resultGate({ cwd: gateRepo(validResult({ run_id: "other" })) }, undefined, strictEnv(checkerFile(passes)), undefined, OUT_OF_REACH);
        assert.match(loose ?? "", /run_id "other" differs from FACTORY_RUN_ID "run-1"/);
        const dup = await resultGate({ cwd: gateRepo(validResult({ end_state: "" })) }, undefined, strictEnv(checkerFile("export const resultErrors = () => ['end_state must be a non-empty string, got \"\"', 'custom', 'custom']")), undefined, OUT_OF_REACH);
        assert.equal((dup ?? "").split("\n").filter((l) => l.startsWith("end_state must"))
            .length, 1);
        assert.equal((dup ?? "").split("\n").filter((l) => l === "custom").length, 1);
        const throws = await resultGate({ cwd: gateRepo(validResult()) }, undefined, strictEnv(checkerFile("export const resultErrors = () => { for (;;); }")), undefined, { ...OUT_OF_REACH, timeoutMs: 300 });
        assert.match(throws ?? "", /could not run: timed out after 0\.3 s/);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: strict mode is never capped, unset is capped after two blocks", async () => {
    try {
        const events = [];
        const cwd = gateRepo();
        const env = strictEnv("");
        for (let i = 1; i <= 4; i++) {
            const out = await resultGate({ cwd }, undefined, env, (e) => events.push(e));
            assert.ok(out?.startsWith(`Factory result gate (block ${String(i)}; FACTORY_RESULT_CHECKER is set, so the stop stays blocked until the result passes)`), out ?? "null");
        }
        assert.deepEqual(events.map((e) => e.result), ["block", "block", "block", "block"]);
        const plain = gateRepo();
        assert.ok(await resultGate({ cwd: plain }, undefined, RUNTIME));
        assert.ok(await resultGate({ cwd: plain }, undefined, RUNTIME));
        assert.equal(await resultGate({ cwd: plain }, undefined, RUNTIME), null);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: strict mode never fails open on an internal error", async () => {
    try {
        const cwd = gateRepo();
        const events = [];
        const throwing = () => {
            throw new Error("spawn failed token=abc123");
        };
        const out = await resultGate({ cwd }, throwing, strictEnv(""), (e) => events.push(e));
        assert.match(out ?? "", /^Factory result gate: could not check the result for run run-1 \(spawn failed token=\*\*\*\); FACTORY_RESULT_CHECKER is set, so the stop stays blocked\.$/);
        assert.deepEqual(events.map((e) => e.result), ["error"]);
        const gitFails = () => ({
            status: 128,
            stdout: "",
            stderr: "",
        });
        assert.match((await resultGate({ cwd }, gitFails, strictEnv(""))) ?? "", /could not check the result for run run-1 \(git rev-parse failed\)/);
        // the counter cannot be written: a file where the data dir should be
        const blocked = gateRepo();
        writeFileSync(join(process.env.CLAUDE_PLUGIN_DATA ?? "", "result-gate"), "");
        assert.match((await resultGate({ cwd: blocked }, undefined, strictEnv(""))) ?? "", /^Factory result gate: could not check the result/);
        // exempt or unidentified stops stay free, and unset still fails open
        assert.equal(await resultGate({ cwd, agent_id: "a" }, throwing, strictEnv("")), null);
        assert.equal(await resultGate({ cwd }, throwing, { FACTORY_RESULT_CHECKER: "" }), null);
        assert.match((await resultGate({ cwd }, throwing, RUNTIME)) ?? "", RUNTIME_BLOCK);
        assert.equal(await resultGate({ cwd }, throwing, ATTENDED), null);
        assert.match(gateFailClosed(RUNTIME, { cwd }, "x") ?? "", RUNTIME_BLOCK);
        assert.equal(gateFailClosed(ATTENDED, { cwd }, "x"), null);
        assert.equal(gateFailClosed({ ...RUNTIME, GUARD_RESULT_GATE: "off", FACTORY_RESULT_CHECKER: "" }, {}, "x"), null);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result check: a BOM and CRLF line ends in result.json are read", async () => {
    try {
        const text = `\uFEFF${JSON.stringify(validResult(), null, 2).replace(/\n/g, "\r\n")}`;
        assert.equal(await resultGate({ cwd: gateRepo(text) }, undefined, RUNTIME), null);
        assert.equal(await resultGate({ cwd: gateRepo(text) }, undefined, strictEnv(checkerFile(passes)), undefined, OUT_OF_REACH), null);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: an attended run keeps its semantics in strict mode", async () => {
    try {
        const env = { ...ATTENDED, FACTORY_RESULT_CHECKER: "" };
        assert.equal(await resultGate({ cwd: gateRepo() }, undefined, env), null);
        assert.equal(await resultGate({ cwd: gateRepo("not json") }, undefined, env), null);
        assert.equal(await resultGate({ cwd: gateRepo(validResult({ run_id: "other", ticket: 12 })) }, undefined, env), null);
        assert.equal(await resultGate({ cwd: gateRepo("[]") }, undefined, env), null);
        const out = await resultGate({ cwd: gateRepo(validResult({ ticket: 12 })) }, undefined, env);
        assert.match(out ?? "", /block 1; FACTORY_RESULT_CHECKER is set[\s\S]*ticket must be a string[\s\S]*could not run: empty/);
        assert.equal(await resultGate({ cwd: gateRepo(validResult()) }, undefined, {
            ...ATTENDED,
            FACTORY_RESULT_CHECKER: checkerFile(passes),
        }, undefined, OUT_OF_REACH), null);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: a failing make check never denies a stop, whether or not the gate blocked", async () => {
    const cwd = gateRepo();
    Object.assign(process.env, RUNTIME);
    try {
        const run = (cmd, args, opts) => {
            if (cmd === "make")
                throw new Error("make exploded");
            return spawnSync(cmd, args, opts);
        };
        const out = await stopCheck({ cwd }, run, { strain: () => null });
        assert.equal(out?.decision, "block");
        assert.match(out.reason ?? "", /^Factory result gate \(block 1 of 2\)/);
        // the gate passed: a later make error does not deny the stop
        const ok = gateRepo(validResult());
        assert.equal(await stopCheck({ cwd: ok }, run, { strain: () => null }), null);
        delete process.env.FACTORY_RUN_ID;
        assert.equal(await stopCheck({ cwd }, run, { strain: () => null }), null);
    }
    finally {
        for (const k of Object.keys(RUNTIME))
            Reflect.deleteProperty(process.env, k);
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
// A result.json the agent could plant: the gate must answer promptly with a block, never hang or read it.
const plantResult = (make) => {
    const cwd = gateRepo();
    const dir = join(cwd, ".factory", "runs", "12");
    mkdirSync(dir, { recursive: true });
    make(join(dir, "result.json"));
    return cwd;
};
void test("result gate: a FIFO or a device at result.json is a read error, never a hang", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
    try {
        const fifo = plantResult((f) => {
            assert.equal(spawnSync("mkfifo", [f]).status, 0);
        });
        const zero = plantResult((f) => {
            symlinkSync("/dev/zero", f);
        });
        for (const checker of [undefined, ""]) {
            const env = checker === undefined ? RUNTIME : strictEnv(checker);
            for (const cwd of [fifo, zero]) {
                const started = Date.now();
                const out = await resultGate({ cwd }, undefined, env);
                assert.match(out ?? "", /result\.json is not a valid result[\s\S]*\nnot a regular file\n/);
                assert.ok(Date.now() - started < 10_000);
            }
        }
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: a result.json over 1 MiB is blocked as too large, not read", async () => {
    try {
        const cwd = plantResult((f) => {
            writeFileSync(f, ` ${"x".repeat(1024 * 1024)}`);
        });
        for (const env of [RUNTIME, strictEnv("")]) {
            assert.match((await resultGate({ cwd }, undefined, env)) ?? "", /\ntoo large \(over 1 MiB\)\n/);
        }
        // an attended run keeps returning null on any read failure
        assert.equal(await resultGate({ cwd }, undefined, {
            ...ATTENDED,
            FACTORY_RESULT_CHECKER: "",
        }), null);
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
});
void test("result gate: a null or non-object input counts as an empty payload and a strict stop stays blocked", () => {
    for (const bad of [null, 5, [], "x"]) {
        const reason = gateFailClosed({ ...RUNTIME, FACTORY_RESULT_CHECKER: "" }, bad, "x");
        assert.match(reason ?? "", /could not check the result for run run-1/);
    }
});
// The emitted stop hook as a harness runs it: payload on stdin, one JSON object on stdout, exit 0.
const STOP_HOOK = fileURLToPath(new URL("./stop.mjs", import.meta.url));
const runStopHook = (payload, extraArgs, env) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FACTORY_") && !k.startsWith("GUARD_")));
    return spawnSync(process.execPath, [STOP_HOOK, ...extraArgs], {
        input: payload,
        encoding: "utf8",
        env: {
            ...clean,
            GUARD_STOP_CHECK: "off",
            GUARD_OTEL: "off",
            FACTORY_EVENTS_FILE: "",
            CLAUDE_PLUGIN_DATA: tmp(),
            ...env,
        },
    });
};
void test("result check: the stop hook CLI blocks on a refused checker, once, in each harness's shape", () => {
    const cwd = gateRepo();
    delete process.env.CLAUDE_PLUGIN_DATA;
    const env = { ...RUNTIME, FACTORY_RESULT_CHECKER: "rel/c.mjs" };
    const payload = JSON.stringify({ cwd, hook_event_name: "Stop" });
    const reason = /could not run: not an absolute path/;
    const claude = runStopHook(payload, [], env);
    assert.equal(claude.status, 0, claude.stderr);
    const c = JSON.parse(claude.stdout);
    assert.equal(c.decision, "block");
    assert.match(String(c.reason), reason);
    assert.equal(c.hookSpecificOutput.decision, "block");
    const codex = runStopHook(payload, ["--harness=codex"], env);
    assert.equal(codex.status, 0, codex.stderr);
    const x = JSON.parse(codex.stdout);
    assert.deepEqual(Object.keys(x).sort(), ["decision", "reason"]);
    assert.equal(x.decision, "block");
    assert.match(String(x.reason), reason);
    const anti = runStopHook(payload, ["--harness=antigravity"], env);
    assert.equal(anti.status, 0, anti.stderr);
    const a = JSON.parse(anti.stdout);
    assert.equal(a.decision, "continue");
    assert.match(String(a.reason), reason);
    const free = runStopHook(payload, [], { ...RUNTIME });
    assert.equal(free.status, 0, free.stderr);
});
void test("result check: the stop hook CLI keeps a strict stop blocked on an unreadable payload, and lets an unset one go", () => {
    const strict = runStopHook("{", [], {
        ...RUNTIME,
        FACTORY_RESULT_CHECKER: "",
    });
    assert.equal(strict.status, 0, strict.stderr);
    const out = JSON.parse(strict.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /could not check the result for run run-1 \(internal error\)/);
    const unset = runStopHook("{", [], { ...RUNTIME });
    assert.equal(unset.status, 0, unset.stderr);
    const runtime = JSON.parse(unset.stdout);
    assert.equal(runtime.decision, "block");
    assert.match(runtime.reason, /could not check the result for run run-1 \(internal error\); a runtime run never fails open, so the stop stays blocked\./);
    const attended = runStopHook("{", [], { ...ATTENDED });
    assert.equal(attended.status, 0, attended.stderr);
    assert.equal(attended.stdout, "");
});
void test("result check: the stop hook CLI blocks a runtime run on an internal error, in each harness's shape", () => {
    const reason = /a runtime run never fails open/;
    const claude = runStopHook("{", [], { ...RUNTIME });
    assert.equal(claude.status, 0, claude.stderr);
    const c = JSON.parse(claude.stdout);
    assert.equal(c.decision, "block");
    assert.match(String(c.reason), reason);
    const codex = runStopHook("{", ["--harness=codex"], { ...RUNTIME });
    assert.equal(codex.status, 0, codex.stderr);
    const x = JSON.parse(codex.stdout);
    assert.deepEqual(Object.keys(x).sort(), ["decision", "reason"]);
    assert.equal(x.decision, "block");
    assert.match(String(x.reason), reason);
    const anti = runStopHook("{", ["--harness=antigravity"], { ...RUNTIME });
    assert.equal(anti.status, 0, anti.stderr);
    const a = JSON.parse(anti.stdout);
    assert.equal(a.decision, "continue");
    assert.match(String(a.reason), reason);
});
void test("lint: shellcheck findings come back as context; clean, missing tool or other files pass", () => {
    const dir = lintTmp();
    const sh = join(dir, "a.sh");
    const md = join(dir, "a.md");
    writeFileSync(sh, "echo $x\n");
    writeFileSync(md, "# x\n");
    const findings = () => ({
        status: 1,
        stdout: "SC2086: quote this\n",
        stderr: "",
    });
    const out = lintFile({ tool_name: "Edit", tool_input: { file_path: sh } }, findings);
    assert.ok(out);
    assert.match(out.hookSpecificOutput.additionalContext ?? "", /SC2086/);
    assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.equal(out.additionalContext, out.hookSpecificOutput.additionalContext);
    assert.match(lintFile({ tool_name: "create", tool_input: { path: sh } }, findings)
        ?.additionalContext ?? "", /a\.sh/);
    const okRunner = () => ({
        status: 0,
        stdout: "",
        stderr: "",
    });
    assert.equal(lintFile({ tool_name: "Write", tool_input: { file_path: sh } }, okRunner), null);
    const errRunner = () => ({
        status: null,
        error: new Error("ENOENT"),
        stdout: "",
        stderr: "",
    });
    assert.equal(lintFile({ tool_name: "Write", tool_input: { file_path: sh } }, errRunner), null);
    assert.equal(lintFile({ tool_name: "Write", tool_input: { file_path: md } }, findings), null);
    assert.equal(lintFile({ tool_name: "Write", tool_input: { file_path: join(dir, "gone.sh") } }, findings), null);
    assert.equal(lintFile({ tool_name: "read_file", tool_input: { filePath: sh } }, findings), null);
});
void test("lint: VS Code and apply_patch spellings of the edited files", () => {
    const dir = lintTmp();
    const sh = join(dir, "a.sh");
    const findings = () => ({
        status: 1,
        stdout: "SC2086\n",
        stderr: "",
    });
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
    ]) {
        const out = lintFile({ tool_name, tool_input, cwd: dir }, findings);
        assert.equal(out?.additionalContext.match(/Lint findings/g)?.length, 1, tool_name);
    }
});
void test("lint: .ps1 goes to PSScriptAnalyzer through pwsh, powershell on Windows", () => {
    const dir = lintTmp();
    const ps1 = join(dir, "a.ps1");
    writeFileSync(ps1, "Write-Host x\n");
    let used;
    const run = (cmd, _args, opts) => {
        const envObj = opts
            ?.env;
        used = [cmd, envObj?.GUARD_LINT_FILE];
        return {
            status: 0,
            stdout: "RuleName : PSAvoidUsingWriteHost\n",
            stderr: "",
        };
    };
    assert.match(lintFile({ tool_name: "Edit", tool_input: { file_path: ps1 } }, run, "darwin")?.hookSpecificOutput.additionalContext ?? "", /PSAvoidUsingWriteHost/);
    assert.deepEqual(used, ["pwsh", ps1]);
    lintFile({ tool_name: "Edit", tool_input: { file_path: ps1 } }, run, "win32");
    assert.ok(used);
    assert.equal(used[0], "powershell");
});
void test("awake: walks past shells to the harness pid", () => {
    const tree = {
        10: { ppid: 9, name: "bash" },
        9: { ppid: 8, name: "/bin/zsh" },
        8: { ppid: 1, name: "claude" },
    };
    const lookup = (p) => {
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
        platform: "darwin",
        launch: () => 1000 + ++launched,
    };
    assert.equal(keepAwake({ ...base, isAlive: () => true })?.keeper, 1001);
    assert.equal(keepAwake({ ...base, isAlive: () => true }), null);
    assert.equal(keepAwake({ ...base, isAlive: () => false })?.keeper, 1002);
    assert.equal(keepAwake({ ...base, launch: () => undefined, isAlive: () => false }), null);
});
void test("stop: make runs without a terminal, so a recipe reading /dev/tty fails at once", { skip: process.platform === "win32" }, async () => {
    const started = Date.now();
    const r = await runDetached("sh", ["-c", "read x < /dev/tty"], {
        cwd: tmp(),
        timeout: 20_000,
    });
    assert.notEqual(r.status, 0);
    assert.equal(r.timedOut, false);
    assert.ok(Date.now() - started < 10_000);
});
void test("stop: a timeout kills the whole process group, grandchildren included", { skip: process.platform === "win32" }, async () => {
    const dir = tmp();
    const r = await runDetached("sh", ["-c", "sleep 60 & echo $! > pid; wait"], { cwd: dir, timeout: 500 });
    assert.equal(r.timedOut, true);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(pid, 0));
});
void test("stop: a timeout resolves at once even when a surviving grandchild keeps the pipes open", async () => {
    const dir = tmp();
    const middle = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }); require('fs').writeFileSync('pid', String(c.pid)); c.unref()";
    const started = Date.now();
    const r = await runDetached(process.execPath, ["-e", middle], {
        cwd: dir,
        timeout: 500,
    });
    try {
        assert.equal(r.timedOut, true);
        assert.ok(Date.now() - started < 5000, "resolved after " + String(Date.now() - started) + " ms");
    }
    finally {
        try {
            process.kill(Number(readFileSync(join(dir, "pid"), "utf8")));
        }
        catch { }
    }
});
void test("stop: the fingerprint changes when an untracked file changes", () => {
    const dir = tmp();
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
    writeFileSync(join(dir, "new.py"), "a = 1\n");
    const before = fingerprint(dir);
    writeFileSync(join(dir, "new.py"), "a = 2\n");
    assert.ok(before);
    assert.notEqual(fingerprint(dir), before);
});
const docsRepo = () => {
    const dir = tmp();
    const git = (...args) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "Makefile"), "check:\n\t@true\n");
    writeFileSync(join(dir, "src", "a.py"), "a = 1\n");
    writeFileSync(join(dir, "README.md"), "# r\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const checks = [];
    const run = (cmd, args, opts) => {
        if (cmd !== "make") {
            return spawnSync(cmd, args, opts);
        }
        if (args[0] === "-n") {
            return {
                status: args[1] === "check" ? 0 : 2,
                stdout: "",
                stderr: "",
            };
        }
        checks.push(args[0] ?? "");
        return {
            status: 0,
            stdout: "",
            stderr: "",
        };
    };
    const stop = () => stopCheck({ cwd: dir }, run, { strain: () => null });
    return {
        dir,
        git,
        checks,
        stop,
        write: (p, s) => {
            mkdirSync(dirname(join(dir, p)), { recursive: true });
            writeFileSync(join(dir, p), s);
        },
    };
};
const withData = async (fn) => {
    process.env.CLAUDE_PLUGIN_DATA = tmp();
    try {
        await fn();
    }
    finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
    }
};
void test("stop: a clean first turn and docs-only change skip make check; a code or mixed change runs it", () => withData(async () => {
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
void test("stop: GUARD_STOP_CHECK=force runs make check on a clean tree", () => withData(async () => {
    const r = docsRepo();
    process.env.GUARD_STOP_CHECK = "force";
    try {
        await r.stop();
    }
    finally {
        delete process.env.GUARD_STOP_CHECK;
    }
    assert.equal(r.checks.length, 1);
}));
void test("stop: a code commit since the last green run is not hidden by a docs-only working tree", () => withData(async () => {
    const r = docsRepo();
    process.env.GUARD_STOP_CHECK = "force";
    try {
        await r.stop();
    }
    finally {
        delete process.env.GUARD_STOP_CHECK;
    }
    r.write("src/a.py", "a = 3\n");
    r.git("commit", "-qam", "code");
    r.write("README.md", "# after\n");
    await r.stop();
    assert.equal(r.checks.length, 2, "the diff is taken against the green run, not HEAD");
    r.write("README.md", "# docs commit\n");
    r.git("commit", "-qam", "docs");
    await r.stop();
    assert.equal(r.checks.length, 2, "only a docs commit since the last green run: skipped");
}));
void test("stop: a code file renamed into docs/ still runs the check (renames count as delete and add)", () => withData(async () => {
    const r = docsRepo();
    r.git("mv", "src/a.py", "docs/a.py");
    await r.stop();
    assert.equal(r.checks.length, 1);
}));
void test("stop: the repo's .stop-check-ignore keeps matching docs checked and extends the skip list", () => withData(async () => {
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
void test("stop: GUARD_STOP_CHECK=off still disables it and force still skips only the strain deferral", () => withData(async () => {
    const r = docsRepo();
    r.write("README.md", "# x\n");
    process.env.GUARD_STOP_CHECK = "force";
    try {
        const runner = (c, a, o) => {
            if (c === "make" && a[0] !== "-n") {
                assert.fail("docs only");
            }
            return c === "make"
                ? {
                    status: a[1] === "check" ? 0 : 2,
                }
                : spawnSync(c, a, o);
        };
        await stopCheck({ cwd: r.dir }, runner, { strain: () => "load 99" });
    }
    finally {
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
    const findings = () => ({
        status: 1,
        stdout: "SC2086\n",
        stderr: "",
    });
    const bash = join(dir, "b.sh");
    const zsh = join(dir, "z.sh");
    writeFileSync(bash, "#!/usr/bin/env bash\necho $x\n");
    writeFileSync(zsh, "#!/bin/zsh\necho $x\n");
    const patch = `*** Begin Patch\n*** Add File: ${bash}\n+y\n*** End Patch\n`;
    assert.match(lintFile({ tool_name: "apply_patch", tool_input: { command: patch }, cwd: dir }, findings)?.additionalContext ?? "", /b\.sh/);
    assert.equal(lintFile({ tool_name: "Write", tool_input: { file_path: zsh } }, findings), null);
    const scratch = join(tmp(), "s.sh");
    writeFileSync(scratch, "echo $x\n");
    assert.equal(lintFile({ tool_name: "Write", tool_input: { file_path: scratch } }, findings), null);
});
void test('stop check: Antigravity hook receives { decision: "continue", reason } when blocked or passes cleanly', () => {
    const res = spawnSync(process.execPath, [join(import.meta.dirname, "stop.mjs"), "--harness=antigravity"], {
        input: JSON.stringify({
            conversationId: "agy-stop-1",
            workspacePaths: ["/tmp/nonexistent"],
            terminationReason: "NO_TOOL_CALL",
        }),
        encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
});
void test("result check: the stop hook CLI keeps a strict stop blocked on a payload that is not an object", () => {
    for (const payload of ["null", "5", "[]", '"x"']) {
        const strict = runStopHook(payload, [], strictEnv(""));
        assert.equal(strict.status, 0, strict.stderr);
        const out = JSON.parse(strict.stdout);
        assert.equal(out.decision, "block");
    }
});
