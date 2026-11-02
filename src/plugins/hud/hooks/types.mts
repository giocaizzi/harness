export type ForgeType = "github" | "gitlab" | "azure";

export type PrCheckStatus = "pass" | "fail" | "pending";

export interface PrInfo {
  number: number;
  url: string | null;
  state: string;
  checks: PrCheckStatus[];
}

export interface RepoState {
  ahead: number;
  behind: number;
  changes: {
    files: number;
    untracked: number;
    added: number;
    removed: number;
  } | null;
  pr: {
    number: number;
    url: string | null;
    state: string;
    total: number;
    passed: number;
    ci: "pass" | "fail" | "pending" | null;
  } | null;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens?: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface ForecastFacts {
  percent?: number | null;
  usage?: TokenUsage;
  turns?: number;
  ttlMs?: number | null;
  sinceMs?: number | null;
  showCtx?: boolean;
}

export interface ForecastSegment {
  kind: string;
  value: string;
  text: string;
  tone: "ok" | "warn" | "bad";
}

export interface ForecastResult {
  ctx: number | null;
  hit: number | null;
  left: number | null;
  hints: string[];
  text: string;
  segments: ForecastSegment[];
}

export interface RateLimitSample {
  at: number;
  pct: number | null;
}

export interface GitHubPrPayload {
  number: number;
  url?: string | null;
  state?: string;
  statusCheckRollup?: {
    conclusion?: string;
    state?: string;
    status?: string;
  }[];
}

export interface GitLabMrPayload {
  iid: number;
  web_url?: string | null;
  state?: string;
  head_pipeline?: { status?: string } | null;
  pipeline?: { status?: string } | null;
}

export interface AzurePrPolicy {
  status?: string;
}

export interface AzurePrItem {
  pullRequestId?: number;
  repository?: { webUrl?: string };
  status?: string;
}

export interface ForgeRepoInfo {
  forge: ForgeType;
  host?: string;
  path?: string;
  org?: string;
  project?: string;
  repo?: string;
}

export type RunnerFn = (argv: string[], cwd?: string) => Promise<string | null>;

export interface WorkItemReference {
  repo?: string;
  sigil: string;
  n: string | number;
}

export type WorkItemKind = "issue" | "pr" | "workitem";

export interface TargetResult {
  url: string;
  kind: WorkItemKind;
}

export interface LinkifyOptions {
  format?: "markdown" | "ansi";
  glyph?: boolean;
  color?: boolean;
}

export interface Facts {
  stat: (p: string) => string | null | undefined;
  commit: (sha: string) => boolean | null | undefined;
  state: (
    r: ForgeRepoInfo,
    ref: WorkItemReference,
  ) => { kind: string; state: string } | null | undefined;
  readonly pending: number;
  settle: (ms?: number) => Promise<boolean>;
}

export interface RewriteContext {
  repo: ForgeRepoInfo | null;
  cwd?: string;
  home?: string;
  now?: number;
}
