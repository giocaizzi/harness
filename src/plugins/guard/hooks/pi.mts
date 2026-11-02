// pi extension: the guard's rules on pi's extension events (docs/extensions.md in earendil-works/pi).
// Loaded from the repo's root package.json (`pi install git:github.com/giocaizzi/harness`). pi can ask, so a
// risky command gets a confirm dialog; without a UI (print or JSON mode) it is blocked.

import { createGuard } from "./bridge.mjs";
import type { GuardDeps } from "./types.mjs";

export interface PiToolCallEvent {
  input?: { command?: string };
  toolCallId: string;
  toolName: string;
}

export interface PiToolResultEvent {
  content?: { text?: string; type: string }[];
  input?: Record<string, unknown>;
  toolCallId: string;
  toolName: string;
}

export interface PiInputEvent {
  text?: string;
}

export interface PiMessageEndEvent {
  message?: {
    model?: string;
    provider?: string;
    responseModel?: string;
    role?: string;
    usage?: {
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
      input?: number;
      output?: number;
      reasoning?: number;
    };
  };
}

export interface PiAgentSettledEvent {
  aborted?: boolean;
}

export interface PiContext {
  cwd: string;
  hasUI?: boolean;
  sessionManager?: { getSessionId?: () => string };
  ui: {
    confirm: (
      title: string,
      message?: string,
      options?: { signal?: AbortSignal; timeout?: number },
    ) => Promise<boolean | undefined>;
    notify: (message: string, level?: string) => void;
  };
}

export interface PiApp {
  on(
    event: "agent_settled",
    handler: (e: PiAgentSettledEvent, ctx: PiContext) => Promise<void>,
  ): void;
  on(
    event: "input",
    handler: (e: PiInputEvent, ctx: PiContext) => Promise<{ action: string }>,
  ): void;
  on(
    event: "message_end",
    handler: (e: PiMessageEndEvent, ctx: PiContext) => Promise<void>,
  ): void;
  on(
    event: "session_shutdown" | "session_start",
    handler: (e: unknown, ctx: PiContext) => Promise<void>,
  ): void;
  on(
    event: "tool_call",
    handler: (
      e: PiToolCallEvent,
      ctx: PiContext,
    ) => Promise<{ block?: boolean; reason?: string } | undefined>,
  ): void;
  on(
    event: "tool_result",
    handler: (
      e: PiToolResultEvent,
      ctx: PiContext,
    ) => Promise<{ content: { text?: string; type: string }[] } | undefined>,
  ): void;
  sendUserMessage: (text: string) => Promise<void>;
}

export default function guardExtension(pi: PiApp, deps?: GuardDeps): void {
  const guard = createGuard({ harness: "pi", deps });
  const notes = new Map<string, string>();
  let blocked = false;

  const sessionOf = (ctx: PiContext): string | undefined =>
    process.env.GUARD_PARENT_SESSION ?? ctx.sessionManager?.getSessionId?.();

  const agentId = process.env.GUARD_PARENT_SESSION
    ? (process.env.GUARD_AGENT_ID ?? "subagent")
    : undefined;

  pi.on("tool_call", async (event: PiToolCallEvent, ctx: PiContext) => {
    const d = await guard.preTool({
      sessionId: sessionOf(ctx),
      agentId,
      cwd: ctx.cwd,
      tool: event.toolName.toLowerCase(),
      input: event.input ?? {},
    });
    if (d.decision === "deny") return { block: true, reason: d.reason };
    if (d.decision === "ask") {
      const ask = {
        sessionId: sessionOf(ctx),
        cwd: ctx.cwd,
        tool: event.toolName,
        command: event.input?.command,
      };
      if (!ctx.hasUI) {
        await guard.askResult({ ...ask, result: "unavailable", via: "no-ui" });
        return {
          block: true,
          reason: `${d.reason ?? ""}\nNo UI to confirm this (print or JSON mode), so the command was not run: ask the user to run it.`,
        };
      }
      const rawTimeout = process.env.GUARD_ASK_TIMEOUT_MS;
      const askTimeoutMs =
        rawTimeout !== undefined && !Number.isNaN(Number(rawTimeout))
          ? Number(rawTimeout)
          : 60_000;
      const started = Date.now();
      const ok = await ctx.ui.confirm(
        "Run this risky command?",
        d.reason,
        askTimeoutMs > 0 ? { timeout: askTimeoutMs } : undefined,
      );
      const waitMs = Date.now() - started;
      if (
        ok === undefined ||
        (!ok && askTimeoutMs > 0 && waitMs >= askTimeoutMs)
      ) {
        await guard.askResult({
          ...ask,
          result: "timeout",
          waitMs,
        });
        return {
          block: true,
          reason: `No answer: nobody confirmed this command within ${String(askTimeoutMs / 1000)}s. Carry on without it, or leave it for the user.\n${d.reason ?? ""}`,
        };
      }
      if (!ok) {
        await guard.askResult({
          ...ask,
          result: "deny",
          waitMs,
        });
        return {
          block: true,
          reason: `The user denied this command. Do not retry it or a respelling of it; ask the user what they want instead.\n${d.reason ?? ""}`,
        };
      }
      await guard.askResult({
        ...ask,
        result: "allow",
        waitMs,
      });
    }
    if (d.context) notes.set(event.toolCallId, d.context);
    if (d.notice && ctx.hasUI) {
      try {
        ctx.ui.notify(d.notice, "info");
      } catch {
        // no notification: the agent still has the note
      }
    }
  });

  pi.on("tool_result", (event: PiToolResultEvent, ctx: PiContext) => {
    const postNote = guard.postTool({
      cwd: ctx.cwd,
      tool: event.toolName.toLowerCase(),
      input: event.input ?? {},
    });
    const extra = [notes.get(event.toolCallId), postNote].filter(
      (x): x is string => Boolean(x),
    );
    notes.delete(event.toolCallId);
    if (extra.length) {
      return Promise.resolve({
        content: [
          ...(event.content ?? []),
          ...extra.map((text) => ({ type: "text", text })),
        ],
      });
    }
    return Promise.resolve(undefined);
  });

  pi.on("input", async (event: PiInputEvent, ctx: PiContext) => {
    await guard.prompt({
      sessionId: sessionOf(ctx),
      agentId,
      cwd: ctx.cwd,
      prompt: event.text ?? "",
    });
    return { action: "continue" };
  });

  pi.on("message_end", async (event: PiMessageEndEvent, ctx: PiContext) => {
    const m = event.message;
    if (m?.role !== "assistant" || !m.usage) return;
    const u = m.usage;
    await guard.usage({
      sessionId: sessionOf(ctx),
      model: m.responseModel ?? m.model,
      provider: m.provider,
      tokens: {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
        reasoning: u.reasoning,
      },
      costUsd: u.cost?.total,
    });
  });

  pi.on("session_start", async (_event: unknown, ctx: PiContext) => {
    guard.awake();
    if (process.env.GUARD_PARENT_SESSION) return;
    try {
      await guard.sessionStart({ sessionId: sessionOf(ctx), cwd: ctx.cwd });
    } catch {
      // a missing record changes nothing
    }
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: PiContext) => {
    await guard.sessionEnd({ sessionId: sessionOf(ctx) });
  });

  pi.on("agent_settled", async (event: PiAgentSettledEvent, ctx: PiContext) => {
    if (event.aborted) return;
    const reason = await guard.stop({ cwd: ctx.cwd, active: blocked });
    blocked = Boolean(reason);
    if (reason) await pi.sendUserMessage(reason);
  });
}
