// The guard for harnesses that load plugins in-process (opencode, pi) rather than running command hooks: each
// event is turned into the Claude-shaped payload the command hooks get and passed to the same handlers, so the
// rules behave alike everywhere. opencode.mjs and pi.mjs only map their harness's events onto these calls.

import { spawn } from "node:child_process";

import { cmdClass } from "../core/engine.mjs";
import { emit } from "../core/otel.mjs";
import { keepAwake } from "./awake.mjs";
import { fallbackDataDir } from "./data.mjs";
import { handle, hostFacts, pythonManager, run } from "./guard.mjs";
import { type SpawnSyncFn, lintFile } from "./lint.mjs";
import { stopCheck } from "./stop.mjs";
import { recordAttrs } from "./telemetry.mjs";
import type {
  GuardAskResultParams,
  GuardBridge,
  GuardDeps,
  GuardModelUsageParams,
  GuardPreToolResult,
  HookInput,
  HookOutputPayload,
  PermissionDecision,
} from "./types.mjs";

// Neither harness gives plugins a data dir; the same fallback as VS Code.
export const DATA_DIR = fallbackDataDir();

const launchDetached = (argv: readonly string[]): number | undefined => {
  const exe = argv[0];
  if (!exe) return undefined;
  const child = spawn(exe, argv.slice(1), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    // ignored
  });
  child.unref();
  return child.pid;
};

export interface CreateGuardOptions {
  dataDir?: string;
  deps?: GuardDeps;
  harness: string;
  noAsk?: boolean;
}

