// The run contract v2 kit (docs/guard.md, "Run contract v2"). An external runner runs it as one CI job against a
// pinned checkout of this repo:
//
//   make contract-test MANIFEST=<absolute path to the runner's installed manifest>
//
// `make test` runs it too, with the bundled fixture (fixtures/acme-runner.json) as the subject; the scenarios that
// need a manifest installed out of the user's reach are then skipped. Nothing is pending.
// Spawned guards inherit these: no telemetry, no stop check, no fake events in a real run's file.
process.env.GUARD_OTEL = "off";
process.env.GUARD_STOP_CHECK = "off";
process.env.GUARD_RUN_EVENTS_FILE = "";
// Guard reads no legacy run variable for a decision: a stray one in the caller's shell would trip the tripwire.
for (const k of [
    "FACTORY_RUN_ID",
    "FACTORY_ATTENDED_RUN_ID",
    "FACTORY_TICKET",
    "FACTORY_ATTENDED_TICKET",
    "FACTORY_RUN_FILE",
    "FACTORY_PROTECTED_PATHS",
    "FACTORY_EVENTS_FILE",
    "FACTORY_RESULT_CHECKER",
]) {
    Reflect.deleteProperty(process.env, k);
}
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UNREGISTERED_RULE, parseRegistration, unregisteredLine, validateRegistration, } from "../../plugins/guard/core/registration.mjs";
import { DEFAULT_PROTECTED_LIMITS } from "../../plugins/guard/core/constants.mjs";
import { prepareChecker } from "../../plugins/guard/hooks/checker.mjs";
import { loadRegistration, pinFile, } from "../../plugins/guard/hooks/registration.mjs";
const MANIFEST = process.env.CONTRACT_MANIFEST;
const FIXTURE = fileURLToPath(new URL("./fixtures/acme-runner.json", import.meta.url));
const GUARD = fileURLToPath(new URL("../../plugins/guard/hooks/guard.mjs", import.meta.url));
const pathApi = process.platform === "win32" ? path.win32 : path;
const subject = MANIFEST ?? FIXTURE;
const NEEDS_MANIFEST = "needs MANIFEST=<abs path> installed out of this user's reach";
const skipUnlessManifest = MANIFEST ? false : NEEDS_MANIFEST;
const dataDir = mkdtempSync(path.join(os.tmpdir(), "contract-kit-"));
after(() => {
    rmSync(dataDir, { recursive: true, force: true });
});
const subjectJson = () => JSON.parse(readFileSync(subject, "utf8"));
const validate = (value) => validateRegistration(value, DEFAULT_PROTECTED_LIMITS, pathApi);
const errorsOf = (v) => v.ok ? [] : v.errors;
const denied = (l) => {
    if (l.state !== "deny")
        assert.fail(`expected a deny, got ${l.state}`);
    return l;
};
void test("contract: MANIFEST is an absolute path", () => {
    if (MANIFEST !== undefined) {
        assert.ok(pathApi.isAbsolute(MANIFEST), `MANIFEST must be an absolute path, got ${MANIFEST}`);
    }
});
void test("contract: the guard probe reports contract 2 and the required capabilities", () => {
    const r = spawnSync(process.execPath, [GUARD, "--contract"], {
        input: "",
        timeout: 10000,
        encoding: "utf8",
    });
    assert.equal(r.status, 0, `probe exited ${String(r.status)}: ${r.stderr}`);
    const lines = r.stdout.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 1, `expected one JSON line, got: ${r.stdout}`);
    const probe = JSON.parse(lines[0] ?? "");
    assert.equal(probe.contract, 2);
    assert.equal(typeof probe.guard, "string");
    assert.ok(Array.isArray(probe.capabilities));
    const missing = subjectJson().requires.filter((c) => !probe.capabilities.includes(c));
    assert.deepEqual(missing, [], `guard lacks capabilities: ${missing.join(", ")}`);
});
void test("contract: the probe says whether the contract is enforced", () => {
    const r = spawnSync(process.execPath, [GUARD, "--contract"], {
        input: "",
        timeout: 10000,
        encoding: "utf8",
    });
    assert.equal(r.status, 0, `probe exited ${String(r.status)}: ${r.stderr}`);
    const probe = JSON.parse(r.stdout.split("\n")[0] ?? "");
    assert.equal(probe.enforced, true, "the probe must report `enforced: true`; a runner must refuse to start unless it does");
});
void test("contract: the manifest validates", () => {
    const v = parseRegistration(readFileSync(subject), DEFAULT_PROTECTED_LIMITS, pathApi);
    assert.ok(v.ok, `invalid manifest: ${errorsOf(v).join("; ")}`);
});
const runEnv = () => ({
    GUARD_RUN_MANIFEST: MANIFEST,
    GUARD_RUN_ID: "contract-test-1",
    GUARD_RUN_TICKET: "acme/app#1",
    GUARD_RUN_MODE: subjectJson().modes?.[0] ?? "unattended",
});
void test("contract: the manifest loads with trust", { skip: skipUnlessManifest }, () => {
    const loaded = loadRegistration(runEnv(), {
        dataDir,
        sessionId: "contract-load",
    });
    if (loaded.state !== "registered") {
        assert.fail(loaded.state === "deny" ? loaded.why : "no registration");
    }
    if (subjectJson().result?.checker) {
        assert.ok(loaded.checker, "result.checker is set but not returned");
    }
});
void test("contract: an unknown capability is refused", () => {
    const m = subjectJson();
    const v = validate({ ...m, requires: [...m.requires, "teleport"] });
    assert.equal(v.ok, false);
    assert.ok(errorsOf(v).some((e) => e.includes("unknown capability")), errorsOf(v).join("; "));
});
void test("contract: another contract major is refused", () => {
    for (const contract of [3, "2"]) {
        const v = validate({ ...subjectJson(), contract });
        assert.equal(v.ok, false, `contract ${JSON.stringify(contract)}`);
        assert.ok(errorsOf(v).some((e) => e.includes("contract must be 2")), errorsOf(v).join("; "));
    }
});
void test("contract: an unknown key is refused at any level", () => {
    const m = subjectJson();
    for (const value of [
        { ...m, extra: 1 },
        { ...m, labels: { ...m.labels, extra: 1 } },
    ]) {
        const v = validate(value);
        assert.equal(v.ok, false);
        assert.ok(errorsOf(v).some((e) => e.includes("unknown key")), errorsOf(v).join("; "));
    }
});
void test("contract: a missing manifest denies", () => {
    const loaded = loadRegistration({
        GUARD_RUN_MANIFEST: path.join(dataDir, "missing.json"),
        GUARD_RUN_ID: "contract-test-1",
    }, { dataDir, sessionId: "contract-missing" });
    const d = denied(loaded);
    assert.equal(d.rule, "run-registration");
    assert.match(d.why, /no such file/);
});
void test("contract: the run variables out of step deny", () => {
    const noManifest = loadRegistration({ GUARD_RUN_ID: "contract-test-1" }, { dataDir, sessionId: "contract-step-1" });
    assert.match(denied(noManifest).why, /GUARD_RUN_ID is set but GUARD_RUN_MANIFEST is not/);
    const noId = loadRegistration({ GUARD_RUN_MANIFEST: subject }, { dataDir, sessionId: "contract-step-2" });
    assert.match(denied(noId).why, /GUARD_RUN_MANIFEST is set but GUARD_RUN_ID is not/);
});
void test("contract: a manifest this user can write is refused", () => {
    const copy = path.join(dataDir, "writable-manifest.json");
    copyFileSync(subject, copy);
    const loaded = loadRegistration({ GUARD_RUN_MANIFEST: copy, GUARD_RUN_ID: "contract-test-1" }, { dataDir, sessionId: "contract-writable" });
    assert.match(denied(loaded).why, /writable by this user/);
});
void test("contract: a checker this user can write is refused", () => {
    const checker = path.join(dataDir, "writable-checker.mjs");
    writeFileSync(checker, "export function resultErrors() { return []; }\n");
    const prepared = prepareChecker(checker);
    assert.ok("why" in prepared, "a writable checker was accepted");
    if ("why" in prepared)
        assert.match(prepared.why, /writable by this user/);
});
void test("contract: a manifest changed during the session denies", { skip: skipUnlessManifest }, () => {
    const sessionId = "contract-changed";
    mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
    writeFileSync(pinFile(dataDir, sessionId), JSON.stringify({
        manifest: realpathSync(subject),
        sha256: "0".repeat(64),
        run_id: runEnv().GUARD_RUN_ID,
        mode: runEnv().GUARD_RUN_MODE,
        ticket: runEnv().GUARD_RUN_TICKET,
    }) + "\n");
    const loaded = loadRegistration(runEnv(), { dataDir, sessionId });
    assert.match(denied(loaded).why, /changed during the session/);
});
void test("contract: the legacy-only tripwire line has a fixed shape", () => {
    const line = JSON.parse(unregisteredLine());
    assert.deepEqual(Object.keys(line).sort(), [
        "decision",
        "event",
        "reason",
        "rule",
        "ts",
    ]);
    assert.equal(line.event, UNREGISTERED_RULE);
    assert.equal(line.rule, UNREGISTERED_RULE);
    assert.equal(line.decision, "deny");
    assert.ok(!Number.isNaN(Date.parse(line.ts ?? "")), "ts is not a date");
    assert.ok(!/[/\\]/.test(line.reason ?? ""), "reason carries a path");
});
// The decisions, end to end: the real hooks in a temp git repo, one fresh session per scenario. Those that need the
// registration trusted run only against MANIFEST; the unattended-only ones also need its modes to allow it.
const STOP = fileURLToPath(new URL("../../plugins/guard/hooks/stop.mjs", import.meta.url));
const unattendedModes = subjectJson().modes;
const skipUnattended = skipUnlessManifest ||
    (unattendedModes && !unattendedModes.includes("unattended")
        ? "the manifest's modes exclude unattended"
        : false);
