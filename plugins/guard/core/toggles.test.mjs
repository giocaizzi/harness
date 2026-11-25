import assert from "node:assert/strict";
import { test } from "node:test";
import { RULE_IDS, effectiveRules, parseRules, ruleOn, } from "./toggles.mjs";
const only = (...ids) => Object.fromEntries(RULE_IDS.map((id) => [id, ids.includes(id)]));
const allBut = (...ids) => Object.fromEntries(RULE_IDS.map((id) => [id, !ids.includes(id)]));
void test("the rule ids are the documented seventeen", () => {
    assert.deepEqual([...RULE_IDS], [
        "risky",
        "title",
        "python",
        "skills",
        "hints",
        "host",
        "push-scan",
        "pr-batch",
        "stack-hint",
        "stale-plugins",
        "lifecycle",
        "stop-check",
        "lint",
        "awake",
        "run-labels",
        "protected-paths",
        "result-gate",
    ]);
});
void test("parseRules: the grammar, left to right over all-on defaults", () => {
    const cases = [
        [undefined, allBut()],
        ["", allBut()],
        ["   ", allBut()],
        ["all", allBut()],
        ["none", only()],
        ["-awake,-lint", allBut("awake", "lint")],
        ["-awake -lint", allBut("awake", "lint")],
        ["-awake, -lint ,\n-host", allBut("awake", "lint", "host")],
        ["none,risky,run-labels", only("risky", "run-labels")],
        ["none +risky +title", only("risky", "title")],
        ["none,risky,-risky", only()],
        ["-risky,all", allBut()],
        ["-risky,risky", allBut()],
        [
            "none,risky,run-labels,protected-paths,result-gate",
            only("risky", "run-labels", "protected-paths", "result-gate"),
        ],
        [",,-lint,,", allBut("lint")],
    ];
    for (const [value, want] of cases) {
        const got = parseRules(value);
        assert.equal(got.invalid, undefined, String(value));
        assert.deepEqual(got.rules, want, String(value));
    }
});
void test("parseRules: an unknown or empty-after-sign token makes the whole value invalid and the defaults apply", () => {
    for (const [value, bad] of [
        ["RISKY", "RISKY"],
        ["none,Risky", "Risky"],
        ["-awake,nope", "nope"],
        ["none,risky,typo", "typo"],
        ["-", "-"],
        ["+", "+"],
        ["none +", "+"],
        ["-awake --lint", "--lint"],
        ["ALL", "ALL"],
        ["off", "off"],
    ]) {
        const got = parseRules(value);
        assert.equal(got.invalid, bad, value);
        assert.deepEqual(got.rules, allBut(), value);
    }
    assert.equal(parseRules(`-${"x".repeat(300)}`).invalid?.length, 100);
});
void test("ruleOn: GUARD_RULES decides, and each older switch still turns its rule off", () => {
    assert.equal(ruleOn({}, "risky"), true);
    assert.equal(ruleOn({ GUARD_RULES: "-risky" }, "risky"), false);
    assert.equal(ruleOn({ GUARD_RULES: "-risky" }, "title"), true);
    assert.equal(ruleOn({ GUARD_RULES: "none" }, "title"), false);
    assert.equal(ruleOn({ GUARD_RULES: "bogus,-risky" }, "risky"), true);
    const legacy = [
        ["host", "GUARD_HOST_CHECK", ["off"], ["on", "0", "OFF"]],
        ["push-scan", "GUARD_PUSH_SCAN", ["off", "0", "false", "OFF"], ["on", ""]],
        ["stack-hint", "GUARD_STACK_HINT", ["off", "0", "false"], ["on", ""]],
        ["lifecycle", "GUARD_LIFECYCLE", ["off", "0", "false"], ["on", ""]],
        ["stop-check", "GUARD_STOP_CHECK", ["off"], ["force", "on", "0"]],
        ["result-gate", "GUARD_RESULT_GATE", ["off"], ["on", "0", "OFF"]],
    ];
    for (const [id, name, offs, ons] of legacy) {
        for (const v of offs)
            assert.equal(ruleOn({ [name]: v }, id), false, `${name}=${v}`);
        for (const v of ons)
            assert.equal(ruleOn({ [name]: v }, id), true, `${name}=${v}`);
        // a legacy switch never turns on what GUARD_RULES turned off
        assert.equal(ruleOn({ GUARD_RULES: `-${id}`, [name]: "on" }, id), false, id);
    }
});
void test("ruleOn: a capability the run requires keeps its rule on whatever GUARD_RULES says, but not past an older switch", () => {
    const none = { GUARD_RULES: "none" };
    assert.equal(ruleOn(none, "run-labels"), false);
    assert.equal(ruleOn(none, "run-labels", ["labels"]), true);
    assert.equal(ruleOn(none, "protected-paths", ["protected-paths"]), true);
    assert.equal(ruleOn(none, "result-gate", ["result-gate"]), true);
    // other capabilities floor nothing, and a capability floors only its own rule
    assert.equal(ruleOn(none, "risky", [
        "labels",
        "protected-paths",
        "result-gate",
        "modes",
        "events",
    ]), false);
    assert.equal(ruleOn(none, "run-labels", ["protected-paths", "result-gate", "modes"]), false);
    assert.equal(ruleOn({ GUARD_RULES: "-run-labels" }, "run-labels", ["labels"]), true);
    // the existing switch keeps its meaning inside a run
    assert.equal(ruleOn({ GUARD_RULES: "none", GUARD_RESULT_GATE: "off" }, "result-gate", [
        "result-gate",
    ]), false);
});
void test("effectiveRules: the full map, with the floor", () => {
    assert.deepEqual(effectiveRules({}), allBut());
    assert.deepEqual(effectiveRules({ GUARD_RULES: "none", GUARD_HOST_CHECK: "off" }, [
        "labels",
        "result-gate",
    ]), only("run-labels", "result-gate"));
    assert.deepEqual(effectiveRules({ GUARD_RULES: "-host", GUARD_HOST_CHECK: "off" }), allBut("host"));
    assert.deepEqual(Object.keys(effectiveRules({})), [...RULE_IDS]);
});
