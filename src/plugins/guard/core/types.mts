// Type definitions for the guard core engine, shell parser, host probes and OTel telemetry.

export type EnvMap = Record<string, string | undefined>;

export interface DirSet {
  has(dir: string): boolean;
}

export interface GuardEnv {
  [key: string]: string | DirSet | undefined;

  HOME?: string;
  TEMP?: string;
  TMP?: string;
  TMPDIR?: string;
  USERPROFILE?: string;
  dirs?: DirSet;
}

export interface CpuTimes {
  idle: number;
  irq: number;
  nice: number;
  sys: number;
  user: number;
}

export interface CpuSnapshot {
  times: CpuTimes;
}

export interface HostFacts {
  cpuPercent?: number;
  freeGb?: number;
  load1?: number;
}

export interface DocsOnlyRule {
  re: RegExp;
  skip: boolean;
}

export interface OtelConfig {
  endpoint?: string;
  headers?: string;
  resource?: string;
}

export interface TraceContext {
  spanId: string;
  traceId: string;
}

export interface OtelLogRequest {
  body: string;
  headers: Record<string, string>;
  url: string;
}

export type FetchLike = (
  url: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: string;
    signal: AbortSignal;
  },
) => unknown;

export interface ShellSubstitution {
  quoted: boolean;
  text: string;
}

export interface ShellWord {
  quoted: boolean;
  raw: string;
  substs: ShellSubstitution[];
  val: string;
}

export type PayloadKind = "subst" | "shell" | "ssh" | "exec";
export type ExpandedState = boolean | "escaped";

export interface ShellPayload {
  expanded?: ExpandedState;
  host?: string;
  injected?: boolean;
  kind: PayloadKind;
  remote?: boolean;
  text: string;
}

export interface AnalyzedPayload extends ShellPayload {
  analysis: ShellAnalysis;
}

export interface ScannedCommand {
  code: string;
  decoder?: boolean;
  end: number;
  heredocs: string[];
  payloads: AnalyzedPayload[];
  raw: string;
  redirs: ShellWord[];
  sep: string;
  start: number;
  words: ShellWord[];
}

export interface ShellAnalysis {
  commands: ScannedCommand[];
  opaque: boolean;
}

export interface WrapperSpec {
  assign?: boolean;
  flag: string;
  keyword?: boolean;
  long: Record<string, boolean | undefined>;
  numeric?: boolean;
  optional: string;
  pos: number;
  priority?: boolean;
  shell?: boolean;
  split?: boolean;
  value: string;
}

export interface WrappedPayload {
  text: string;
  words: ShellWord[];
}

export interface WrappedResult {
  heads: number[];
  payload: WrappedPayload | null;
  unsure: boolean;
  words: ShellWord[];
}

export interface UnitContext {
  depth: number;
  host?: string;
  injected: boolean;
  kind?: PayloadKind;
  remote: boolean;
}

export interface CommandUnit extends UnitContext {
  cmd: ScannedCommand;
  siblings: number;
}

export interface SkillRule {
  id: string;
  match: string;
  remind?: boolean;
  skills: string[];
  why: string;
}

export interface FileRule {
  id: string;
  match: string;
  skills: string[];
  why: string;
}

export interface RoutingOverride {
  effort?: string[];
  model?: string;
  modelNeeds?: string;
}

export interface RoutingRules {
  aliases: Record<string, string>;
  codexBuiltin: string[];
  judgementModel: string;
  overrides: Record<string, RoutingOverride>;
  plan: string[];
  skill: string;
  tools: string[];
  typed: string[];
  untyped: string[];
}

export interface StackRule {
  match: string;
  why: string;
}

export interface DenyRule {
  id: string;
  match: string;
  when?: string;
  why: string;
}

export interface HeavyRule {
  id: string;
  match: string;
}

export interface RiskyRule {
  case?: boolean;
  help?: boolean;
  id: string;
  match: string;
  pipeline?: boolean;
  prefixes?: string[][];
  raw?: string;
  say?: string;
  skipInjected?: boolean;
  unless?: string;
  why: string;
}

