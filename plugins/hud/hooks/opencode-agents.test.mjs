import { test } from "node:test";
import assert from "node:assert/strict";
import { createChildren } from "./opencode-agents.mjs";
const session = (type, id, parentID, agent) => ({
    type,
    properties: { info: { id, ...(parentID && { parentID }), agent } },
});
let n = 0;
const message = (sessionID, role, extra = {}) => ({
    type: "message.updated",
    properties: {
        info: {
            id: `msg_${String(n++)}`,
            sessionID,
            role,
            agent: "scout",
            ...extra,
        },
    },
});
const status = (sessionID, type) => ({
    type: "session.status",
    properties: { sessionID, status: { type } },
});
void test("createChildren: each busy child session of a session with its agent, model and variant", () => {
    const kids = createChildren();
    const seen = (e) => kids.on(e);
    assert.equal(seen(session("session.created", "ses_p", undefined, "build")), false);
    assert.equal(seen(message("ses_p", "assistant", {
        modelID: "mock",
        providerID: "mock",
        agent: "build",
    })), false);
    assert.equal(seen(session("session.created", "ses_a", "ses_p", "scout")), true);
    assert.equal(kids.parts("ses_p"), "[ scout]");
    seen(message("ses_a", "user"));
    seen(status("ses_a", "busy"));
    seen(message("ses_a", "assistant", {
        modelID: "claude-haiku-5-5",
        providerID: "anthropic",
        variant: "low",
    }));
    seen(session("session.created", "ses_b", "ses_p", "escalate"));
    seen(message("ses_b", "assistant", {
        modelID: "gpt-6",
        providerID: "openai",
        agent: "escalate",
    }));
    assert.equal(kids.parts("ses_p"), "[ scout · claude-haiku-5-5 · low] [ escalate · gpt-6]");
    assert.equal(kids.parts("ses_a"), "");
    seen(message("ses_a", "assistant", {
        modelID: "claude-haiku-5-5",
        providerID: "anthropic",
    }));
    assert.equal(seen(status("ses_a", "idle")), true);
    assert.equal(kids.parts("ses_p"), "[ escalate · gpt-6]");
    seen(status("ses_a", "busy"));
    seen(session("session.updated", "ses_a", "ses_p", "scout"));
    assert.equal(kids.parts("ses_p"), "[ scout · claude-haiku-5-5 · low] [ escalate · gpt-6]");
    assert.equal(seen({
        type: "session.deleted",
        properties: { info: { id: "ses_b", parentID: "ses_p" } },
    }), true);
    assert.equal(kids.parts("ses_p"), "[ scout · claude-haiku-5-5 · low]");
    assert.equal(seen(status("ses_x", "busy")), false);
    assert.equal(seen({}), false);
    assert.equal(seen(undefined), false);
});