// `harness` names it in telemetry; `noAsk` turns an ask into a deny where the harness cannot ask, unless
// `deps.nativeAsk(command, rule, input)` says the harness's own prompt covers it.
export function createGuard({
  harness,
  noAsk = false,
  dataDir = DATA_DIR,
  deps = {},
}: CreateGuardOptions): GuardBridge {
  const d: GuardDeps & {
    dataDir: string;
    env: NodeJS.ProcessEnv;
    harness: string;
    hostFacts: typeof hostFacts;
    noAsk: boolean;
    processId: number;
    pythonManager: typeof pythonManager;
    run: typeof run;
  } = {
    dataDir,
    harness,
    processId: process.pid,
    env: process.env,
    hostFacts,
    run,
    pythonManager,
    noAsk,
    emit: (event, attrs, cwd) =>
      emit(process.env, event, recordAttrs(attrs, cwd, harness)),
    // The harness's own usage, as the harness (service.name opencode or pi): neither exports telemetry itself.
    report: (event, attrs) => emit(process.env, event, attrs, fetch, harness),
    ...deps,
  };

  const call = async (input: HookInput): Promise<HookOutputPayload> => {
    try {
      const out = await handle(input, d);
      const o = out.stdout ? (JSON.parse(out.stdout) as HookOutputPayload) : {};
      return {
        ...o.hookSpecificOutput,
        systemMessage: o.systemMessage,
      };
    } catch {
      return {};
    }
  };

  return {
    // { decision: 'deny'|'ask'|undefined, reason, context, notice } for a tool call; `notice` is for the user. `tool` is the harness's tool name,
    // lower-cased; `input` its arguments (a shell call carries `command`).
    // `agentId`: a subagent's own id, whose reminders are its own while `sessionId` is the session it belongs to.
    async preTool({
      sessionId,
      agentId,
      cwd,
      tool,
      input,
    }: {
      agentId?: string;
      cwd?: string;
      input?: unknown;
      sessionId?: string;
      tool: string;
    }): Promise<GuardPreToolResult> {
      const o = await call({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        agent_id: agentId,
        cwd,
        tool_name: tool,
        tool_input: input,
      });
      const specific = o as {
        additionalContext?: string;
        permissionDecision?: PermissionDecision;
        permissionDecisionReason?: string;
      };
      return {
        decision: specific.permissionDecision,
        reason: specific.permissionDecisionReason,
        context: specific.additionalContext,
        notice: o.systemMessage,
      };
    },

    prompt: ({
      sessionId,
      agentId,
      cwd,
      prompt,
    }: {
      agentId?: string;
      cwd?: string;
      prompt: string;
      sessionId?: string;
    }): Promise<HookOutputPayload> =>
      call({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        agent_id: agentId,
        cwd,
        prompt,
      }),

    // The session's start: one `guard.session` record with the installed plugin versions.
    sessionStart: ({
      sessionId,
      cwd,
      source,
    }: {
      cwd?: string;
      sessionId?: string;
      source?: string;
    }): Promise<HookOutputPayload> =>
      call({
        hook_event_name: "SessionStart",
        session_id: sessionId,
        cwd,
        source,
      }),

    sessionEnd: ({
      sessionId,
    }: {
      sessionId?: string;
    }): Promise<HookOutputPayload> =>
      call({
        hook_event_name: "SessionEnd",
        session_id: sessionId,
      }),

    // The answer to an ask the harness showed itself (pi's confirm): allow, deny, or unavailable with no UI.
    askResult: ({
      sessionId,
      cwd,
      tool,
      command,
      result,
      waitMs,
      via,
    }: GuardAskResultParams): Promise<void> =>
      Promise.resolve(
        d.emit?.(
          "guard.ask_result",
          {
            result,
            wait_ms: waitMs,
            via,
            tool,
            cmd_class: command ? cmdClass(null, command) : "tool",
            session_id: sessionId,
          },
          cwd,
        ),
      ).catch(() => {
        // ignored
      }),

    // Lint findings for an edit, or null.
    postTool({
      cwd,
      tool,
      input,
    }: {
      cwd?: string;
      input?: unknown;
      tool: string;
    }): string | null {
      try {
        const res = lintFile(
          { cwd, tool_name: tool, tool_input: input },
          d.spawnSync as SpawnSyncFn | undefined,
        );
        return res?.additionalContext ?? null;
      } catch {
        return null;
      }
    },

    // The reason to keep going (the factory result gate or make check), or null. `active` is true when the last stop was already blocked.
    // Async: make runs detached, so the harness's event loop keeps going meanwhile.
    async stop({
      cwd,
      active,
    }: {
      active?: boolean;
      cwd?: string;
    }): Promise<string | null> {
      try {
        const out = await stopCheck(
          { cwd, stop_hook_active: active },
          d.spawnSync as typeof import("./stop.mjs").fingerprint extends (
            c: string,
            r: infer R,
          ) => unknown
            ? R
            : never,
          {
            report: (attrs) => {
              void d.emit?.("guard.stop", { ...attrs, cmd_class: "stop" }, cwd);
            },
          },
        );
        return out?.decision === "block" ? (out.reason ?? null) : null;
      } catch {
        return null;
      }
    },

    // One model response: { sessionId, model, provider, tokens: { input, output, cacheRead, cacheWrite, reasoning }, costUsd }.
    // Named like Claude Code's api_request, so one query covers every harness. Never throws.
    usage({
      sessionId,
      model,
      provider,
      tokens = {},
      costUsd,
    }: GuardModelUsageParams): Promise<void> {
      const n = (v: unknown): number | undefined =>
        Number.isFinite(Number(v)) ? Number(v) : undefined;
      return Promise.resolve(
        d.report?.("api_request", {
          "session.id": sessionId,
          model,
          provider,
          input_tokens: n(tokens.input),
          output_tokens: n(tokens.output),
          cache_read_tokens: n(tokens.cacheRead),
          cache_creation_tokens: n(tokens.cacheWrite),
          reasoning_tokens: n(tokens.reasoning),
          cost_usd: n(costUsd),
        }),
      ).catch(() => {
        // ignored
      });
    },

    // In-process: the harness is this process.
    awake(): unknown {
      try {
        return keepAwake({
          dataDir,
          start: process.pid,
          launch: d.launch ?? launchDetached,
        });
      } catch {
        return null;
      }
    },
  };
}