const skipWithout = (have, what, base = skipUnattended) => base || (have ? false : `the manifest registers no ${what}`);
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter((e) => e[1] !== undefined &&
    !e[0].startsWith("FACTORY_") &&
    !e[0].startsWith("GUARD_") &&
    e[0] !== "CLAUDE_PLUGIN_DATA"));
const scratch = (name) => mkdtempSync(path.join(dataDir, `${name}-`));
const gitRepo = () => {
    const repo = scratch("repo");
    const r = spawnSync("git", ["init", "-q", repo]);
    assert.equal(r.status, 0, String(r.stderr));
    return repo;
};
let scenarioCount = 0;
// A registered run of the subject: its variables, an events file, a data dir and a session id of their own.
const newRun = (mode = "unattended") => {
    scenarioCount += 1;
    const events = path.join(scratch("events"), "events.jsonl");
    return {
        cwd: gitRepo(),
        events,
        session: `contract-scenario-${String(scenarioCount)}`,
        env: {
            GUARD_RUN_MANIFEST: MANIFEST ?? "",
            GUARD_RUN_ID: `contract-run-${String(scenarioCount)}`,
            GUARD_RUN_TICKET: "acme/app#1",
            GUARD_RUN_MODE: mode,
            GUARD_RUN_EVENTS_FILE: events,
            GUARD_OTEL: "off",
            GUARD_STOP_CHECK: "off",
            CLAUDE_PLUGIN_DATA: scratch("data"),
        },
    };
};
const hook = (script, run, payload, env = {}) => {
    const r = spawnSync(process.execPath, [script], {
        input: JSON.stringify({
            session_id: run.session,
            cwd: run.cwd,
            ...payload,
        }),
        encoding: "utf8",
        timeout: 30000,
        env: { ...cleanEnv(), ...run.env, ...env },
    });
    assert.equal(r.status, 0, `hook exited ${String(r.status)}: ${r.stderr}`);
    return r.stdout;
};
const bash = (run, command, env) => hook(GUARD, run, {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
}, env);
const stopOf = (run, env) => hook(STOP, run, { hook_event_name: "Stop" }, env);
const eventLines = (file) => readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const assertDenied = (stdout, rule, run) => {
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, "deny", stdout);
    assert.equal(eventLines(run.events).at(-1)?.rule, rule);
};
const assertNotDenied = (stdout) => {
    const out = (stdout.trim() ? JSON.parse(stdout) : {});
    assert.notEqual(out.hookSpecificOutput?.permissionDecision, "deny", stdout);
};
// A path a glob matches: each run of `*` or `?` becomes `x`.
const concrete = (glob) => glob.replace(/[*?]+/g, "x");
const labelOf = (key) => {
    const v = subjectJson().labels?.[key];
    return typeof v === "string" ? v : undefined;
};
const protectedPaths = () => subjectJson().protected_paths ?? {};
void test("contract: a label approval change is denied", { skip: skipWithout(labelOf("approval"), "approval label") }, () => {
    const run = newRun();
    assertDenied(bash(run, `gh issue edit 1 --add-label ${labelOf("approval") ?? ""}`), "run-label", run);
});
void test("contract: a label takeover change is denied", { skip: skipWithout(labelOf("takeover"), "takeover label") }, () => {
    const run = newRun();
    assertDenied(bash(run, `gh issue edit 1 --add-label ${labelOf("takeover") ?? ""}`), "run-label", run);
});
void test("contract: an unusable manifest denies label changes", () => {
    const run = newRun();
    const copy = path.join(scratch("writable"), "run.json");
    copyFileSync(subject, copy);
    assertDenied(bash(run, "gh issue edit 1 --add-label x", { GUARD_RUN_MANIFEST: copy }), "run-registration", run);
});
void test("contract: a changed run id, ticket or mode during the session denies", { skip: skipUnlessManifest }, () => {
    // the pin holds in either mode: start in one the manifest allows
    const first = !unattendedModes || unattendedModes.includes("unattended")
        ? "unattended"
        : (unattendedModes[0] ?? "attended");
    const changes = [
        { GUARD_RUN_ID: "contract-run-other" },
        { GUARD_RUN_TICKET: "acme/app#2" },
    ];
    // the mode flip needs a manifest that allows both modes
    if (!unattendedModes ||
        (unattendedModes.includes("attended") &&
            unattendedModes.includes("unattended"))) {
        changes.push({ GUARD_RUN_MODE: "attended" });
    }
    for (const change of changes) {
        const run = newRun(first);
        assertNotDenied(bash(run, "echo ok"));
        const out = bash(run, "echo ok", change);
        assertDenied(out, "run-registration", run);
        assert.match(out, /run variables changed during the session/);
    }
});
void test("contract: a protected path write is denied", { skip: skipUnattended }, () => {
    const run = newRun();
    assertDenied(bash(run, "echo x > .github/workflows/x.yml"), "protected-path", run);
    const first = protectedPaths().globs?.[0];
    if (first) {
        const second = newRun();
        assertDenied(bash(second, `echo x > ${concrete(first)}`), "protected-path", second);
    }
});
void test("contract: an exempt path write is allowed", {
    skip: skipWithout(protectedPaths().exempt?.[0], "exempt path", skipUnattended),
}, () => {
    const run = newRun();
    const target = concrete(protectedPaths().exempt?.[0] ?? "");
    mkdirSync(path.join(run.cwd, path.dirname(target)), { recursive: true });
    assertNotDenied(bash(run, `echo x > ${target}`));
});
void test("contract: a gh alias is denied", { skip: skipUnattended }, () => {
    const run = newRun();
    assertDenied(bash(run, "gh co 1"), "run-label", run);
});
void test("contract: the events decision line has a fixed shape", { skip: skipUnattended }, () => {
    const run = newRun();
    const command = "echo contract-secret-text > .github/workflows/x.yml";
    bash(run, command);
    const raw = readFileSync(run.events, "utf8");
    const lines = eventLines(run.events);
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0] ?? {}).sort(), [
        "cmd_hash",
        "decision",
        "rule",
        "ts",
    ]);
    assert.ok(!raw.includes("contract-secret-text"), "the line carries command text");
    assert.ok(!Number.isNaN(Date.parse(String(lines[0]?.ts))), "ts is not a date");
});
void test("contract: a bad result blocks the stop", { skip: skipWithout(subjectJson().result, "result", skipUnlessManifest) }, () => {
    const run = newRun(unattendedModes && !unattendedModes.includes("unattended")
        ? (unattendedModes[0] ?? "attended")
        : "unattended");
    const file = (subjectJson().result?.file ?? "")
        .replaceAll("{ticket_number}", "1")
        .replaceAll("{run_id}", run.env.GUARD_RUN_ID ?? "");
    mkdirSync(path.join(run.cwd, path.dirname(file)), { recursive: true });
    // valid JSON carrying the run id that fails the core check (no ticket, no end_state): both modes block on it
    writeFileSync(path.join(run.cwd, file), JSON.stringify({ run_id: run.env.GUARD_RUN_ID }));
    const stdout = stopOf(run);
    assert.notEqual(stdout.trim(), "", "the stop hook printed nothing for a result that fails the core check");
    const out = JSON.parse(stdout);
    assert.equal(out.decision, "block");
    assert.match(String(out.reason), /Run result gate/);
});
void test("contract: an unattended run's stop is never released on a count, only by a passing result", { skip: skipWithout(subjectJson().result, "result") }, () => {
    const run = newRun("unattended");
    const file = (subjectJson().result?.file ?? "")
        .replaceAll("{ticket_number}", "1")
        .replaceAll("{run_id}", run.env.GUARD_RUN_ID ?? "");
    mkdirSync(path.join(run.cwd, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(run.cwd, file), JSON.stringify({ run_id: run.env.GUARD_RUN_ID }));
    // more stops than any cap of two: every one stays blocked while the result fails
    for (let i = 1; i <= 4; i++) {
        const stdout = stopOf(run);
        assert.notEqual(stdout.trim(), "", `stop ${String(i)} was released while the result still fails the core check`);
        const out = JSON.parse(stdout);
        assert.equal(out.decision, "block", `stop ${String(i)}`);
    }
});
void test("contract: a forged session pin does not release an unattended run's stop", { skip: skipWithout(subjectJson().result, "result") }, () => {
    const run = newRun("unattended");
    const file = (subjectJson().result?.file ?? "")
        .replaceAll("{ticket_number}", "1")
        .replaceAll("{run_id}", run.env.GUARD_RUN_ID ?? "");
    mkdirSync(path.join(run.cwd, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(run.cwd, file), JSON.stringify({ run_id: run.env.GUARD_RUN_ID }));
    const blocked = (label) => {
        const stdout = stopOf(run);
        assert.notEqual(stdout.trim(), "", `${label}: the stop was released`);
        assert.equal(JSON.parse(stdout).decision, "block", label);
    };
    blocked("first stop");
    // guard's data dir is writable by the agent: break the session pin, with another sha256 in it
    const sessions = path.join(run.env.CLAUDE_PLUGIN_DATA ?? "", "sessions");
    const pin = path.join(sessions, `${run.session}.run.jsonl`);
    writeFileSync(pin, `${JSON.stringify({ manifest: "x", sha256: "0".repeat(64), run_id: "x", mode: "attended", ticket: "x" })}\n`);
    for (let i = 1; i <= 4; i++)
        blocked(`stop ${String(i)} after the forgery`);
});
void test("contract: legacy run variables without a registration trip the legacy-only tripwire", () => {
    scenarioCount += 1;
    const legacy = path.join(scratch("legacy"), "events.jsonl");
    const run = newRun();
    const env = {
        GUARD_OTEL: "off",
        GUARD_STOP_CHECK: "off",
        CLAUDE_PLUGIN_DATA: scratch("data"),
        FACTORY_RUN_ID: "x",
        FACTORY_EVENTS_FILE: legacy,
    };
    const call = () => {
        const r = spawnSync(process.execPath, [GUARD], {
            input: JSON.stringify({
                hook_event_name: "PreToolUse",
                session_id: run.session,
                cwd: run.cwd,
                tool_name: "Bash",
                tool_input: { command: "ls" },
            }),
            encoding: "utf8",
            timeout: 30000,
            env: { ...cleanEnv(), ...env },
        });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout;
    };
    for (let i = 0; i < 2; i++) {
        const out = JSON.parse(call());
        assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
    }
    const lines = eventLines(legacy);
    assert.equal(lines.length, 1, "one tripwire line per session");
    assert.deepEqual(Object.keys(lines[0] ?? {}), [
        "ts",
        "event",
        "decision",
        "rule",
        "reason",
    ]);
    assert.equal(lines[0]?.rule, UNREGISTERED_RULE);
});