export interface ProtectedLimits {
  chars: number;
  globs: number;
  ms: number;
  targets: number;
}

export interface RunRules {
  ghCommands: string[];
  ghUnseenWhy: string;
  labelWhy: string;
  protectedLimits: ProtectedLimits;
  protectedPaths: string[];
  protectedWhy: string;
  unsureWhy: string;
}

export interface TitlesRules {
  types: string[];
  why: string;
}

export interface HostRules {
  cpuPercentCap: number;
  freeFloorGb: number;
  loadCap: number;
  wrapper: string;
}

export type ThrottleMode = "warn" | "ask" | "deny" | "off";
export type UsageLevel = "ok" | "warn" | "throttle" | "unknown";

export interface UsageRules {
  throttleMode: ThrottleMode;
  throttlePercent: number;
  warnPercent: number;
}

export interface GuardRules {
  deny?: DenyRule[];
  files?: FileRule[];
  heavy: HeavyRule[];
  host: HostRules;
  risky: RiskyRule[];
  routing: RoutingRules;
  run: RunRules;
  skills: SkillRule[];
  stack: StackRule;
  titles: TitlesRules;
  usage: UsageRules;
}

export type RunnerFn = (
  argv: string[],
  cwd?: string,
) => Promise<string | null | undefined> | string | null | undefined;

export interface SafeFact {
  safe: boolean;
  why: string;
}

export interface TagFact {
  local: boolean;
  why: string;
}

export interface RemovalEntry {
  remote: boolean;
  target: string;
}

export interface BranchTarget {
  dir: string;
  name: string;
}

export interface RefTarget {
  dir: string;
  name: string;
  repo: string | null;
}

export interface StackTarget {
  base: string | null;
  dir: string;
  head: string | null;
  pr: string | null;
  repo: string | null;
  verb: string;
}

export interface StackBelow {
  branch: string;
  number: number;
}

export interface StackFact {
  base?: string;
  below?: StackBelow;
}

export interface ProtectConfig {
  cwd?: string;
  data?: string[];
  // Waives `registered` globs only.
  exempt?: string[];
  // Never waived: the built-in floor and GUARD_RUN_PROTECTED_PATHS.
  globs: string[];
  // The registration's globs: waived by `exempt`.
  registered?: string[];
  root?: string;
  // Every directory with a .git above the cwd, nearest first: a path is protected when it is relative to any of them.
  roots?: string[];
}

export interface ProtectHit {
  target?: string;
  unsure?: string;
}

// A registered unattended run's facts for the shell and edit rules (run contract v2): the runner's labels, its
// protected paths and guard's data directories. Null outside such a run.
export interface RunFacts {
  labels?: { approval?: string; protected?: string[]; takeover?: string };
  protect?: {
    cwd?: string;
    data?: string[];
    // The registration's protected_paths.exempt: waives its own globs (`registered`) only.
    exempt?: string[];
    // GUARD_RUN_PROTECTED_PATHS: never waived.
    extra?: string[];
    // The registration's protected_paths.globs.
    registered?: string[];
    root?: string;
    roots?: string[];
  };
  // The registration requires "labels" but names none: every label change is denied (rule run-config).
  unsure?: boolean;
}

export interface SessionState {
  reminded: Set<string>;
}

export interface CommandEvaluationInput {
  branches?: Record<string, SafeFact | undefined>;
  command: string;
  env?: GuardEnv;
  host?: HostFacts;
  loadedSkills?: Iterable<string>;
  python?: string | null;
  readTool?: boolean;
  refs?: Record<string, SafeFact | undefined>;
  regenerable?: Record<string, boolean | undefined>;
  rules: GuardRules;
  run?: RunFacts | null;
  stack?: StackFact | null;
  state: SessionState;
  tags?: Record<string, TagFact | undefined>;
  worktrees?: Record<string, SafeFact | undefined>;
}

