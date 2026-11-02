// opencode plugin: the guard's rules on opencode's plugin hooks (https://opencode.ai/docs/plugins/).
// scripts/install.mjs writes a one-line stub into ~/.config/opencode/plugins/ that re-exports this file.
// A plugin cannot ask (opencode 1.19 declares `permission.ask` but never calls it), so the `config` hook adds
// `permission.bash` ask entries for the risky prefixes and opencode asks itself; any other risky form is denied.

import { nativeAsk, opencodeAsks } from "../core/engine.mjs";
import { rules } from "../core/rules.mjs";
import { createGuard } from "./bridge.mjs";
import type { GuardDeps, HookInput } from "./types.mjs";

const ASKS = opencodeAsks(rules);
const ROOT_TIMEOUT_MS = 2000;

type PermValue = string | Record<string, string> | undefined;

// A config key that rules on bash: `bash` or the `*` catch-all.
const bashKeys = (perm: unknown): PermValue[] =>
  perm && typeof perm === "object"
    ? Object.entries(perm as Record<string, PermValue>)
        .filter(([k]) => k === "bash" || k === "*")
        .map(([, v]) => v)
    : [perm as PermValue];

const denies = (perm: unknown): boolean =>
  bashKeys(perm).some(
    (v) =>
      v === "deny" ||
      (v && typeof v === "object" && Object.values(v).includes("deny")),
  );

export interface PermissionMap {
  [pattern: string]: string | Record<string, string> | undefined;
  bash?: Record<string, string>;
}

// The permission config with the asks appended last to `bash` (opencode's last matching rule wins), so they
// override the user's allows. `bash` moves after `*` for the same reason.
export function withAsks(perm: unknown): Record<string, unknown> {
  const p: Record<string, unknown> =
    typeof perm === "string"
      ? { "*": perm }
      : { ...(perm as Record<string, unknown>) };
  const rawBash = p.bash;
  const bash: Record<string, string> =
    typeof rawBash === "string"
      ? { "*": rawBash }
      : { ...(rawBash as Record<string, string>) };
  delete p.bash;
  const filteredBash = Object.fromEntries(
    Object.entries(bash).filter(([k]) => !(k in ASKS)),
  );
  return { ...p, bash: { ...filteredBash, ...ASKS } };
}

export interface OpencodeSessionInfo {
  id?: string;
  parentID?: string;
  permission?: readonly {
    action?: string;
    pattern?: string;
    permission?: string;
  }[];
}

export interface OpencodeClient {
  session: {
    get: (params: {
      path: { id: string };
    }) => Promise<{ data?: OpencodeSessionInfo } | null>;
    prompt: (params: {
      body: { parts: { text: string; type: string }[] };
      path: { id: string };
    }) => Promise<unknown>;
  };
  tui: {
    showToast: (params: {
      body: { message?: string; variant?: string };
    }) => Promise<unknown>;
  };
}

export interface OpencodePluginContext {
  client: OpencodeClient;
  directory: string;
}

export interface OpencodeConfigAgent {
  permission?: unknown;
}

export interface OpencodeConfig {
  agent?: Record<string, OpencodeConfigAgent>;
  permission?: unknown;
}

export interface ToolExecuteBeforeInput {
  callID: string;
  sessionID: string;
  tool: string;
}

export interface ToolExecuteBeforeOutput {
  args?: Record<string, unknown>;
}

export interface ToolExecuteAfterInput {
  args?: Record<string, unknown>;
  callID: string;
  sessionID: string;
  tool: string;
}

export interface ToolExecuteAfterOutput {
  output?: string;
}

export interface ChatMessageInput {
  sessionID: string;
}

export interface ChatMessageOutput {
  parts?: readonly { text?: string; type?: string }[];
}

export interface MessageUpdatedInfo {
  cost?: number;
  id: string;
  model?: { id?: string; providerID?: string };
  modelID?: string;
  parentID?: string;
  providerID?: string;
  role?: string;
  sessionID?: string;
  time?: { completed?: boolean };
  tokens?: {
    cache?: { read?: number; write?: number };
    input?: number;
    output?: number;
    reasoning?: number;
  };
}

export interface OpencodeEvent {
  properties?: {
    id?: string;
    info?: MessageUpdatedInfo;
    sessionID?: string;
  };
  type: string;
}

export interface OpencodePlugin {
  "chat.message": (
    input: ChatMessageInput,
    output: ChatMessageOutput,
  ) => Promise<void>;
  config: (cfg: OpencodeConfig) => Promise<void>;
  event: (payload: { event: OpencodeEvent }) => Promise<void>;
  "tool.execute.after": (
    input: ToolExecuteAfterInput,
    output: ToolExecuteAfterOutput,
  ) => Promise<void>;
  "tool.execute.before": (
    input: ToolExecuteBeforeInput,
    output: ToolExecuteBeforeOutput,
  ) => Promise<void>;
}

