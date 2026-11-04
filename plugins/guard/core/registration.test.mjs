// The run contract v2 registration schema. Names start with `registration:`.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { MAX_MANIFEST_BYTES, parseRegistration as parseNative, resultFile, runEnvErrors, sessionAttrs, UNREGISTERED_REASON, unregisteredLine, validateRegistration as validateNative, } from "./registration.mjs";
// The fixtures use POSIX checker paths: on Windows the default path rules are win32, so the tests pin POSIX unless a
// case passes path.win32.
const validateRegistration = (v, limits, api = path.posix) => validateNative(v, limits, api);
const parseRegistration = (b) => parseNative(b, undefined, path.posix);
const full = () => ({
    contract: 2,
    runner: "acme-runner",
    requires: [
        "events",
        "gh-visibility",
        "labels",
        "modes",
        "protected-paths",
        "result-gate",
    ],
    labels: {
        approval: "approved",
        takeover: "human",
        protected: ["secure", "pii"],
    },
    protected_paths: { globs: [".acme/**"], exempt: [".acme/runs/*/*/**"] },
    result: {
        file: ".acme/runs/{ticket_number}/result.json",
        checker: "/opt/acme/check.mjs",
        hint: "Write the result file.",
    },
    modes: ["attended", "unattended"],
});
const mod = (f) => {
    const m = full();
    f(m);
    return m;
};
const errs = (v, limits, api) => {
    const r = validateRegistration(v, limits, api);
    assert.equal(r.ok, false);
    return "errors" in r ? r.errors : [];
};
const has = (list, re) => {
    assert.ok(list.some((e) => re.test(e)), `${re.source} not in ${JSON.stringify(list)}`);
};
const bad = (f, re) => {
    has(errs(mod(f)), re);
};
void test("registration: a valid full manifest passes and is copied", () => {
    const input = full();
    const r = validateRegistration(input);
    assert.equal(r.ok, true);
    assert.ok("registration" in r);
    const got = r.registration;
    assert.deepEqual({ ...got }, input);
    assert.notEqual(got, input);
    assert.notEqual(got.requires, input.requires);
    assert.notEqual(got.protected_paths?.globs, input.protected_paths.globs);
    assert.notEqual(got.labels?.protected, input.labels.protected);
    assert.notEqual(got.modes, input.modes);
    assert.notEqual(got.result, input.result);
    const min = validateRegistration({ contract: 2, runner: "a", requires: [] });
    assert.equal(min.ok, true);
});
void test("registration: not an object, unknown keys", () => {
    for (const v of [null, [], "x", 2, undefined]) {
        has(errs(v), /^manifest must be a JSON object, got /);
    }
    bad((m) => (m.extra = 1), /^unknown key "extra"/);
    has(errs(JSON.parse('{"__proto__":1,"contract":2,"runner":"a","requires":[]}')), /^unknown key "__proto__"/);
    bad((m) => (m.labels.x = 1), /^labels: unknown key "x"/);
    bad((m) => (m.protected_paths.x = 1), /^protected_paths: unknown key "x"/);
    bad((m) => (m.result.x = 1), /^result: unknown key "x"/);
});
void test("registration: contract, runner", () => {
    for (const c of ["2", 2.5, 3, 1, undefined]) {
        bad((m) => (m.contract = c), /^contract must be 2 \(this guard speaks run contract 2\), got /);
    }
    for (const r of ["Acme", "", "a_b", "a".repeat(41), 3, undefined]) {
        bad((m) => (m.runner = r), /^runner must match /);
    }
});
void test("registration: requires", () => {
    bad((m) => (m.requires = ["nope"]), /^requires: unknown capability "nope"/);
    bad((m) => (m.requires = ["events", "events"]), /^requires: duplicate entry "events"/);
    bad((m) => (m.requires = Array.from({ length: 17 }, (_, i) => `c${String(i)}`)), /^requires must have at most 16 entries/);
    bad((m) => (m.requires = "events"), /^requires must be an array/);
    bad((m) => delete m.requires, /^requires must be an array/);
    bad((m) => (m.requires = [1]), /^requires\[0\] must be a string/);
});
void test("registration: labels", () => {
    bad((m) => (m.labels.approval = "a b"), /^labels\.approval must match /);
    bad((m) => (m.labels.takeover = 1), /^labels\.takeover must match /);
    bad((m) => (m.labels.protected = ["a", "a"]), /^labels\.protected: duplicate entry "a"/);
    bad((m) => (m.labels.protected = ["a b"]), /^labels\.protected\[0\] must match /);
    bad((m) => (m.labels.protected = Array.from({ length: 33 }, (_, i) => `l${String(i)}`)), /^labels\.protected must have at most 32/);
    bad((m) => (m.labels = []), /^labels must be an object/);
});
void test("registration: protected_paths globs", () => {
    const g = (glob, re) => {
        bad((m) => (m.protected_paths.globs = [glob]), re);
    };
    g("", /^protected_paths\.globs\[0\] must be 1 to 1024 characters/);
    g("a".repeat(1025), /must be 1 to 1024 characters/);
    g("a\nb", /must not contain control characters/);
    g("a\u007f", /must not contain control characters/);
    g("a\\b", /must not contain a backslash/);
    g("/abs", /must not be absolute/);
    g("C:foo", /must not be absolute/);
    g("a//b", /empty, "\." or "\.\." segment/);
    g("a/", /empty, "\." or "\.\." segment/);
    g("./a", /empty, "\." or "\.\." segment/);
    g("a/../b", /empty, "\." or "\.\." segment/);
    g("a/.. /b", /empty, "\." or "\.\." segment/);
    g("a/.../b", /empty, "\." or "\.\." segment/);
    g("a/b::$DATA", /must not contain ":"/);
    g(1, /^protected_paths\.globs\[0\] must be a string/);
    bad((m) => (m.protected_paths.globs = "x"), /^protected_paths\.globs must be an array/);
    bad((m) => (m.protected_paths = null), /^protected_paths must be an object/);
});
void test("registration: protected_paths limits", () => {
    const limits = { chars: 5, globs: 2, ms: 1, targets: 1 };
    const m = {
        contract: 2,
        runner: "a",
        requires: ["protected-paths"],
        protected_paths: { globs: ["a", "b"], exempt: ["a/x"] },
    };
    has(errs(m, limits), /^protected_paths must have at most 2 globs and exempt entries together, got 3/);
    const long = { ...m, protected_paths: { globs: ["abcdef"] } };
    has(errs(long, limits), /^protected_paths\.globs\[0\] must be 1 to 5 characters/);
});
void test("registration: protected_paths exempt", () => {
    const e = (x, globs = [".acme/**"]) => errs(mod((m) => (m.protected_paths = { globs, exempt: [x] })));
    const re = /^protected_paths\.exempt\[0\]: may only narrow this registration's own globs, never the built-in floor, got /;
    has(e(".GITHUB/**", [".GITHUB/**"]), re);
    has(e(".github/x", [".github/**"]), re);
    has(e("**"), re);
    has(e("*/x"), re);
    has(e("{a,b}/x"), re);
    has(e("other/x"), re);
    has(e("!x"), re);
    // Only .github is the built-in floor: a runner's own directory is its registration's to protect and to exempt.
    assert.equal(validateRegistration(mod((m) => (m.protected_paths = {
        globs: [".factory/**"],
        exempt: [".factory/runs/*/*/**"],
    }))).ok, true);
    assert.equal(validateRegistration(mod((m) => (m.protected_paths = { globs: [".acme/**"], exempt: [".acme/x"] }))).ok, true);
});
void test("registration: result", () => {
    const f = (file, re) => {
        bad((m) => (m.result.file = file), re);
    };
    f(undefined, /^result\.file must be a string/);
    f("", /^result\.file must be 1 to 1024/);
    f("/x.json", /^result\.file must not be absolute/);
    f("../x.json", /^result\.file must not have an empty/);
    f("a\\b.json", /^result\.file must not contain a backslash/);
    f("a/*.json", /^result\.file must not contain glob characters/);
    f("a/?.json", /glob characters/);
    f("a/[x].json", /glob characters/);
    f("a/!.json", /glob characters/);
    f("a/{other}.json", /^result\.file may only use the placeholders/);
    f("a/{run_id.json", /^result\.file may only use the placeholders/);
    f("a/result.txt", /^result\.file must end with \.json/);
    bad((m) => (m.result = 1), /^result must be an object/);
    const c = (checker, re, api) => {
        has(errs(mod((m) => (m.result.checker = checker)), undefined, api), re);
    };
    c("rel/check.mjs", /^result\.checker: not an absolute path/);
    c("/opt/check.js", /^result\.checker: not a \.mjs file/);
    c("file:///opt/check.mjs", /^result\.checker: a URL or module specifier/);
    c(" /opt/check.mjs", /^result\.checker must not have leading or trailing whitespace/);
    c(7, /^result\.checker must be a string/);
    c("/opt/check.mjs", /^result\.checker: not an absolute path/, path.win32);
    assert.equal(validateRegistration(mod((m) => (m.result.checker = "C:\\opt\\check.mjs")), undefined, path.win32).ok, true);
    bad((m) => (m.result.hint = ""), /^result\.hint must be 1 to 500/);
    bad((m) => (m.result.hint = "x".repeat(501)), /^result\.hint must be 1 to 500/);
    bad((m) => (m.result.hint = "a\tb"), /^result\.hint must be 1 to 500/);
    bad((m) => (m.result.hint = "a\u202eb"), /^result\.hint must be 1 to 500/);
    bad((m) => (m.result.hint = "a\u2028b"), /^result\.hint must be 1 to 500/);
    bad((m) => (m.result.hint = "a\u0085b"), /^result\.hint must be 1 to 500/);
    bad((m) => (m.result.file = ".{run_id}/workflows/r.json"), /^result\.file must not use a placeholder in the first segment of a multi-segment path, got /);
    bad((m) => (m.result.file = "{run_id}/x.json"), /^result\.file must not use a placeholder in the first segment/);
    for (const file of ["{run_id}.json", "{ticket_number}.json"]) {
        const r = validateRegistration(mod((m) => (m.result.file = file)));
        assert.equal(r.ok, true, file);
    }
    for (const file of [
        ".git./x.json",
        ".git /x.json",
        ".GIT../x.json",
        "a/.git/x.json",
        "a/b/.github/x.json",
        "a/.github ./x.json",
    ]) {
        bad((m) => (m.result.file = file), /^result\.file must not be under \.git or \.github, got /);
    }
    for (const file of ["GIT~1/x.json", "a/github~2/x.json"]) {
        bad((m) => (m.result.file = file), /^result\.file must not be under \.git or \.github, got /);
    }
    for (const file of [".git::$INDEX_ALLOCATION/x.json", "x.json::$DATA"]) {
        bad((m) => (m.result.file = file), /^result\.file must not contain ":"/);
    }
    for (const file of ["a/.. /x.json", "a/.../x.json", "... /x.json"]) {
        bad((m) => (m.result.file = file), /^result\.file must not have an empty/);
    }
    for (const file of [
        "a/.gitx/x.json",
        ".gitignore.json",
        "a/git/x.json",
        "a/git~x/x.json",
        "a/b.c/x.json",
    ]) {
        const r = validateRegistration(mod((m) => (m.result.file = file)));
        assert.equal(r.ok, true, file);
    }
    for (const file of [".git/x.json", ".GITHUB/r.json"]) {
        bad((m) => (m.result.file = file), /^result\.file must not be under \.git or \.github, got /);
    }
});
void test("registration: modes", () => {
    bad((m) => (m.modes = []), /^modes must have 1 to 2 entries/);
    bad((m) => (m.modes = ["attended", "unattended", "attended"]), /^modes must have 1 to 2 entries/);
    bad((m) => (m.modes = ["x"]), /^modes: unknown mode "x"/);
    bad((m) => (m.modes = ["attended", "attended"]), /^modes: duplicate entry "attended"/);
    bad((m) => (m.modes = "attended"), /^modes must be an array/);
});
void test("registration: cross-checks between sections and requires", () => {
    for (const [key, cap] of [
        ["labels", "labels"],
        ["protected_paths", "protected-paths"],
        ["result", "result-gate"],
        ["modes", "modes"],
    ]) {
        bad((m) => (m.requires = m.requires.filter((c) => c !== cap)), new RegExp(`^${key} is set but requires does not list "${cap}"`));
    }
    bad((m) => delete m.result, /^requires lists "result-gate" but result is not set/);
    assert.equal(validateRegistration({ contract: 2, runner: "a", requires: ["events"] }).ok, true);
});
void test("registration: validate never throws and collects every error", () => {
    const hostile = new Proxy({}, {
        ownKeys: () => {
            throw new Error("boom");
        },
    });
    has(errs(hostile), /^cannot be checked \(boom\)/);
    assert.ok(errs({ contract: 1, runner: "X", requires: "x" }).length >= 3);
});
void test("registration: parse bytes", () => {
    const enc = (s) => new TextEncoder().encode(s);
    const one = (b) => {
        const r = parseRegistration(b);
        assert.equal(r.ok, false);
        return "errors" in r ? r.errors : [];
    };
    assert.deepEqual(one(new Uint8Array(MAX_MANIFEST_BYTES + 1)), [
        "too large (over 64 KiB)",
    ]);
    assert.deepEqual(one(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), [
        "starts with a byte order mark",
    ]);
    assert.deepEqual(one(new Uint8Array([0x7b, 0xff, 0x7d])), [
        "not valid UTF-8",
    ]);
    const j = one(enc("{nope"));
    assert.match(j[0] ?? "", /^not valid JSON \(.{1,100}\)$/);
    has(one(enc("[]")), /^manifest must be a JSON object/);
    const ok = parseRegistration(enc(JSON.stringify(full())));
    assert.equal(ok.ok, true);
});
void test("registration: resultFile checks only the variables its template uses", () => {
    assert.deepEqual(resultFile(".acme/runs/{run_id}.json", { run_id: "run-1" }), {
        path: ".acme/runs/run-1.json",
    });
    assert.deepEqual(resultFile(".acme/result.json", { run_id: "" }), {
        path: ".acme/result.json",
    });
    const r = resultFile(".acme/{ticket_number}.json", { run_id: "run-1" });
    assert.ok("why" in r && r.why.startsWith("ticket number must match"));
});
void test("registration: resultFile expands and checks", () => {
    const vars = { run_id: "run-1", ticket_number: "12" };
    assert.deepEqual(resultFile(".acme/{ticket_number}/{run_id}/{run_id}.json", vars), {
        path: ".acme/12/run-1/run-1.json",
    });
    const why = (v, t = "{run_id}/{ticket_number}.json") => {
        const r = resultFile(t, v);
        assert.ok("why" in r, JSON.stringify(r));
        return "why" in r ? r.why : "";
    };
    assert.match(why({ run_id: "github", ticket_number: "1" }, ".{run_id}/r.json"), /^result file must not be under \.git or \.github, got /);
    assert.match(why({ run_id: "r", ticket_number: "0" }), /^ticket number must match/);
    assert.match(why({ run_id: "r", ticket_number: "01" }), /^ticket number must match/);
    assert.match(why({ run_id: "r", ticket_number: "12345678901" }), /^ticket number must match/);
    assert.match(why({ run_id: "..", ticket_number: "1" }), /^run id must match/);
    assert.match(why({ run_id: "a/b", ticket_number: "1" }), /^run id must match/);
    assert.match(why(vars, "../{run_id}.json"), /^result file /);
    assert.match(why(vars, "/{run_id}.json"), /^result file /);
});
void test("registration: runEnvErrors", () => {
    const reg = validateRegistration(full())
        .registration;
    const base = { GUARD_RUN_ID: "run-1", GUARD_RUN_TICKET: "acme/app#12" };
    assert.deepEqual(runEnvErrors(base, reg), []);
    has(runEnvErrors({ ...base, GUARD_RUN_ID: "  run-1  " }, reg), /^GUARD_RUN_ID must match/);
    has(runEnvErrors({ ...base, GUARD_RUN_ID: "../x" }, reg), /^GUARD_RUN_ID must match .*, got "\.\.\/x"/);
    has(runEnvErrors({ GUARD_RUN_TICKET: base.GUARD_RUN_TICKET }, reg), /^GUARD_RUN_ID must match/);
    const only = { ...reg, modes: ["attended"] };
    has(runEnvErrors(base, only), /^GUARD_RUN_MODE "unattended" is not one of the registration's modes \["attended"\]/);
    has(runEnvErrors({ ...base, GUARD_RUN_MODE: " attended " }, only), /^GUARD_RUN_MODE " attended " is not one of/);
    assert.deepEqual(runEnvErrors({ ...base, GUARD_RUN_MODE: "attended" }, only), []);
    has(runEnvErrors({ ...base, GUARD_RUN_MODE: "x" }, reg), /^GUARD_RUN_MODE "x" is not one of/);
    assert.deepEqual(runEnvErrors({ ...base, GUARD_RUN_MODE: "" }, { ...reg, modes: undefined }), []);
    has(runEnvErrors({ ...base, GUARD_RUN_TICKET: "bad" }, reg), /^GUARD_RUN_TICKET must match/);
    has(runEnvErrors({ GUARD_RUN_ID: "r" }, reg), /^GUARD_RUN_TICKET is required by result\.file/);
    has(runEnvErrors({ ...base, GUARD_RUN_MODE: "" }, only), /^GUARD_RUN_MODE "unattended" is not one of/);
    assert.deepEqual(runEnvErrors({ ...base, GUARD_RUN_MODE: "" }, { ...reg, modes: ["unattended"] }), []);
    const emptyTicket = runEnvErrors({ GUARD_RUN_ID: "r", GUARD_RUN_TICKET: "" }, reg);
    assert.equal(emptyTicket.length, 1);
    has(emptyTicket, /^GUARD_RUN_TICKET is required by result\.file/);
    const noTicket = { ...reg, result: { file: "x/result.json" } };
    assert.deepEqual(runEnvErrors({ GUARD_RUN_ID: "r", GUARD_RUN_TICKET: "" }, noTicket), []);
    assert.deepEqual(runEnvErrors({ GUARD_RUN_ID: "r" }, noTicket), []);
    assert.deepEqual(runEnvErrors({ GUARD_RUN_ID: "r" }, { ...reg, result: undefined }), []);
});
void test("registration: unregisteredLine has exactly the documented keys", () => {
    const line = JSON.parse(unregisteredLine("2026-01-01T00:00:00.000Z"));
    assert.deepEqual(line, {
        ts: "2026-01-01T00:00:00.000Z",
        event: "run-unregistered",
        decision: "deny",
        rule: "run-unregistered",
        reason: UNREGISTERED_REASON,
    });
    assert.ok(!unregisteredLine().endsWith("\n"));
    assert.match(JSON.parse(unregisteredLine()).ts, /^\d{4}-\d\d-\d\dT/);
});
void test("registration: sessionAttrs", () => {
    assert.deepEqual(sessionAttrs(null), { "run.registered": false });
    const registration = validateRegistration(full()).registration;
    const sha256 = "0123456789abcdef".repeat(4);
    assert.deepEqual(sessionAttrs({ registration, sha256 }), {
        "run.registered": true,
        "runner.name": "acme-runner",
        "runner.contract": 2,
        "runner.manifest_sha16": "0123456789abcdef",
    });
    for (const s of ["ABCDEF".repeat(11), "abc", ""]) {
        assert.deepEqual(sessionAttrs({ registration, sha256: s }), {
            "run.registered": true,
            "runner.name": "acme-runner",
            "runner.contract": 2,
        });
    }
});