export interface CommandDecision {
  action: "allow" | "ask" | "deny";
  command?: string;
  context?: string;
  reason?: string;
  remind?: boolean;
  rule?: string;
  split?: boolean;
}

export interface EditEvaluationInput {
  loadedSkills?: Iterable<string>;
  path?: unknown;
  rules: GuardRules;
  state: SessionState;
}

export interface RoutingEvaluationInput {
  effort?: unknown;
  model?: unknown;
  rules: GuardRules;
  state: SessionState;
  tool?: string;
  type?: unknown;
}

export interface SpawnEvaluationInput {
  mode?: string;
  resetsAt?: number | string;
  rules: GuardRules;
  usagePercent?: number;
}

export interface SpawnDecision {
  action: "allow" | "warn" | "ask" | "deny";
  level: UsageLevel;
  reason?: string;
}

export interface ExecutableOptions {
  remote?: boolean;
  injected?: boolean;
}
export interface ExecutionContext {
  remote: boolean;
  injected: boolean;
}
export interface PipelinePart {
  code: string;
  vals: string[];
}
export interface Pipeline {
  code: string;
  raw: string;
  parts: PipelinePart[];
  depth: number;
  siblings: number;
  host?: string;
  top: number;
}
export interface PipelineContext {
  depth: number;
  host?: string;
}
export type Variables = Record<string, string | null | undefined>;
export interface FrozenVariables {
  vars: Variables;
  pwd?: string;
}
export interface Segment {
  seg: string;
  code: string;
  words: ShellWord[];
  redirs: ShellWord[];
  dir: string;
  remote: boolean;
  resolve: (path: string) => string;
}
export type GitRun = (...args: string[]) => Promise<string | null | undefined>;
export type ShellRun = (
  argv: string[],
  cwd?: string,
) => Promise<string | null | undefined>;
export interface RelativeSegments {
  // Windows folding (trailing dots and spaces) changed a segment: no exemption applies.
  folded?: boolean;
  segs: string[];
  suffix?: boolean;
}
export type WriteHits = (
  target: string,
  dir: string,
  resolve: (path: string) => string,
  above: boolean,
) => boolean;
export interface GhAction {
  label: boolean;
  unread: boolean;
}
export interface OpenPr {
  number: number;
  headRefName: string;
}
export interface PrBranches {
  headRefName?: string;
  baseRefName?: string;
}

export interface GitFixture {
  main?: boolean;
  prefix?: string;
  status?: string;
  fail?: boolean;
  ahead?: number;
  pr?: string | null;
  inPr?: boolean;
  tip?: string | null;
}
export interface RefFixtures {
  [key: string]: GitFixture | boolean | undefined;
  fail?: boolean;
}
export interface StackFixtureOptions {
  def?: string | null;
  onTop?: string[];
  inDefault?: string[];
  open?: OpenPr[];
  pr?: PrBranches;
  fail?: string | null;
}
export interface CorpusOptions {
  python?: string | null;
  hints?: boolean;
  run?: "registered" | "configured" | "unsure" | "protected" | null;
  stack?: StackFact | null;
  read?: boolean;
}
export type CorpusRow = [
  command: string,
  expected: string,
  bug: string,
  source: string,
  options?: CorpusOptions,
];

export interface OtelAttribute {
  key: string;
  value: { stringValue: string };
}
export interface OtelRecord {
  timeUnixNano: string;
  attributes: OtelAttribute[];
  traceId?: string;
  spanId?: string;
}
export interface OtelPayload {
  resourceLogs: {
    resource: { attributes: OtelAttribute[] };
    scopeLogs: { logRecords: OtelRecord[] }[];
  }[];
}
export interface SentRequest {
  url: string;
  init: {
    body: string;
    headers: Record<string, string>;
    method: string;
    signal: AbortSignal;
  };
}

export type StringValue = string | number | boolean | null | undefined;