export const GuardPlugin = (
  { client, directory }: OpencodePluginContext,
  deps?: GuardDeps & { rootTimeoutMs?: number },
): Promise<OpencodePlugin> => {
  let asks = false;
  const guard = createGuard({
    harness: "opencode",
    noAsk: true,
    deps: {
      nativeAsk: async (command, rule, input) => {
        const auto = (deps?.argv ?? process.argv).some(
          (a) => a.startsWith("--auto") && a !== "--auto=false",
        );
        if (!asks || auto || !nativeAsk(command, rule, rules)) return false;
        const hookInput = input as HookInput | undefined;
        const targetId = hookInput?.agent_id ?? hookInput?.session_id;
        if (!targetId) return false;
        const s = await client.session
          .get({ path: { id: targetId } })
          .catch(() => null);
        return (
          Boolean(s?.data) &&
          !(s?.data?.permission ?? []).some(
            (r) => r.permission === "bash" || r.permission === "*",
          )
        );
      },
      ...deps,
    },
  });

  const notes = new Map<string, string>();
  const roots = new Map<string, Promise<string>>();

  const rootOf = (id: string): Promise<string> => {
    const existing = roots.get(id);
    if (existing) return existing;

    const walk = (async (): Promise<string> => {
      let cur = id;
      for (let depth = 0; depth < 5; depth++) {
        const res = await client.session
          .get({ path: { id: cur } })
          .catch(() => null);
        const parent = res?.data?.parentID;
        if (!parent) break;
        cur = parent;
      }
      return cur;
    })().catch(() => id);

    const late = Symbol("late");
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof late>((resolve) => {
      timer = setTimeout(() => {
        resolve(late);
      }, deps?.rootTimeoutMs ?? ROOT_TIMEOUT_MS);
    });

    const promise = Promise.race([walk, timeout])
      .then((root) => {
        if (root !== late) return root;
        roots.delete(id);
        return id;
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      });

    roots.set(id, promise);
    return promise;
  };

  const who = async (
    id: string,
  ): Promise<{ agentId?: string; sessionId: string }> => {
    const root = await rootOf(id);
    return root && root !== id
      ? { sessionId: root, agentId: id }
      : { sessionId: id };
  };

  const blocked = new Set<string>();
  const reported = new Set<string>();
  const text = (t?: string): string => (typeof t === "string" ? t : "");

  return Promise.resolve({
    config: (cfg: OpencodeConfig): Promise<void> => {
      const agents = Object.values(cfg.agent ?? {}).filter(
        (a): a is OpencodeConfigAgent => Boolean(a.permission),
      );
      if (denies(cfg.permission) || agents.some((a) => denies(a.permission))) {
        return Promise.resolve();
      }
      cfg.permission = withAsks(cfg.permission ?? {});
      for (const a of agents) {
        a.permission = withAsks(a.permission);
      }
      asks = true;
      return Promise.resolve();
    },

    "tool.execute.before": async (
      input: ToolExecuteBeforeInput,
      output: ToolExecuteBeforeOutput,
    ): Promise<void> => {
      const identity = await who(input.sessionID);
      const d = await guard.preTool({
        ...identity,
        cwd: directory,
        tool: input.tool.toLowerCase(),
        input: output.args ?? {},
      });
      if (d.decision === "deny" || d.decision === "ask") {
        throw new Error(d.reason);
      }
      if (d.context) notes.set(input.callID, d.context);
      if (d.notice) {
        Promise.resolve()
          .then(() =>
            client.tui.showToast({
              body: { message: d.notice, variant: "info" },
            }),
          )
          .catch(() => {
            // toast failed
          });
      }
    },

    "tool.execute.after": (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      const noteCtx = notes.get(input.callID);
      const postCtx = guard.postTool({
        cwd: directory,
        tool: input.tool.toLowerCase(),
        input: input.args ?? {},
      });
      const extra = [noteCtx, postCtx].filter((x): x is string => Boolean(x));
      notes.delete(input.callID);
      if (extra.length) {
        output.output = [text(output.output), ...extra]
          .filter(Boolean)
          .join("\n\n");
      }
      return Promise.resolve();
    },

    "chat.message": async (
      input: ChatMessageInput,
      output: ChatMessageOutput,
    ): Promise<void> => {
      const prompt = (output.parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text ?? "")
        .join("\n");
      if (prompt) {
        const identity = await who(input.sessionID);
        await guard.prompt({ ...identity, cwd: directory, prompt });
      }
    },

    event: async ({ event }: { event: OpencodeEvent }): Promise<void> => {
      const sessionId =
        event.properties?.sessionID ?? event.properties?.info?.id;
      const info = event.properties?.info;

      if (
        event.type === "message.updated" &&
        info?.role === "assistant" &&
        info.time?.completed &&
        info.tokens &&
        !reported.has(info.id)
      ) {
        reported.add(info.id);
        const t = info.tokens;
        await guard.usage({
          sessionId: info.sessionID,
          model: info.modelID ?? info.model?.id,
          provider: info.providerID ?? info.model?.providerID,
          tokens: {
            input: t.input,
            output: t.output,
            cacheRead: t.cache?.read,
            cacheWrite: t.cache?.write,
            reasoning: t.reasoning,
          },
          costUsd: info.cost,
        });
      }

      if (event.type === "session.created") {
        guard.awake();
        if (!info?.parentID) {
          await guard.sessionStart({
            sessionId: info?.id ?? sessionId,
            cwd: directory,
            source: "startup",
          });
        }
      } else if (event.type === "session.deleted") {
        await guard.sessionEnd({ sessionId });
      } else if (event.type === "session.idle" && sessionId) {
        const res = await Promise.resolve()
          .then(() => client.session.get({ path: { id: sessionId } }))
          .catch(() => null);
        if (res?.data?.parentID) return;
        const reason = await guard.stop({
          cwd: directory,
          active: blocked.has(sessionId),
        });
        if (!reason) {
          blocked.delete(sessionId);
          return;
        }
        blocked.add(sessionId);
        await client.session
          .prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: reason }] },
          })
          .catch(() => {
            // prompt failed
          });
      }
    },
  });
};
