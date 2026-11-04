// The result gate's own check. Names start with `result check:` so CI can select them on every OS.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { checkerOutput, checkerPathError, coreErrors, couldNotRun, report, show, } from "./result.mjs";
const good = { run_id: "run-1", ticket: "acme/app#12", end_state: "done" };
void test("result check: a valid core passes, each field is named when wrong", () => {
    assert.deepEqual(coreErrors(good, {}), []);
    assert.match(coreErrors({ ...good, run_id: "" })[0] ?? "", /^run_id must be a non-empty string, got ""/);
    assert.match(coreErrors({ ...good, ticket: 12 })[0] ?? "", /^ticket must be a string of the form "<owner>\/<repo>#<number>", got 12/);
    assert.match(coreErrors({ ...good, ticket: "acme/app#0" })[0] ?? "", /^ticket must be a string/);
    assert.match(coreErrors({ ...good, end_state: " " })[0] ?? "", /^end_state must be a non-empty string/);
    assert.equal(coreErrors({}).length, 3);
});
void test("result check: the run id and ticket must equal the environment's", () => {
    const env = { GUARD_RUN_ID: " run-2 ", GUARD_RUN_TICKET: "acme/app#13" };
    assert.deepEqual(coreErrors(good, env), [
        'run_id "run-1" differs from GUARD_RUN_ID "run-2"',
        'ticket "acme/app#12" differs from GUARD_RUN_TICKET "acme/app#13"',
    ]);
    assert.deepEqual(coreErrors(good, { GUARD_RUN_ID: "  " }), []);
});
void test("result check: anything but an object is one error", () => {
    for (const v of [null, [], "x", 3, undefined]) {
        const errors = coreErrors(v, {});
        assert.equal(errors.length, 1);
        assert.match(errors[0] ?? "", /^result\.json must hold a JSON object, got /);
    }
});
void test("result check: show and report cap what they echo", () => {
    assert.equal(show(undefined), "undefined");
    assert.equal(show("a"), '"a"');
    assert.equal(show(() => 1), "() => 1");
    assert.equal(show("x".repeat(500)).length, 201);
    assert.ok(show("x".repeat(500)).endsWith("…"));
    assert.deepEqual(report(["a"]), ["a"]);
    const lines = report(Array.from({ length: 53 }, () => "y".repeat(400)));
    assert.equal(lines.length, 51);
    assert.equal(lines[0]?.length, 301);
    assert.equal(lines[50], "… and 3 more");
});
void test("result check: a checker path must be an absolute .mjs file path (posix)", () => {
    const p = path.posix;
    assert.equal(checkerPathError("/opt/c/check.mjs", p), null);
    assert.equal(checkerPathError("/opt/c/CHECK.MJS", p), null);
    assert.equal(checkerPathError("", p), "empty");
    assert.match(checkerPathError("/a\0b.mjs", p) ?? "", /NUL/);
    for (const v of [
        "file:///x.mjs",
        "data:text/javascript,export default 1",
        "node:fs",
        "https://x/c.mjs",
        "HTTP://x/c.mjs",
    ]) {
        assert.match(checkerPathError(v, p) ?? "", /URL or module specifier/, v);
    }
    assert.equal(checkerPathError("c/check.mjs", p), "not an absolute path");
    assert.equal(checkerPathError("./check.mjs", p), "not an absolute path");
    assert.equal(checkerPathError("/opt/check.js", p), "not a .mjs file");
    assert.equal(checkerPathError("/opt/check", p), "not a .mjs file");
});
void test("result check: a Windows checker path is a drive or UNC path, nothing relative or device", () => {
    const w = path.win32;
    assert.equal(checkerPathError("C:\\a\\c.mjs", w), null);
    assert.equal(checkerPathError("c:/a/c.mjs", w), null);
    assert.equal(checkerPathError("\\\\srv\\share\\c.mjs", w), null);
    for (const v of [
        "C:a\\c.mjs",
        "\\a\\c.mjs",
        "\\\\?\\C:\\c.mjs",
        "\\\\.\\c.mjs",
        "a\\c.mjs",
    ]) {
        assert.equal(checkerPathError(v, w), "not an absolute path", v);
    }
    assert.equal(checkerPathError("C:\\a\\c.js", w), "not a .mjs file");
    assert.match(checkerPathError("file:///C:/c.mjs", w) ?? "", /URL/);
});
void test("result check: a checker's output is bounded", () => {
    assert.deepEqual(checkerOutput(["a", "b"]), { errors: ["a", "b"] });
    assert.deepEqual(checkerOutput([]), { errors: [] });
    assert.deepEqual(checkerOutput("x"), {
        why: 'returned "x", not an array of strings',
    });
    assert.match(checkerOutput(["a", 1]).why, /not an array of strings/);
    const big = checkerOutput(Array.from({ length: 80 }, () => "e"));
    assert.equal(big.errors.length, 51);
});
void test("result check: could-not-run prints the path raw, cut and without control characters", () => {
    assert.deepEqual(couldNotRun("/x/c.mjs", "no such file"), [
        "result checker /x/c.mjs (result.checker) could not run: no such file",
    ]);
    assert.deepEqual(couldNotRun("C:\\x\\c.mjs", "no such file"), [
        "result checker C:\\x\\c.mjs (result.checker) could not run: no such file",
    ]);
    const cut = couldNotRun(`/${"a".repeat(300)}`, "x")[0] ?? "";
    assert.ok(cut.includes(`${"a".repeat(199)}… (`));
    assert.ok(!cut.includes("a".repeat(201)));
    assert.equal(couldNotRun("/a\n\u001b[31m\0b\u007f", "x")[0], "result checker /a??[31m?b? (result.checker) could not run: x");
});
