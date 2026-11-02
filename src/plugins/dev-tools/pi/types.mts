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

export interface PiUISelectOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface PiUIInputOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface PiUIContext {
  input?: (
    title: string,
    placeholder?: string,
    opts?: PiUIInputOptions,
  ) => Promise<string | undefined | null>;
  select?: (
    title: string,
    options: string[],
    opts?: PiUISelectOptions,
  ) => Promise<string | undefined | null>;
}

export interface AskQuestionContext {
  hasUI?: boolean;
  ui?: PiUIContext;
}

export interface AskQuestionParams {
  options?: string[];
  question: string;
}

export interface PiToolDefinition {
  description: string;
  execute: (
    id: string,
    params: SubagentParams,
    signal?: AbortSignal,
    onUpdate?: (update: SubagentUpdate) => void,
    ctx?: SubagentContext,
  ) => Promise<SubagentUpdate>;
  label: string;
  name: string;
  parameters: {
    properties: {
      agent: {
        description: string;
        enum: string[];
        type: "string";
      };
      task: {
        description: string;
        type: "string";
      };
    };
    required: string[];
    type: "object";
  };
}

export interface AskQuestionToolDefinition {
  description: string;
  execute: (
    id: string,
    params: AskQuestionParams,
    signal?: AbortSignal,
    onUpdate?: (update: SubagentUpdate) => void,
    ctx?: AskQuestionContext,
  ) => Promise<SubagentUpdate>;
  label: string;
  name: string;
  parameters: {
    properties: Record<string, unknown>;
    required?: string[];
    type: "object";
  };
}

export interface PiHost {
  registerTool: (tool: PiToolDefinition | AskQuestionToolDefinition) => void;
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
