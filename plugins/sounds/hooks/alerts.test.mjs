import assert from "node:assert/strict";
import { test } from "node:test";
import { alerts, ciNotice, clock, turnNotice, turnSound } from "./alerts.mjs";
void test("alerts: each level is announced once, per context and per limit, and re-arms after it is left", () => {
    const first = alerts(82, { five_hour: 10 });
    assert.deepEqual(first.alerts, [
        { key: "soundContext", text: "Context 82%: compact soon" },
    ]);
    assert.deepEqual(alerts(84, { five_hour: 10 }, first.now).alerts, []);
    const second = alerts(93, { five_hour: 95, seven_day: 81, spend_limit: 100 }, first.now);
    assert.deepEqual(second.alerts, [
        { key: "soundContext", text: "Context 93%: compact now" },
        { key: "soundLimit5h", text: "5h window 95% used" },
        { key: "soundLimit7d", text: "7d window 81% used" },
        { key: "soundLimitSpend", text: "Spend limit reached" },
    ]);
    assert.deepEqual(alerts(20, { five_hour: 95 }, second.now).alerts, []);
    assert.deepEqual(alerts(85, {}, alerts(20, {}, second.now).now).alerts, [
        { key: "soundContext", text: "Context 85%: compact soon" },
    ]);
});
void test("turnSound: one setting per way a turn can end", () => {
    assert.equal(turnSound({ reason: "answer", durationMs: 5000 }, 0), "soundDone");
    assert.equal(turnSound({ reason: "answer", durationMs: 5000 }, 30), null);
    assert.equal(turnSound({ reason: "answer", durationMs: 31_000 }, 30), "soundDone");
    assert.equal(turnSound({ reason: "aborted", durationMs: 1 }), "soundAborted");
    assert.equal(turnSound({ reason: "refusal", durationMs: 1 }), "soundRefused");
    assert.equal(turnSound({ reason: "error", durationMs: 1 }), "soundError");
    assert.equal(turnSound({ reason: "answer", durationMs: 1, agentId: "a1" }), "soundSubagent");
});
void test("clock: minutes and seconds", () => {
    assert.equal(clock(65_000), "1:05");
});
void test("turnNotice: long answers and bad endings, never an interrupt or a subagent", () => {
    assert.equal(turnNotice({ reason: "answer", durationMs: 123_000 }, 60), "Turn finished in 2m 3s");
    assert.equal(turnNotice({ reason: "answer", durationMs: 5000 }, 60), null);
    assert.equal(turnNotice({ reason: "error", durationMs: 1 }), "The turn ended on an API error");
    assert.equal(turnNotice({ reason: "refusal", durationMs: 1 }), "The model refused the turn");
    assert.equal(turnNotice({ reason: "aborted", durationMs: 999_000 }), null);
    assert.equal(turnNotice({ reason: "answer", durationMs: 999_000, agentId: "a" }), null);
});
void test("ciNotice: running checks that finish on the same PR", () => {
    const state = (number, ci) => ({
        pr: { number, ci },
    });
    assert.equal(ciNotice(state(5, "pending"), state(5, "fail")), "Checks failed on #5");
    assert.equal(ciNotice(state(5, "pending"), state(5, "pass")), "Checks passed on #5");
    assert.equal(ciNotice(state(5, "pass"), state(5, "pass")), null);
    assert.equal(ciNotice(state(5, "pending"), state(6, "pass")), null);
    assert.equal(ciNotice(null, state(5, "fail")), null);
});
