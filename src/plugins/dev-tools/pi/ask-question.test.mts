import assert from "node:assert/strict";
import test from "node:test";
import { registerAskQuestionTool } from "./ask-question.mjs";
import type {
  AskQuestionContext,
  AskQuestionToolDefinition,
  PiHost,
} from "./types.mjs";

function setupTool(): AskQuestionToolDefinition {
  let registeredTool: AskQuestionToolDefinition | undefined;
  const pi: PiHost = {
    registerTool: (t) => {
      if (t.name === "ask_question") {
        registeredTool = t as AskQuestionToolDefinition;
      }
    },
  };
  registerAskQuestionTool(pi);
  assert.ok(registeredTool, "Tool should be registered");
  return registeredTool;
}

const withCleanEnv = async (fn: () => Promise<void>) => {
  const orig = process.env.GUARD_UNATTENDED;
  delete process.env.GUARD_UNATTENDED;
  try {
    await fn();
  } finally {
    if (orig !== undefined) process.env.GUARD_UNATTENDED = orig;
  }
};

void test("interactive input call returns answer", async () => {
  await withCleanEnv(async () => {
    const tool = setupTool();
    const ctx: AskQuestionContext = {
      hasUI: true,
      ui: {
        input: async (q) => {
          await Promise.resolve();
          return `Answer to: ${q}`;
        },
      },
    };
    const res = await tool.execute(
      "1",
      { question: "What is your name?" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(res.content[0]?.text, "Answer to: What is your name?");
  });
});

void test("interactive select call returns chosen option", async () => {
  await withCleanEnv(async () => {
    const tool = setupTool();
    const ctx: AskQuestionContext = {
      hasUI: true,
      ui: {
        select: async (_q, options) => {
          await Promise.resolve();
          return options[0];
        },
      },
    };
    const res = await tool.execute(
      "2",
      { options: ["Option A", "Option B"], question: "Choose an option" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(res.content[0]?.text, "Option A");
  });
});

void test("timeout/cancelled dialog returns 'No answer' message", async () => {
  await withCleanEnv(async () => {
    const tool = setupTool();
    const ctx: AskQuestionContext = {
      hasUI: true,
      ui: {
        input: async () => {
          await Promise.resolve();
          return undefined;
        },
      },
    };
    const res = await tool.execute(
      "3",
      { question: "Will you answer?" },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      res.content[0]?.text ?? "",
      /No answer: nobody answered within 60s/,
    );
  });
});

void test("GUARD_UNATTENDED=1 returns immediate unattended response without invoking ctx.ui", async () => {
  const tool = setupTool();
  let uiCalled = false;
  const ctx: AskQuestionContext = {
    hasUI: true,
    ui: {
      input: async () => {
        await Promise.resolve();
        uiCalled = true;
        return "Should not be called";
      },
    },
  };
  const orig = process.env.GUARD_UNATTENDED;
  try {
    process.env.GUARD_UNATTENDED = "1";
    const res = await tool.execute(
      "4",
      { question: "Hello?" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(uiCalled, false);
    assert.match(
      res.content[0]?.text ?? "",
      /Unattended run \(GUARD_UNATTENDED\)/,
    );
  } finally {
    if (orig === undefined) delete process.env.GUARD_UNATTENDED;
    else process.env.GUARD_UNATTENDED = orig;
  }
});

void test("ctx.hasUI = false returns immediate no-UI response", async () => {
  const tool = setupTool();
  let uiCalled = false;
  const ctx: AskQuestionContext = {
    hasUI: false,
    ui: {
      input: async () => {
        await Promise.resolve();
        uiCalled = true;
        return "Should not be called";
      },
    },
  };
  const res = await tool.execute(
    "5",
    { question: "Hello?" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(uiCalled, false);
  assert.match(res.content[0]?.text ?? "", /No UI/);
});
