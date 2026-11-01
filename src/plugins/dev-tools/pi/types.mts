export interface AgentDefinition {
  name: string;
  description: string;
  tools: string[] | null;
  thinking?: string;
  prompt: string;
}

export type AgentArgsInput = Pick<AgentDefinition, "tools" | "thinking">;

export interface ChildIds {
  session?: string;
  agent?: string;
}

export interface RunResult {
  code: number | null;
  out: string;
  err: string;
}

export interface SubagentUpdate {
  content: { type: "text"; text: string }[];
  details?: {
    model?: string;
    thinking?: string;
  };
}

export interface SubagentContext {
  cwd?: string;
  model?: {
    provider: string;
    id: string;
  };
  sessionManager?: {
    getSessionId?: () => string | undefined;
  };
}

export interface SubagentParams {
  agent: string;
  task: string;
}

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: {
    type: "object";
    properties: {
      agent: {
        type: "string";
        enum: string[];
        description: string;
      };
      task: {
        type: "string";
        description: string;
      };
    };
    required: string[];
  };
  execute: (
    id: string,
    params: SubagentParams,
    signal?: AbortSignal,
    onUpdate?: (update: SubagentUpdate) => void,
    ctx?: SubagentContext,
  ) => Promise<SubagentUpdate>;
}

export interface PiHost {
  registerTool: (tool: PiToolDefinition) => void;
}

export type RunSubagent = (
  argv: string[],
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  ids: ChildIds,
) => Promise<RunResult>;

export interface SubagentDependencies {
  loadAgents?: (root?: string) => AgentDefinition[];
  run?: RunSubagent;
}
