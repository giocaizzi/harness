// Type definitions for the guard hook layer, harness abstractions, and hook lifecycles.

import type { HostFacts } from "../core/types.mjs";

export type HarnessName =
  | "claude"
  | "copilot"
  | "codex"
  | "opencode"
  | "pi"
  | "antigravity"
  | "vscode"
  | "other";

export type ExecutionKind = "command" | "in-process";

export type PermissionDecision = "allow" | "deny" | "ask";

export interface HarnessConfig {
  readonly displayName: string;
  readonly editTools: readonly string[];
  readonly envTrigger?: string;
  readonly kind: ExecutionKind;
  readonly name: HarnessName;
  readonly readTools: readonly string[];
  readonly requiresAutoApprovalDeny?: boolean;
  readonly shellTools: readonly string[];
  readonly supportsNativeAsk: boolean;
  readonly taskTools: readonly string[];
}

export interface HookInput {
  agent_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  session_id?: string;
  source?: string;
  stop_hook_active?: boolean;
  tool_input?: unknown;
  tool_name?: string;
}

export interface HookSpecificOutput {
  additionalContext?: string;
  decision?: string;
  hookEventName?: string;
  permissionDecision?: PermissionDecision;
  permissionDecisionReason?: string;
  reason?: string;
}

export interface HookOutputPayload {
  hookSpecificOutput?: HookSpecificOutput;
  systemMessage?: string;
}

export interface HookResult {
  additionalContext?: string;
  hookSpecificOutput?: HookSpecificOutput;
  systemMessage?: string;
}

export interface ProcessInfo {
  name: string;
  ppid: number;
}

export type ProcessLookup = (
  pid: number,
  platform?: NodeJS.Platform,
) => ProcessInfo | null;

export type PluginVersionMap = Record<string, string>;

export interface StaleCheckResult {
  notice: string | null;
  versions: PluginVersionMap;
}

export interface SessionState {
  loaded: string[];
  reminded: string[];
  unattended?: boolean;
}

export interface SessionFact {
  agent?: string;
  loaded?: string;
  pid?: number;
  reminded?: string;
  unattended?: boolean;
  versions?: PluginVersionMap;
}

export interface SessionStore {
  isProcessRecorded(pid: number): boolean;
  load(): SessionState;
  processes(): number[];
  recordLoaded(skill: string): void;
  recordProcess(pid: number, versions: PluginVersionMap): void;
  recordReminded(hint: string): void;
  setUnattended(val: boolean): void;
}

export type StopDecision = "allow" | "block";

export interface StopCheckOutcome {
  decision: StopDecision;
  reason?: string;
}

export interface GuardPreToolResult {
  context?: string;
  decision?: PermissionDecision;
  notice?: string;
  reason?: string;
}

export interface GuardAskResultParams {
  command?: string;
  cwd?: string;
  result: "allow" | "deny" | "unavailable" | "timeout";
  sessionId?: string;
  tool?: string;
  via?: string;
  waitMs?: number;
}

export interface GuardModelTokens {
  cacheRead?: number;
  cacheWrite?: number;
  input?: number;
  output?: number;
  reasoning?: number;
}

export interface GuardModelUsageParams {
  costUsd?: number;
  model?: string;
  provider?: string;
  sessionId?: string;
  tokens?: GuardModelTokens;
}

export interface GuardBridge {
  askResult(params: GuardAskResultParams): Promise<void>;
  awake(): unknown;
  postTool(params: {
    cwd?: string;
    input?: unknown;
    tool: string;
  }): string | null;
  preTool(params: {
    agentId?: string;
    cwd?: string;
    input?: unknown;
    sessionId?: string;
    tool: string;
  }): Promise<GuardPreToolResult>;
  prompt(params: {
    agentId?: string;
    cwd?: string;
    prompt: string;
    sessionId?: string;
  }): Promise<HookOutputPayload>;
  sessionEnd(params: { sessionId?: string }): Promise<HookOutputPayload>;
  sessionStart(params: {
    cwd?: string;
    sessionId?: string;
    source?: string;
  }): Promise<HookOutputPayload>;
  stop(params: { active?: boolean; cwd?: string }): Promise<string | null>;
  usage(params: GuardModelUsageParams): Promise<void>;
}

export interface GuardDeps {
  argv?: string[];
  dataDir?: string;
  emit?: (
    event: string,
    attrs: Record<string, unknown>,
    cwd?: string,
  ) => Promise<void> | void;
  env?: NodeJS.ProcessEnv;
  harness?: string;
  hostFacts?: (cwd?: string) => Promise<HostFacts>;
  launch?: (argv: string[]) => number | null | undefined;
  nativeAsk?:
    | ((
        command: string,
        rule: string,
        input?: unknown,
      ) => Promise<boolean> | boolean)
    | null;
  noAsk?: boolean;
  pluginRoot?: string;
  processId?: number;
  pythonManager?: (cwd?: string) => string | null;
  report?: (
    event: string,
    attrs: Record<string, unknown>,
  ) => Promise<void> | void;
  rootTimeoutMs?: number;
  run?: (
    argv: readonly string[],
    cwd?: string,
    ms?: number,
  ) => Promise<string | null>;
  spawnSync?: unknown;
}

export interface HandleDeps {
  dataDir?: string;
  emit?: (
    event: string,
    attrs: Record<string, unknown>,
    cwd?: string,
  ) => Promise<void> | void;
  env?: Record<string, string | undefined>;
  factsMs?: number;
  harness?: string;
  hostFacts?: (cwd?: string) => Promise<HostFacts>;
  knownSkills?: Set<string>;
  nativeAsk?:
    | ((
        command: string,
        rule: string,
        input?: unknown,
      ) => Promise<boolean> | boolean)
    | null;
  noAsk?: boolean;
  pluginRoot?: string;
  previewMs?: number;
  processId?: number;
  pythonManager?: (cwd?: string) => string | null;
  random?: () => number;
  readTool?: boolean;
  run?: (
    argv: readonly string[],
    cwd?: string,
    ms?: number,
  ) => Promise<string | null>;
}
