export type EnvMap = Readonly<Record<string, string | undefined>>;

export interface GateLabels {
  approval: string;
  claimed: string;
  needs_grooming: string;
  takeover: string;
}

export interface GateConfig {
  approvers: string[];
  writers: string[] | null;
  approversAllowBots: boolean;
  labels: GateLabels;
  marker: string;
  identityLogins: string[];
}

export interface GateReads {
  config: GateConfig;
  env: EnvMap;
  host: string;
  login: string | null;
  issue: Record<string, unknown>;
  timeline: unknown;
  edit: unknown;
  comments: Record<string, unknown>[];
}

export interface GateStop {
  check: string;
  reason: string;
  reason_code: string | null;
}

export type GateClaimState =
  | { state: "none" }
  | { state: "own"; comment_id: unknown; url: unknown }
  | { state: "untrusted"; login: string | null }
  | { state: "other"; newest: Record<string, unknown> | null }
  | { state: "held"; newest: Record<string, unknown> };

export interface GateChecks {
  open: boolean;
  approved: string;
  grooming: boolean;
  takeover: string | null;
  claim: GateClaimState;
}

export interface GateVerdict {
  checks: GateChecks;
  ready: string;
  body: string;
  verdict: "go" | "wait" | "stop";
  stop: GateStop | null;
  claim?: { action: "edit"; comment_id: unknown } | { action: "post" };
}

export interface ResolveRunIdOptions {
  env: EnvMap;
  ticket: string;
  runIdArg?: string | undefined;
  host: string;
  now: Date;
  warn: (message: string) => void;
}

export interface BuildResultOptions {
  env: EnvMap;
  ticket: string;
  runIdArg?: string | undefined;
  now?: Date | undefined;
  host?: string | undefined;
  platform?: string | undefined;
  warn?: ((message: string) => void) | undefined;
}

export interface BuildResultOutput {
  result?: Record<string, unknown>;
  errors: string[];
}

export interface PathLike {
  join: (...paths: string[]) => string;
  dirname: (p: string) => string;
}
