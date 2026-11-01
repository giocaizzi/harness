// Shared types for Codex rollout lines/payloads, opencode plugin client/events, and pi extension API/context.
import type { AlertLevel, LimitKind } from "./alerts.mjs";

export type AlertLevels = Partial<Record<"ctx" | LimitKind, AlertLevel>>;

export interface CodexHookPayload {
  hook_event_name?: string;
  session_id: string;
  transcript_path: string;
  turn_id: string;
}

export interface CodexTurnFacts {
  error: boolean;
  pct: number | null;
  startedMs: number | null;
}

export interface CodexStopOptions {
  dataDir: string;
  now?: number;
  play?: (clip: string) => void;
  read?: (filePath: string) => string;
}

export interface CodexStopResult {
  systemMessage?: string;
}

export interface OpencodeProviderModel {
  id: string;
  limit?: {
    context?: number;
  };
}

export interface OpencodeProvider {
  id: string;
  models?: Record<string, OpencodeProviderModel>;
}

export interface OpencodeProvidersResponse {
  data?: {
    providers?: OpencodeProvider[];
  };
}

export interface OpencodeToastBody {
  message: string;
  variant: "info";
}

export interface OpencodeClient {
  config: {
    providers: () => Promise<OpencodeProvidersResponse>;
  };
  tui: {
    showToast: (options: { body: OpencodeToastBody }) => Promise<unknown>;
  };
}

export interface OpencodeMessageTokens {
  cache: {
    read: number;
    write: number;
  };
  input: number;
  output: number;
  reasoning: number;
}

export interface OpencodeEventInfo {
  id?: string;
  modelID?: string;
  parentID?: string;
  providerID?: string;
  role?: string;
  sessionID?: string;
  tokens?: OpencodeMessageTokens;
}

export interface OpencodeEventProperties {
  error?: {
    name?: string;
  };
  info?: OpencodeEventInfo;
  sessionID?: string;
}

export interface OpencodeEvent {
  properties?: OpencodeEventProperties;
  type: string;
}

export interface OpencodeDependencies {
  bell?: () => void;
  now?: () => number;
  play?: (clip: string) => void;
}

export interface OpencodeHooks {
  "chat.message": (input: { sessionID: string }) => Promise<void>;
  event: (input: { event: OpencodeEvent }) => Promise<void>;
}

export interface PiContext {
  getContextUsage?: () => { percent?: number | null } | null | undefined;
  hasUI?: boolean;
  ui: {
    notify: (text: string, level: "info") => void;
  };
}

export interface PiMessageEndEvent {
  message?: {
    stopReason?: string;
  };
}

export interface PiAgentSettledEvent {
  aborted?: boolean;
}

export interface PiExtensionApi {
  on(event: "agent_start" | "session_compact", handler: () => void): void;
  on(event: "message_end", handler: (event: PiMessageEndEvent) => void): void;
  on(
    event: "agent_settled",
    handler: (event: PiAgentSettledEvent, context: PiContext) => void,
  ): void;
}

export interface PiDependencies {
  bell?: () => void;
  play?: (clip: string) => void;
}
