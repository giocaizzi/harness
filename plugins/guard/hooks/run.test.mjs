// Run contract v3 run context: which run a hook call belongs to, the facts the shell and edit rules read and the deny
// texts. The manifest is trusted through the vet probes (the real vet needs a file out of the test
// user's reach).
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pinFile } from "./registration.mjs";
import { denyReason, runContext, runFacts, runIdentified, staleRunVars, } from "./run.mjs";
const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-run-ctx-")));
after(() => {
    rmSync(root, { recursive: true, force: true });
});
const vet = {
    writable: () => false,
    owner: () => false,
    readOnlyMount: () => false,
};
let n = 0;
const manifest = (body) => {
    const file = join(root, `m${String(n++)}.json`);
    writeFileSync(file, JSON.stringify({ contract: 3, runner: "acme-runner", ...body }));
    return file;
};
const envFor = (file, extra = {}) => ({
    AGENT_RUN_ID: "r1",
    AGENT_RUN_MANIFEST: file,
    ...extra,
});
const reg = (env) => {
    const ctx = runContext(env, { vet });
    assert.equal(ctx.state, "registered", JSON.stringify(ctx));
    return ctx;
};
const denied = (ctx) => {
    assert.equal(ctx.state, "deny", JSON.stringify(ctx));
    return ctx;
};
void test("runContext: no run variable is none, blank values included", () => {
    assert.deepEqual(runContext({}, { vet }), { state: "none" });
    assert.deepEqual(runContext({ AGENT_RUN_ID: " " }, { vet }), {
        state: "none",
    });
});
void test("runContext: a run id without a manifest (or the reverse) denies with run-registration", () => {
    for (const env of [
        { AGENT_RUN_ID: "r1" },
        { AGENT_RUN_MANIFEST: "/x/m.json" },
        { AGENT_RUN_ID: "r1", AGENT_RUN_MANIFEST: join(root, "missing.json") },
    ]) {
        const d = denied(runContext(env, { vet }));
        assert.equal(d.rule, "run-registration", JSON.stringify(env));
        assert.ok(d.why.length > 0);
    }
});
void test("runContext: a registered run carries its mode, ticket, run file and extra globs", () => {
    const file = manifest({ requires: [] });
    const plain = reg(envFor(file));
    assert.equal(plain.mode, "unattended");
    assert.equal(plain.runId, "r1");
    assert.equal(plain.ticket, undefined);
    assert.equal(plain.runFile, undefined);
    assert.deepEqual(plain.extra, []);
    assert.equal(plain.registration.runner, "acme-runner");
    assert.match(plain.sha256, /^[0-9a-f]{64}$/);
    assert.equal(plain.path, realpathSync(file));
    const full = reg(envFor(file, {
        AGENT_RUN_MODE: "attended",
        AGENT_RUN_TICKET: "acme/app#42",
        AGENT_RUN_FILE: " .acme/runs/42/result.json ",
        AGENT_RUN_PROTECTED_PATHS: " infra/** \r\n\n deploy/*.tf\n",
    }));
    assert.equal(full.mode, "attended");
    assert.equal(full.ticket, "acme/app#42");
    assert.equal(full.ticketNumber, "42");
    assert.equal(full.runFile, ".acme/runs/42/result.json");
    assert.deepEqual(full.extra, ["infra/**", "deploy/*.tf"]);
    assert.equal(reg(envFor(file, { AGENT_RUN_MODE: "" })).mode, "unattended");
});
void test("runContext: a session id and data dir pin the manifest, a changed one denies", () => {
    const dataDir = mkdtempSync(join(root, "data-"));
    const file = manifest({ requires: [] });
    const opts = { vet, dataDir, sessionId: "s1" };
    assert.equal(runContext(envFor(file), opts).state, "registered");
    writeFileSync(file, JSON.stringify({ contract: 3, runner: "acme-other", requires: [] }));
    chmodSync(file, 0o600);
    const d = denied(runContext(envFor(file), opts));
    assert.equal(d.rule, "run-registration");
    assert.match(d.why, /changed during the session/);
    assert.ok(readFileSync(pinFile(dataDir, "s1"), "utf8").includes("sha256"));
});
void test("runFacts: an attended run has none; labels and protect map from the registration", () => {
    const file = manifest({
        requires: ["labels", "protected-paths"],
        labels: {
            approval: "go-ahead",
            takeover: "hand-over",
            protected: ["acme-parked"],
        },
        protected_paths: {
            globs: ["out/**"],
            exempt: ["out/runs/*/*/**"],
        },
    });
    const attended = reg(envFor(file, { AGENT_RUN_MODE: "attended" }));
    assert.equal(runFacts(attended, { cwd: "/r", root: "/r" }), null);
    const run = reg(envFor(file, { AGENT_RUN_PROTECTED_PATHS: "infra/**" }));
    assert.deepEqual(runFacts(run, { cwd: "/r/src", root: "/r" }), {
        labels: {
            approval: "go-ahead",
            takeover: "hand-over",
            protected: ["acme-parked"],
        },
        protect: {
            cwd: "/r/src",
            root: "/r",
            registered: ["out/**"],
            exempt: ["out/runs/*/*/**"],
            extra: ["infra/**"],
        },
    });
});
void test("runFacts: a registration that requires labels but names none is unsure; one that does not require them is not", () => {
    const at = { cwd: "/r", root: "/r" };
    const unsure = runFacts(reg(envFor(manifest({ requires: ["labels"] }))), at);
    assert.ok(unsure);
    assert.equal(unsure.unsure, true);
    assert.equal(unsure.labels, undefined);
    const plain = runFacts(reg(envFor(manifest({ requires: [] }))), at);
    assert.ok(plain);
    assert.equal(plain.unsure, undefined);
    assert.equal(plain.labels, undefined);
    assert.deepEqual([plain.protect?.registered, plain.protect?.exempt], [[], []]);
    const named = runFacts(reg(envFor(manifest({ requires: ["labels"], labels: { protected: ["acme-x"] } }))), at);
    assert.ok(named);
    assert.equal(named.unsure, undefined);
    assert.deepEqual(named.labels, { protected: ["acme-x"] });
});
void test("denyReason: the texts say what to do and carry no env value", () => {
    const env = {
        AGENT_RUN_ID: "secret-run-id",
        AGENT_RUN_MANIFEST: "/very/secret/path.json",
    };
    const bad = denied(runContext(env, { vet }));
    assert.match(denyReason(bad, "tool"), /^Run registration failed: /);
    assert.match(denyReason(bad, "stop"), /^Run registration failed: .*stop and report it\.$/);
    for (const at of ["tool", "stop"]) {
        assert.match(denyReason(bad, at), /every tool call guard sees/i, at);
        assert.doesNotMatch(denyReason(bad, at), /secret-run-id/, `${bad.rule} ${at}`);
    }
});
void test("run contract 2 variables fail closed unless AGENT_RUN_* holds the same value", () => {
    for (const env of [
        { GUARD_RUN_ID: "r1" },
        { GUARD_RUN_MANIFEST: "/x/m.json" },
        { GUARD_RUN_TICKET: "o/r#1" },
        { GUARD_RUN_MODE: "attended" },
        { GUARD_RUN_FILE: "run.json" },
        { GUARD_RUN_ID: "r1", AGENT_RUN_ID: "r2" },
    ]) {
        const ctx = runContext(env);
        assert.equal(ctx.state, "deny", JSON.stringify(env));
        assert.equal(ctx.rule, "run-registration");
        assert.match(ctx.why, /run contract 2 variables are set/);
        assert.ok(runIdentified(env), JSON.stringify(env));
    }
    assert.deepEqual(staleRunVars({ GUARD_RUN_ID: "r1", GUARD_RUN_MODE: "x" }), [
        "GUARD_RUN_ID",
        "GUARD_RUN_MODE",
    ]);
    // blank old names, the same values in both, and the names contract 2 had no twin check for pass
    for (const env of [
        { GUARD_RUN_ID: " " },
        { GUARD_RUN_ID: "" },
        { GUARD_RUN_EVENTS_FILE: "/tmp/e.jsonl" },
        { GUARD_RUN_PROTECTED_PATHS: "x/**" },
    ]) {
        assert.deepEqual(runContext(env), { state: "none" }, JSON.stringify(env));
        assert.equal(runIdentified(env), false);
    }
    assert.deepEqual(staleRunVars({ GUARD_RUN_ID: "r1", AGENT_RUN_ID: "r1" }), []);
});
// A runner moving from contract 2 sets both names, as the docs allow, but misses the twin of
// GUARD_RUN_PROTECTED_PATHS or GUARD_RUN_EVENTS_FILE. The run registers, and the extra protected globs (or the events
// file its breaker counts) are dropped without a word: the silent loss the contract 2 check exists to prevent.
void test("an identified run with a contract 2 protected-paths or events-file name and no equal AGENT_RUN_* twin denies", () => {
    const file = manifest({ requires: ["protected-paths"] });
    const moving = { GUARD_RUN_ID: "r1", GUARD_RUN_MANIFEST: file };
    for (const extra of [
        { GUARD_RUN_PROTECTED_PATHS: "secrets/**" },
        { GUARD_RUN_EVENTS_FILE: join(root, "events.jsonl") },
    ]) {
        const env = envFor(file, { ...moving, ...extra });
        assert.equal(runContext(env, { vet }).state, "deny", JSON.stringify(extra));
    }
});
void test("AGENT_RUN_MANIFEST_SHA256 alone denies; the twins of an identified run pass when equal", () => {
    for (const digest of ["a".repeat(64), ""]) {
        const env = { AGENT_RUN_MANIFEST_SHA256: digest };
        const ctx = runContext(env);
        assert.equal(ctx.state, "deny", JSON.stringify(env));
        assert.match(ctx.why, /AGENT_RUN_MANIFEST_SHA256 is set but/);
        assert.ok(runIdentified(env));
    }
    const file = manifest({ requires: ["protected-paths"] });
    const events = join(root, "events.jsonl");
    const env = envFor(file, {
        GUARD_RUN_ID: "r1",
        GUARD_RUN_MANIFEST: file,
        GUARD_RUN_PROTECTED_PATHS: "secrets/**",
        AGENT_RUN_PROTECTED_PATHS: "secrets/**",
        GUARD_RUN_EVENTS_FILE: events,
        AGENT_RUN_EVENTS_FILE: events,
    });
    assert.equal(runContext(env, { vet }).state, "registered");
    // an AGENT_RUN_* identity alone makes the extras count too
    assert.deepEqual(staleRunVars({ AGENT_RUN_ID: "r1", GUARD_RUN_EVENTS_FILE: events }), ["GUARD_RUN_EVENTS_FILE"]);
});
