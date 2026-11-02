import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stop, turnFacts } from "./codex.mjs";
// Lines in the shape Codex 0.162 writes to its rollout.
const ev = (payload) => JSON.stringify({ type: "event_msg", payload });
const rollout = (turnId, startedAt, tokens, extra = []) => [
    ev({ type: "task_started", turn_id: "old", started_at: 1 }),
    ev({ type: "error", message: "earlier turn" }),
    ev({ type: "task_started", turn_id: turnId, started_at: startedAt }),
    ...extra,
    ev({
        type: "token_count",
        info: {
            last_token_usage: { total_tokens: tokens },
            model_context_window: 1000,
        },
    }),
    "not json",
];
void test("turnFacts: the turn start, its errors only, and the last context use", () => {
    assert.deepEqual(turnFacts(rollout("t1", 100, 850), "t1"), {
        startedMs: 100_000,
        error: false,
        pct: 85,
    });
    assert.equal(turnFacts(rollout("t1", 100, 10, [ev({ type: "error", message: "boom" })]), "t1").error, true);
});
void test("stop: plays done and the context alert once per level, notices as systemMessage", () => {
    const lines = rollout("t1", 100, 850).join("\n");
    const played = [];
    const opts = {
        dataDir: mkdtempSync(join(tmpdir(), "sounds-codex-")),
        play: (clip) => {
            played.push(clip);
        },
        read: (filePath) => filePath === "rollout" ? lines : readFileSync(filePath, "utf8"),
    };
    const payload = {
        session_id: "s1",
        turn_id: "t1",
        transcript_path: "rollout",
    };
    assert.deepEqual(stop(payload, { ...opts, now: 190_000 }), {
        systemMessage: "Turn finished in 1m 30s · Context 85%: compact soon",
    });
    assert.deepEqual(played, ["done", "alert"]);
    played.length = 0;
    assert.deepEqual(stop(payload, { ...opts, now: 101_000 }), {});
    assert.deepEqual(played, ["done"]);
});
