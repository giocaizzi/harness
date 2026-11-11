export interface MemoryFrontmatter {
  body: string;
  raw: string;
  [key: string]: string | undefined;
}

export interface LintOptions {
  repo?: string;
}

export type RemoteScope = "mine" | "all";
export type Verdict = "delete" | "archive" | "list" | "keep";
export type ItemKind =
  | "local-branch"
  | "remote-branch"
  | "archive-ref"
  | "stash"
  | "unregistered-dir";

export interface SweepConfig {
  apply: boolean;
  auto: boolean;
  json: boolean;
  stores: boolean;
  repo: string;
  remoteScope: RemoteScope;
  now: number;
  minAgeSeconds: number;
  idleSeconds: number;
  archiveSeconds: number;
  keep: RegExp[];
  roots: string[];
  gitleaks: string;
  prsFile: string | undefined;
  ghUser: string | undefined;
  visibility: string | undefined;
  privateConfig: string | undefined;
}

export interface Pr {
  number: number;
  state: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  closedAt: number | undefined;
  mergedAt: number | undefined;
  updatedAt: number | undefined;
  author: string;
}

/** One thing the sweep looked at, and what it will do (or did) with it. */
export interface Item {
  kind: ItemKind;
  name: string;
  oid: string;
  verdict: Verdict;
  reason: string;
  /** Origin ref that holds a local tip, or the ref a remote item names. */
  ref?: string;
  worktree?: string;
  pr?: number;
  size?: string;
  commands?: string;
  /** After --apply: whether the planned action happened, and why not. */
  done?: boolean;
  note?: string;
}

export interface LogLine {
  time: string;
  kind: string;
  name: string;
  oid: string;
  reason: string;
  restore: string;
}

export interface Counts {
  localBranches: number;
  worktrees: number;
  archived: number;
  remoteBranches: number;
  expiredArchives: number;
  listed: number;
}

export interface Report {
  repo: string;
  defaultBranch: string;
  apply: boolean;
  offline: boolean;
  items: Item[];
  counts: Counts;
  summary: string;
  log: string;
}

export type Probe = (cmd: string, args: string[]) => string | undefined;

export interface StoreInput {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  probe: Probe;
}

/** One per-user shared store: where it lives and how to trim it. */
export interface Store {
  id: string;
  name: string;
  path: string | undefined;
  trim: string;
  note: string;
}

export interface StoreSize {
  exists: boolean;
  bytes: number;
  capped: boolean;
}

export interface StoreReport extends Store, StoreSize {}

export interface FreeSpace {
  path: string;
  bytes: number;
  floorBytes: number;
}

export interface StoresReport {
  free: FreeSpace;
  stores: StoreReport[];
}
