#!/usr/bin/env node
// CI health: run volume, run time, queueing, re-runs and workflow hygiene, for the repos you merged a PR into (all
// owners, every authenticated host). A repo with a failed or truncated query is counted as partial, never read as zeros. Aggregates only; --repos adds a per-repo table for local reading. Runbook: docs/agent-review.md.
import { fileURLToPath } from "node:url";
import { parseRange, ghRunner, hosts, type GhRunner } from "./pr-graph.mjs";

const DAY = 86400000;
const SKIPPED =
  "CI health: skipped (gh is not installed or not authenticated).";
const READING =
  "How to read each figure: .agents/skills/agent-review/references/reading.md (CI health).";

// Flags compare a repo's current window to its previous one; run time p50 stands in for the critical path.
export const MIN_RUNS = 5;
export const GROWTH = 1.2;
const JOB_SAMPLE = 30;
// gh calls in flight at once: well under GitHub's secondary rate limits (100 concurrent, 900 REST points a minute).
export const CONCURRENCY = 6;
const PR_EVENTS = new Set(["pull_request", "pull_request_target"]);
const SAMPLE_EVENTS = new Set([...PR_EVENTS, "merge_group"]);
const BAD = new Set(["failure", "timed_out"]);
const WORKFLOW_FILE = /\.ya?ml$/;

const QUERY = `query($q:String!,$cursor:String){search(query:$q,type:ISSUE,first:50,after:$cursor){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{repository{nameWithOwner defaultBranchRef{name}}}}}}`;

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface WindowsInfo {
  prevFrom: string;
  prevTo: string;
  curFrom: string;
  curTo: string;
}

// Windows by UTC day: current = the last `days` days up to today, previous = the `days` days before that.
export function windows(days: number, now: number): WindowsInfo {
  const end = Math.floor(now / DAY) * DAY;
  const curStart = end - (days - 1) * DAY;
  const prevStart = curStart - days * DAY;
  return {
    prevFrom: day(prevStart),
    prevTo: day(curStart - DAY),
    curFrom: day(curStart),
    curTo: day(end),
  };
}

export const windowOf = (
  date: string,
  w: WindowsInfo,
): "cur" | "prev" | null =>
  date >= w.curFrom && date <= w.curTo
    ? "cur"
    : date >= w.prevFrom && date <= w.prevTo
      ? "prev"
      : null;

// 7-day [from, to] date chunks (inclusive) covering from..to; the runs API returns <= 1000 results per filtered query.
export function dateChunks(from: string, to: string): [string, string][] {
  const out: [string, string][] = [];
  const end = Date.parse(to);
  for (let s = Date.parse(from); s <= end; s += 7 * DAY) {
    out.push([day(s), day(Math.min(s + 6 * DAY, end))]);
  }
  return out;
}

// Wraps a runner so at most n calls run at once; the rest wait in order.
export function limited(runner: GhRunner, n: number): GhRunner {
  let active = 0;
  const queue: {
    args: string[];
    resolve: (val: string) => void;
    reject: (err: unknown) => void;
  }[] = [];
  const next = (): void => {
    if (active >= n || !queue.length) return;
    active++;
    const item = queue.shift();
    if (!item) {
      active--;
      return;
    }
    const { args, resolve, reject } = item;
    runner(args)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      queue.push({ args, resolve, reject });
      next();
    });
}

// Retry-After is seconds or an HTTP date; anything else is null, so the caller backs off instead.
export function retryAfterSeconds(
  v: unknown,
  now: number = Date.now(),
): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const str =
    typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  const at = Date.parse(str);
  return Number.isFinite(at) ? Math.max(Math.ceil((at - now) / 1000), 0) : null;
}

// A failed gh call: the HTTP status and rate-limit headers only, never the command line (it names the repo).
export class GhError extends Error {
  status: number | null;
  detail: string;
  retryAfter: number | null;
  remaining: number | null;
  reset: number | null;

  constructor(
    status: number | null,
    headers: Record<string, string> = {},
    detail = "",
  ) {
    super(
      `gh call failed${status !== null ? ` (HTTP ${String(status)})` : ""}`,
    );
    this.status = status;
    this.detail = detail;
    this.retryAfter = retryAfterSeconds(headers["retry-after"]);
    this.remaining =
      headers["x-ratelimit-remaining"] != null
        ? Number(headers["x-ratelimit-remaining"])
        : null;
    this.reset =
      headers["x-ratelimit-reset"] != null
        ? Number(headers["x-ratelimit-reset"])
        : null;
  }
}

export interface IncludedResponse {
  status: number | null;
  headers: Record<string, string>;
  body: string;
}

// Splits `gh api --include` output into the status, headers and body.
export function parseIncluded(out: unknown): IncludedResponse {
  const text = typeof out === "string" ? out.replace(/\r\n/g, "\n") : "";
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n(?:([\s\S]*?)\n)?\n([\s\S]*)$/.exec(
    text,
  );
  if (!m) return { status: null, headers: {}, body: text };
  const headers: Record<string, string> = {};
  for (const l of (m[2] ?? "").split("\n")) {
    const i = l.indexOf(":");
    if (i > 0)
      headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { status: Number(m[1]), headers, body: m[3] ?? "" };
}

// The default runner: `gh api --include`, so a failure carries its status and Retry-After; other commands pass through.
export async function includeRunner(
  args: string[],
  exec: GhRunner = ghRunner,
): Promise<string> {
  if (args[0] !== "api") return exec(args);
  let out: string;
  try {
    out = await exec(["api", "--include", ...args.slice(1)]);
  } catch (e: unknown) {
    const stdout =
      e && typeof e === "object" && "stdout" in e ? String(e.stdout) : "";
    const p = parseIncluded(stdout);
    let detail = "";
    try {
      const parsedDetail = JSON.parse(p.body) as { message?: string };
      detail = parsedDetail.message ?? "";
    } catch {}
    throw new GhError(p.status, p.headers, detail);
  }
  return parseIncluded(out).body;
}

// Retries a rate-limited (403 with a limit signal, 429) or server (5xx) failure, honouring Retry-After and the
// rate-limit reset when it is near; other failures, and the last attempt, are thrown.
export const TRIES = 4;
export const MAX_WAIT = 120;
const sleep = (s: number): Promise<void> =>
  new Promise((r) => setTimeout(r, s * 1000));

export interface RetryingOptions {
  tries?: number;
  wait?: (s: number) => Promise<void>;
  now?: () => number;
}

export function retrying(
  runner: GhRunner,
  { tries = TRIES, wait = sleep, now = () => Date.now() }: RetryingOptions = {},
): GhRunner {
  return async (args: string[]) => {
    for (let i = 1; ; i++) {
      try {
        return await runner(args);
      } catch (e: unknown) {
        const ghErr = e instanceof GhError ? e : null;
        const status = ghErr?.status ?? null;
        const limit =
          status === 429 ||
          (status === 403 &&
            (ghErr?.retryAfter != null || ghErr?.remaining === 0));
        if (i >= tries || !(limit || (status !== null && status >= 500)))
          throw e;
        const s =
          ghErr &&
          typeof ghErr.retryAfter === "number" &&
          Number.isFinite(ghErr.retryAfter)
            ? ghErr.retryAfter
            : ghErr?.remaining === 0 && ghErr.reset
              ? ghErr.reset - Math.floor(now() / 1000) + 1
              : 2 ** i;
        if (s > MAX_WAIT) throw e;
        await wait(Math.max(s, 1));
      }
    }
  };
}

const gh = (host: string, path: string, ...fields: string[]): string[] => [
  "api",
  "--hostname",
  host,
  "-X",
  "GET",
  path,
  ...fields.flatMap((f) => ["-f", f]),
];
const notFound = (e: unknown): boolean =>
  e instanceof GhError && e.status === 404;

// Counts each failure by kind on `tally`, so a failed query is reported, never read as a zero.
async function attempt<T>(
  fn: () => Promise<T>,
  tally: Record<string, number> | undefined,
  kind: string,
): Promise<T | null> {
  try {
    return await fn();
  } catch {
    console.error("CI health: a query failed; continuing");
    if (tally) tally[kind] = (tally[kind] ?? 0) + 1;
    return null;
  }
}

interface GraphQLRepoNode {
  nameWithOwner: string;
  defaultBranchRef?: { name: string } | null;
}

interface GraphQLReposSearchResponse {
  data: {
    search: {
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes: { repository?: GraphQLRepoNode | null }[];
    };
  };
}

export async function fetchRepos(
  runner: GhRunner,
  host: string,
  from: string,
  to: string,
): Promise<GraphQLRepoNode[]> {
  const out: GraphQLRepoNode[] = [];
  let cursor: string | null = null;
  do {
    const args = [
      "api",
      "graphql",
      "--hostname",
      host,
      "-f",
      `q=author:@me is:pr is:merged merged:${from}..${to}`,
      "-f",
      `query=${QUERY}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const parsed = JSON.parse(await runner(args)) as GraphQLReposSearchResponse;
    const s = parsed.data.search;
    for (const n of s.nodes) {
      if (n.repository) out.push(n.repository);
    }
    cursor = s.pageInfo.hasNextPage ? s.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

export interface WorkflowRunRecord {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  head_sha: string;
  workflow_id: number;
  created_at: string;
  run_started_at: string;
  updated_at: string;
}

interface RunsApiResponse {
  total_count?: number;
  workflow_runs?: WorkflowRunRecord[];
}

// The runs API returns at most 1000 results per filtered query: `truncated` when total_count says more exist.
export const RUNS_CAP = 1000;
export async function fetchRuns(
  runner: GhRunner,
  host: string,
  repo: string,
  from: string,
  to: string,
): Promise<{ runs: WorkflowRunRecord[]; truncated: boolean }> {
  const runs: WorkflowRunRecord[] = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const raw = await runner(
      gh(
        host,
        `repos/${repo}/actions/runs`,
        `created=${from}..${to}`,
        "per_page=100",
        `page=${String(page)}`,
      ),
    );
    const j = JSON.parse(raw) as RunsApiResponse;
    if (page === 1) total = j.total_count ?? 0;
    const list = j.workflow_runs ?? [];
    for (const r of list) {
      const {
        id,
        event,
        status,
        conclusion,
        run_attempt,
        head_sha,
        workflow_id,
        created_at,
        run_started_at,
        updated_at,
      } = r;
      runs.push({
        id,
        event,
        status,
        conclusion,
        run_attempt,
        head_sha,
        workflow_id,
        created_at,
        run_started_at,
        updated_at,
      });
    }
    if (list.length < 100 || page * 100 >= RUNS_CAP)
      return { runs, truncated: total > RUNS_CAP };
  }
}

// A range over the cap is fetched again in smaller parts: a week by day, a day by 6 hours, 6 hours by hour; an hour
// still over the cap counts as truncated. `created` takes dates or ISO timestamps.
const HOUR = 3600000;
const stamp = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 19)}Z`;

export function splitRange(
  from: string,
  to: string,
): [string, string][] | null {
  if (from.length === 10 && from !== to) {
    const days: [string, string][] = [];
    for (let s = Date.parse(from); s <= Date.parse(to); s += DAY) {
      days.push([day(s), day(s)]);
    }
    return days;
  }
  const start = Date.parse(from.length === 10 ? `${from}T00:00:00Z` : from);
  const end = from.length === 10 ? start + DAY : Date.parse(to) + 1000;
  const step = end - start > 6 * HOUR ? 6 * HOUR : HOUR;
  if (end - start <= HOUR) return null;
  const out: [string, string][] = [];
  for (let s = start; s < end; s += step) {
    out.push([stamp(s), stamp(Math.min(s + step, end) - 1000)]);
  }
  return out;
}

export async function fetchChunk(
  runner: GhRunner,
  host: string,
  repo: string,
  from: string,
  to: string,
  tally: Record<string, number>,
): Promise<WorkflowRunRecord[]> {
  const first = await attempt(
    () => fetchRuns(runner, host, repo, from, to),
    tally,
    "runs",
  );
  const parts = first?.truncated ? splitRange(from, to) : null;
  if (!parts) {
    if (first?.truncated) tally.truncated = (tally.truncated ?? 0) + 1;
    return first?.runs ?? [];
  }
  return (
    await Promise.all(
      parts.map(([f, t]) => fetchChunk(runner, host, repo, f, t, tally)),
    )
  ).flat();
}

// Merged PRs by every author, through GraphQL search: the REST search API allows only 30 requests a minute.
const COUNT =
  "query($q:String!){search(query:$q,type:ISSUE,first:1){issueCount}}";
const mergedCount = async (
  runner: GhRunner,
  host: string,
  repo: string,
  from: string,
  to: string,
): Promise<number> => {
  const raw = await runner([
    "api",
    "graphql",
    "--hostname",
    host,
    "-f",
    `q=repo:${repo} is:pr is:merged merged:${from}..${to}`,
    "-f",
    `query=${COUNT}`,
  ]);
  return (JSON.parse(raw) as { data: { search: { issueCount: number } } }).data
    .search.issueCount;
};

const isDone = (r: WorkflowRunRecord): boolean => r.status === "completed";

interface JobsApiResponse {
  jobs?: {
    started_at?: string;
    created_at?: string;
    conclusion?: string;
  }[];
}

// Queue wait of sampled jobs: the most recent completed PR / merge-group runs, started_at - created_at per non-skipped job.
export async function sampleWaits(
  runner: GhRunner,
  host: string,
  repo: string,
  runs: WorkflowRunRecord[],
  tally: Record<string, number>,
): Promise<number[]> {
  const picked = runs
    .filter((r) => isDone(r) && SAMPLE_EVENTS.has(r.event))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, JOB_SAMPLE);
  const waits: number[] = [];
  const pages = await Promise.all(
    picked.map((r) =>
      attempt<JobsApiResponse>(
        async () => {
          const raw = await runner(
            gh(
              host,
              `repos/${repo}/actions/runs/${String(r.id)}/jobs`,
              "per_page=100",
            ),
          );
          return JSON.parse(raw) as JobsApiResponse;
        },
        tally,
        "jobs",
      ),
    ),
  );
  for (const j of pages) {
    for (const job of j?.jobs ?? []) {
      if (job.started_at && job.created_at && job.conclusion !== "skipped") {
        waits.push(Date.parse(job.started_at) - Date.parse(job.created_at));
      }
    }
  }
  return waits;
}

// Flake proxy: a run that passed on a re-run whose previous attempt (same head SHA) failed.
export async function countFlakes(
  runner: GhRunner,
  host: string,
  repo: string,
  runs: WorkflowRunRecord[],
  tally: Record<string, number>,
): Promise<number> {
  const reruns = runs.filter(
    (r) => isDone(r) && r.run_attempt > 1 && r.conclusion === "success",
  );
  const prior = await Promise.all(
    reruns.map((r) =>
      attempt<{ conclusion?: string }>(
        async () => {
          const raw = await runner(
            gh(
              host,
              `repos/${repo}/actions/runs/${String(r.id)}/attempts/${String(r.run_attempt - 1)}`,
            ),
          );
          return JSON.parse(raw) as { conclusion?: string };
        },
        tally,
        "attempts",
      ),
    ),
  );
  return prior.filter((a) => a?.conclusion === "failure").length;
}

export interface WorkflowFile {
  path: string;
  text: string;
}

interface ContentsApiItem {
  type: string;
  name: string;
  path: string;
  content?: string;
}

// A 404 is "no workflows directory"; any other failure is counted. A file over 1 MB comes back without content
// (the contents API limit) and is counted as skipped, not dropped.
export async function fetchWorkflows(
  runner: GhRunner,
  host: string,
  repo: string,
  tally: Record<string, number> = {},
): Promise<{ files: WorkflowFile[]; tooLarge: number }> {
  let list: unknown;
  try {
    list = JSON.parse(
      await runner(gh(host, `repos/${repo}/contents/.github/workflows`)),
    );
  } catch (e: unknown) {
    if (notFound(e)) return { files: [], tooLarge: 0 };
    console.error("CI health: a query failed; continuing");
    tally.workflows = (tally.workflows ?? 0) + 1;
    return { files: [], tooLarge: 0 };
  }
  const wanted = (
    Array.isArray(list) ? (list as ContentsApiItem[]) : []
  ).filter((f) => f.type === "file" && WORKFLOW_FILE.test(f.name));
  const got = await Promise.all(
    wanted.map((f) =>
      attempt<ContentsApiItem>(
        async () => {
          const raw = await runner(
            gh(host, `repos/${repo}/contents/${f.path}`),
          );
          return JSON.parse(raw) as ContentsApiItem;
        },
        tally,
        "workflows",
      ),
    ),
  );
  const files: WorkflowFile[] = [];
  let tooLarge = 0;
  wanted.forEach((f, i) => {
    const res = got[i];
    if (res?.content) {
      files.push({
        path: f.path,
        text: Buffer.from(res.content, "base64").toString("utf8"),
      });
    } else if (res) {
      tooLarge++;
    }
  });
  return { files, tooLarge };
}

// A 404 means no rules on the branch, and a 403 asking for a plan upgrade means the plan has no branch rules (so no
// merge queue) for a private repo; any other failure is counted.
const noRulesOnPlan = (e: unknown): boolean =>
  e instanceof GhError &&
  e.status === 403 &&
  /upgrade to github pro|make this repository public/i.test(e.detail);

export async function hasMergeQueue(
  runner: GhRunner,
  host: string,
  repo: string,
  branch: string | undefined,
  tally: Record<string, number> = {},
): Promise<boolean> {
  if (!branch) return false;
  try {
    const raw = await runner(
      gh(host, `repos/${repo}/rules/branches/${branch}`),
    );
    const rules = JSON.parse(raw) as { type?: string }[];
    return Array.isArray(rules) && rules.some((r) => r.type === "merge_queue");
  } catch (e: unknown) {
    if (notFound(e) || noRulesOnPlan(e)) return false;
    console.error("CI health: a query failed; continuing");
    tally.queue = (tally.queue ?? 0) + 1;
    return false;
  }
}

export interface MeasuredRepoWindow {
  runs: WorkflowRunRecord[];
  mergedPrs: number | null;
  waits: number[];
  flakes: number | null;
}

export interface MeasuredRepo {
  key: string;
  prev: MeasuredRepoWindow;
  cur: MeasuredRepoWindow;
  files: WorkflowFile[];
  tooLarge?: number;
  hasQueue: boolean;
  failures?: Record<string, number>;
  truncated?: number;
}

async function measure(
  runner: GhRunner,
  host: string,
  name: string,
  branch: string | undefined,
  w: WindowsInfo,
): Promise<MeasuredRepo> {
  const tally: Record<string, number> = {};
  const raw = new Map<number, WorkflowRunRecord>();
  const chunkLists = await Promise.all(
    dateChunks(w.prevFrom, w.curTo).map(([from, to]) =>
      fetchChunk(runner, host, name, from, to, tally),
    ),
  );
  for (const list of chunkLists) {
    for (const r of list) raw.set(r.id, r);
  }
  const byWin: { prev: WorkflowRunRecord[]; cur: WorkflowRunRecord[] } = {
    prev: [],
    cur: [],
  };
  for (const r of raw.values()) {
    const winName = windowOf(r.created_at.slice(0, 10), w);
    if (winName) byWin[winName].push(r);
  }
  const win = async (
    runs: WorkflowRunRecord[],
    from: string,
    to: string,
  ): Promise<MeasuredRepoWindow> => {
    const [mergedPrs, waits, flakes] = await Promise.all([
      attempt(() => mergedCount(runner, host, name, from, to), tally, "merged"),
      sampleWaits(runner, host, name, runs, tally),
      countFlakes(runner, host, name, runs, tally),
    ]);
    return { runs, mergedPrs, waits, flakes };
  };
  const [prev, cur, wf, hasQueue] = await Promise.all([
    win(byWin.prev, w.prevFrom, w.prevTo),
    win(byWin.cur, w.curFrom, w.curTo),
    fetchWorkflows(runner, host, name, tally),
    hasMergeQueue(runner, host, name, branch, tally),
  ]);
  const { truncated = 0, ...failures } = tally;
  return {
    key: `${host}/${name}`,
    prev,
    cur,
    files: wf.files,
    tooLarge: wf.tooLarge,
    hasQueue,
    failures,
    truncated,
  };
}

export interface CollectedRepos extends Array<MeasuredRepo> {
  discoveryFailed?: number;
}

// Repos are measured concurrently through one limited, retrying runner; progress goes to stderr, without repo names.
export async function collect(
  runner: GhRunner,
  days: number,
  now = Date.now(),
  concurrency = CONCURRENCY,
  retry: RetryingOptions = {},
): Promise<CollectedRepos | null> {
  const hs = await hosts(runner);
  if (!hs.length) return null;
  const w = windows(days, now);
  const run = limited(retrying(runner, retry), concurrency);
  const out: CollectedRepos = [];
  out.discoveryFailed = 0;
  for (const host of hs) {
    const found = new Map<string, string | undefined>();
    const tally: Record<string, number> = {};
    const lists = await Promise.all(
      dateChunks(w.prevFrom, w.curTo).map(([from, to]) =>
        attempt(() => fetchRepos(run, host, from, to), tally, "discovery"),
      ),
    );
    out.discoveryFailed = (out.discoveryFailed ?? 0) + (tally.discovery ?? 0);
    for (const list of lists) {
      for (const r of list ?? [])
        found.set(r.nameWithOwner, r.defaultBranchRef?.name);
    }
    let done = 0;
    console.error(`CI health: measuring ${String(found.size)} repos on a host`);
    const measuredList = await Promise.all(
      [...found].map(async ([name, branch]) => {
        const rec = await measure(run, host, name, branch, w);
        console.error(
          `CI health: ${String(++done)}/${String(found.size)} repos measured`,
        );
        return rec;
      }),
    );
    out.push(...measuredList);
  }
  return out;
}

// nearest-rank percentile; null for an empty list
export function percentile(list: number[], p: number): number | null {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.ceil(p * s.length) - 1] ?? null;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m ${String(s % 60)}s`;
  return `${String(Math.floor(s / 3600))}h ${String(Math.floor((s % 3600) / 60))}m`;
}

const ms = (a: string, b: string): number => Date.parse(a) - Date.parse(b);
const sum = <T,>(list: T[], k: keyof T): number =>
  list.reduce((n, x) => n + (Number(x[k]) || 0), 0);
const ratio = (
  n: number | null | undefined,
  d: number | null | undefined,
): number | null => (d && n != null ? n / d : null);

export interface WindowStats {
  mergedPrs: number | null;
  prRuns: number;
  mgRuns: number;
  runTimes: number[];
  greenTimes: number[];
  waits: number[];
  completed: number;
  gated: number;
  cancelled: number;
  failed: number;
  reruns: number;
  flakes: number | null;
  mgCompleted: number;
  mgEjected: number;
  skipped: number;
  allCompleted: number;
  prRunsPerPr: number | null;
  mgRunsPerPr: number | null;
  runP50: number | null;
  runP90: number | null;
  greenP50: number | null;
  greenP90: number | null;
  waitP50: number | null;
  waitP90: number | null;
  cancelledShare: number | null;
  failureShare: number | null;
  rerunShare: number | null;
  flakeShare: number | null;
  ejectRate: number | null;
  skippedNoise: number | null;
}

// Raw tallies of one window; sums across repos are taken here, ratios only in derive().
export function windowStats(
  runs: WorkflowRunRecord[],
  mergedPrs: number | null,
  waits: number[],
  flakes: number | null,
): WindowStats {
  const kept = runs.filter((r) => r.conclusion !== "skipped"); // skipped runs count only toward skipped noise
  const done = kept.filter(isDone);
  const mg = done.filter((r) => r.event === "merge_group");
  const raw = {
    mergedPrs,
    prRuns: kept.filter((r) => PR_EVENTS.has(r.event)).length, // pull_request and pull_request_target
    mgRuns: kept.filter((r) => r.event === "merge_group").length,
    runTimes: done
      .map((r) => ms(r.updated_at, r.run_started_at))
      .filter((x) => x >= 0), // completed, non-skipped
    greenTimes: done
      .filter((r) => r.conclusion === "success")
      .map((r) => ms(r.updated_at, r.created_at))
      .filter((x) => x >= 0), // queue-to-green, includes re-run attempts
    waits,
    completed: done.length,
    gated: done.filter((r) => SAMPLE_EVENTS.has(r.event)).length, // PR + merge-group, the flag guard
    cancelled: done.filter((r) => r.conclusion === "cancelled").length,
    failed: done.filter((r) => r.conclusion !== null && BAD.has(r.conclusion))
      .length,
    reruns: done.filter((r) => r.run_attempt > 1).length,
    flakes,
    mgCompleted: mg.length,
    mgEjected: mg.filter(
      (r) =>
        (r.conclusion !== null && BAD.has(r.conclusion)) ||
        r.conclusion === "cancelled",
    ).length,
    skipped: runs.filter((r) => isDone(r) && r.conclusion === "skipped").length,
    allCompleted: runs.filter(isDone).length,
  };
  return derive(raw);
}

const LISTS = ["runTimes", "greenTimes", "waits"] as const;
const COUNTS = [
  "mergedPrs",
  "prRuns",
  "mgRuns",
  "completed",
  "gated",
  "cancelled",
  "failed",
  "reruns",
  "flakes",
  "mgCompleted",
  "mgEjected",
  "skipped",
  "allCompleted",
] as const;

interface RawStats {
  mergedPrs: number | null;
  prRuns: number;
  mgRuns: number;
  runTimes: number[];
  greenTimes: number[];
  waits: number[];
  completed: number;
  gated: number;
  cancelled: number;
  failed: number;
  reruns: number;
  flakes: number | null;
  mgCompleted: number;
  mgEjected: number;
  skipped: number;
  allCompleted: number;
}

function derive(raw: RawStats): WindowStats {
  return {
    ...raw,
    prRunsPerPr: ratio(raw.prRuns, raw.mergedPrs),
    mgRunsPerPr: ratio(raw.mgRuns, raw.mergedPrs),
    runP50: percentile(raw.runTimes, 0.5),
    runP90: percentile(raw.runTimes, 0.9),
    greenP50: percentile(raw.greenTimes, 0.5),
    greenP90: percentile(raw.greenTimes, 0.9),
    waitP50: percentile(raw.waits, 0.5),
    waitP90: percentile(raw.waits, 0.9),
    cancelledShare: ratio(raw.cancelled, raw.completed),
    failureShare: ratio(raw.failed, raw.completed),
    rerunShare: ratio(raw.reruns, raw.completed),
    flakeShare: ratio(raw.flakes, raw.completed),
    ejectRate: ratio(raw.mgEjected, raw.mgCompleted),
    skippedNoise: ratio(raw.skipped, raw.allCompleted),
  };
}

export function mergeStats(list: WindowStats[]): WindowStats {
  const countsMap: Record<string, number> = {};
  for (const k of COUNTS) countsMap[k] = sum(list, k);
  const listsMap: Record<string, number[]> = {};
  for (const k of LISTS) listsMap[k] = list.flatMap((x) => x[k]);

  const raw: RawStats = {
    mergedPrs: countsMap.mergedPrs ?? 0,
    prRuns: countsMap.prRuns ?? 0,
    mgRuns: countsMap.mgRuns ?? 0,
    runTimes: listsMap.runTimes ?? [],
    greenTimes: listsMap.greenTimes ?? [],
    waits: listsMap.waits ?? [],
    completed: countsMap.completed ?? 0,
    gated: countsMap.gated ?? 0,
    cancelled: countsMap.cancelled ?? 0,
    failed: countsMap.failed ?? 0,
    reruns: countsMap.reruns ?? 0,
    flakes: countsMap.flakes ?? 0,
    mgCompleted: countsMap.mgCompleted ?? 0,
    mgEjected: countsMap.mgEjected ?? 0,
    skipped: countsMap.skipped ?? 0,
    allCompleted: countsMap.allCompleted ?? 0,
  };
  return derive(raw);
}

export interface WindowFlags {
  criticalPathGrew: boolean;
  rerunGrew: boolean;
}

// Relative flags, no fixed minute budget: both windows need MIN_RUNS gated runs.
export function flags(prev: WindowStats, cur: WindowStats): WindowFlags {
  const enough = prev.gated >= MIN_RUNS && cur.gated >= MIN_RUNS;
  return {
    criticalPathGrew:
      enough &&
      prev.runP50 !== null &&
      prev.runP50 > 0 &&
      cur.runP50 !== null &&
      cur.runP50 >= prev.runP50 * GROWTH,
    rerunGrew:
      enough &&
      cur.rerunShare !== null &&
      prev.rerunShare !== null &&
      cur.rerunShare > prev.rerunShare,
  };
}

// ---- workflow audit: a line parser over the YAML text (no YAML library), good enough for GitHub workflow files ----
const clean = (l: string): string => l.replace(/(^|\s)#.*$/, "").trimEnd();
const indent = (l: string): number => /^ */.exec(l)?.[0].length ?? 0;
const blank = (l: string): boolean => !l.trim();

// lines under a column-0 `key:`, and its inline value
function block(
  lines: string[],
  key: string,
): { inline: string; children: string[] } | null {
  const re = new RegExp(`^["']?(?:${key})["']?\\s*:(.*)$`);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return null;
  const children: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (!blank(l) && indent(l) === 0 && !l.startsWith("-")) break;
    children.push(l);
  }
  const match = re.exec(lines[i] ?? "");
  return {
    inline: (match?.[1] ?? "").trim(),
    children: children.filter((l) => !blank(l)),
  };
}

// trigger name -> its child lines
function triggers(lines: string[]): Map<string, string[]> {
  const on = block(lines, "on");
  const out = new Map<string, string[]>();
  if (!on) return out;
  if (on.inline) {
    for (const n of on.inline.match(/[a-z_]+/g) ?? []) out.set(n, []);
    return out;
  }
  const base = Math.min(...on.children.map(indent));
  let cur: string | null = null;
  for (const l of on.children) {
    const m = indent(l) === base ? /^(?:-\s*)?([a-z_]+)/.exec(l.trim()) : null;
    if (m) out.set((cur = m[1] ?? ""), []);
    else if (cur) out.get(cur)?.push(l);
  }
  return out;
}

interface ParsedJob {
  reusable: boolean;
  timeout: boolean;
  concurrency: boolean;
  aggregate: boolean;
}

function jobsOf(lines: string[]): ParsedJob[] {
  const jobs = block(lines, "jobs");
  if (!jobs?.children.length) return [];
  const base = Math.min(...jobs.children.map(indent));
  const out: string[][] = [];
  for (const l of jobs.children) {
    if (indent(l) === base && /^["']?[\w.-]+["']?\s*:/.test(l.trim()))
      out.push([]);
    else out.at(-1)?.push(l);
  }
  return out.map((body): ParsedJob => {
    const bi = body.length ? Math.min(...body.map(indent)) : 0;
    const direct = (k: string): number =>
      body.findIndex((l) => indent(l) === bi && l.trim().startsWith(`${k}:`));
    const at = direct("if");
    let cond = "";
    if (at >= 0) {
      for (const l of body.slice(at)) {
        if (l !== body[at] && indent(l) <= bi) break;
        cond += `${l}\n`;
      }
    }
    return {
      reusable: direct("uses") >= 0,
      timeout: direct("timeout-minutes") >= 0,
      concurrency: direct("concurrency") >= 0,
      aggregate: direct("needs") >= 0 && cond.includes("always()"),
    };
  });
}

export interface WorkflowAudit {
  workflows: number;
  concurrency: number;
  prWorkflows: number;
  prCancel: number;
  jobs: number;
  reusable: number;
  timeouts: number;
  mergeGroup: number;
  filtered: number;
  aggregate: number;
  caches: number;
  refs: number;
  pinned: number;
  permissions: number;
  queueWithoutMergeGroup?: boolean;
  pathFilterNoAggregate?: boolean;
  tooLarge?: number;
}

export function auditWorkflows(
  files: WorkflowFile[],
  hasQueue: boolean,
): WorkflowAudit {
  const a: WorkflowAudit = {
    workflows: files.length,
    concurrency: 0,
    prWorkflows: 0,
    prCancel: 0,
    jobs: 0,
    reusable: 0,
    timeouts: 0,
    mergeGroup: 0,
    filtered: 0,
    aggregate: 0,
    caches: 0,
    refs: 0,
    pinned: 0,
    permissions: 0,
  };
  for (const f of files) {
    const lines = f.text.split("\n").map(clean);
    const trig = triggers(lines);
    const jobs = jobsOf(lines);
    if (
      lines.some((l) => /^concurrency\s*:/.test(l)) ||
      jobs.some((j) => j.concurrency)
    )
      a.concurrency++;
    if (trig.has("pull_request")) {
      a.prWorkflows++;
      if (
        lines.some((l) => /^\s*cancel-in-progress\s*:\s*(?!false\b)\S/.test(l))
      )
        a.prCancel++;
    }
    a.jobs += jobs.length;
    a.reusable += jobs.filter((j) => j.reusable).length;
    a.timeouts += jobs.filter((j) => !j.reusable && j.timeout).length;
    if (trig.has("merge_group")) a.mergeGroup++;
    if (
      ["pull_request", "push", "merge_group"].some((t) =>
        (trig.get(t) ?? []).some((l) => /^\s*paths(-ignore)?\s*:/.test(l)),
      )
    ) {
      a.filtered++;
    }
    a.aggregate += jobs.filter((j) => j.aggregate).length;
    if (
      lines.some(
        (l) =>
          /uses\s*:\s*["']?actions\/cache[/@]/.test(l) ||
          /^\s*cache\s*:\s*\S/.test(l),
      )
    ) {
      a.caches++;
    }
    for (const l of lines) {
      const m = /\buses\s*:\s*["']?([^\s"']+)/.exec(l);
      if (
        !m?.[1] ||
        m[1].startsWith("./") ||
        m[1].startsWith("docker://") ||
        !m[1].includes("@")
      ) {
        continue;
      }
      a.refs++;
      if (/@[0-9a-f]{40}$/.test(m[1])) a.pinned++;
    }
    if (lines.some((l) => /^permissions\s*:/.test(l))) a.permissions++;
  }
  a.queueWithoutMergeGroup = hasQueue && a.mergeGroup === 0;
  a.pathFilterNoAggregate = a.filtered > 0 && a.aggregate === 0;
  return a;
}

const AUDIT_SUMS = [
  "workflows",
  "concurrency",
  "prWorkflows",
  "prCancel",
  "jobs",
  "reusable",
  "timeouts",
  "mergeGroup",
  "filtered",
  "aggregate",
  "caches",
  "refs",
  "pinned",
  "permissions",
] as const;

export function mergeAudits(list: WorkflowAudit[]): WorkflowAudit {
  const out: Record<string, number> = {};
  for (const k of AUDIT_SUMS) out[k] = sum(list, k);
  return {
    workflows: out.workflows ?? 0,
    concurrency: out.concurrency ?? 0,
    prWorkflows: out.prWorkflows ?? 0,
    prCancel: out.prCancel ?? 0,
    jobs: out.jobs ?? 0,
    reusable: out.reusable ?? 0,
    timeouts: out.timeouts ?? 0,
    mergeGroup: out.mergeGroup ?? 0,
    filtered: out.filtered ?? 0,
    aggregate: out.aggregate ?? 0,
    caches: out.caches ?? 0,
    refs: out.refs ?? 0,
    pinned: out.pinned ?? 0,
    permissions: out.permissions ?? 0,
    tooLarge: list.reduce((n, a) => n + (a.tooLarge ?? 0), 0),
    queueWithoutMergeGroup: list.some((a) => a.queueWithoutMergeGroup),
    pathFilterNoAggregate: list.some((a) => a.pathFilterNoAggregate),
  };
}

// A repo with any failed or truncated query is partial: it is left out of the figures and flags, and counted.
const failedCount = (r: MeasuredRepo): number =>
  Object.values(r.failures ?? {}).reduce((n, x) => n + x, 0);
export const isPartial = (r: MeasuredRepo): boolean =>
  failedCount(r) > 0 || (r.truncated ?? 0) > 0;

export interface AnalyzedRepoRecord {
  prev: WindowStats;
  cur: WindowStats;
  audit: WorkflowAudit;
  partial: boolean;
  failed: number;
  truncated: number;
  criticalPathGrew: boolean;
  rerunGrew: boolean;
}

export interface AnalysisResult {
  repos: number;
  partial: number;
  failedQueries: number;
  discoveryFailed: number;
  failedByKind: [string, number][];
  truncated: number;
  prev: WindowStats;
  cur: WindowStats;
  audit: WorkflowAudit;
  criticalPathGrew: number;
  rerunGrew: number;
  perRepo: Record<string, AnalyzedRepoRecord>;
}

export function analyze(repos: CollectedRepos): AnalysisResult {
  const perRepo: Record<string, AnalyzedRepoRecord> = {};
  for (const r of repos) {
    const partial = isPartial(r);
    const prev = windowStats(
      r.prev.runs,
      r.prev.mergedPrs,
      r.prev.waits,
      r.prev.flakes,
    );
    const cur = windowStats(
      r.cur.runs,
      r.cur.mergedPrs,
      r.cur.waits,
      r.cur.flakes,
    );
    const audit: WorkflowAudit = {
      ...auditWorkflows(r.files, r.hasQueue),
      tooLarge: r.tooLarge ?? 0,
    };
    perRepo[r.key] = {
      prev,
      cur,
      audit,
      partial,
      failed: failedCount(r),
      truncated: r.truncated ?? 0,
      ...(partial
        ? { criticalPathGrew: false, rerunGrew: false }
        : flags(prev, cur)),
    };
  }
  const all = Object.values(perRepo);
  const rows = all.filter((r) => !r.partial);
  const failedMap = repos.reduce<Record<string, number>>(
    (k, r) => {
      for (const [n, c] of Object.entries(r.failures ?? {}))
        k[n] = (k[n] ?? 0) + c;
      return k;
    },
    repos.discoveryFailed ? { discovery: repos.discoveryFailed } : {},
  );

  return {
    repos: rows.length,
    partial: all.length - rows.length,
    failedQueries:
      all.reduce((n, r) => n + r.failed, 0) + (repos.discoveryFailed ?? 0),
    discoveryFailed: repos.discoveryFailed ?? 0,
    failedByKind: Object.entries(failedMap).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    truncated: all.reduce((n, r) => n + r.truncated, 0),
    prev: mergeStats(rows.map((r) => r.prev)),
    cur: mergeStats(rows.map((r) => r.cur)),
    audit: mergeAudits(rows.map((r) => r.audit)),
    criticalPathGrew: rows.filter((r) => r.criticalPathGrew).length,
    rerunGrew: rows.filter((r) => r.rerunGrew).length,
    perRepo,
  };
}

const one = (x: number | null | undefined): string =>
  x == null ? "-" : x.toFixed(1);
const share = (
  n: number | null | undefined,
  d: number | null | undefined,
): string =>
  d && n != null ? `${String(Math.round((100 * n) / d))}% (${String(n)})` : "-";
const shareOf = (
  n: number | null | undefined,
  d: number | null | undefined,
): string =>
  d && n != null
    ? `${String(Math.round((100 * n) / d))}% (${String(n)}/${String(d)})`
    : "-";
const pair = (
  a: number | null | undefined,
  b: number | null | undefined,
): string => `${duration(a)} / ${duration(b)}`;

export function report(agg: AnalysisResult, range: string): string {
  const row = (
    name: string,
    f: (s: WindowStats) => string | number | null,
  ): string => {
    const p = f(agg.prev);
    const c = f(agg.cur);
    return `| ${name} | ${p != null ? String(p) : "-"} | ${c != null ? String(c) : "-"} |`;
  };
  const a = agg.audit;
  const auditRows: [string, string][] = [
    ["Workflows", String(a.workflows)],
    [
      "Workflow files skipped (over 1 MB, the contents API limit)",
      String(a.tooLarge ?? 0),
    ],
    ["Concurrency set", shareOf(a.concurrency, a.workflows)],
    [
      "PR workflows cancelling superseded runs",
      shareOf(a.prCancel, a.prWorkflows),
    ],
    ["Jobs with timeout-minutes", shareOf(a.timeouts, a.jobs - a.reusable)],
    [
      "Repos with a merge queue and no merge_group trigger",
      String(a.queueWithoutMergeGroup ? 1 : 0),
    ],
    [
      "Repos with trigger path filters and no aggregate check",
      String(a.pathFilterNoAggregate ? 1 : 0),
    ],
    ["Workflows with a cache", shareOf(a.caches, a.workflows)],
    ["Action refs pinned by SHA", shareOf(a.pinned, a.refs)],
    [
      "Workflows with top-level permissions",
      shareOf(a.permissions, a.workflows),
    ],
  ];
  return [
    `## CI health (last ${range} vs the ${range} before, repos you merged a PR into, every host gh can reach)`,
    "",
    "| Measure | Previous | Current |",
    "|---|---|---|",
    `| Repos measured | ${String(agg.repos)} | ${String(agg.repos)} |`,
    `| Repos left out as partial (a query failed or hit the 1000-run cap) | - | ${String(agg.partial)} |`,
    `| Queries failed after retries | - | ${String(agg.failedQueries)}${
      agg.failedByKind.length
        ? ` (${agg.failedByKind.map(([k, n]) => `${k} ${String(n)}`).join(", ")})`
        : ""
    } |`,
    `| Run queries truncated at 1000 runs (one hour over the cap) | - | ${String(agg.truncated)} |`,
    row("Merged PRs (all authors, in the measured repos)", (s) => s.mergedPrs),
    row("PR runs per merged PR", (s) => one(s.prRunsPerPr)),
    row("Merge-group runs per merged PR", (s) => one(s.mgRunsPerPr)),
    row("Run time p50 / p90", (s) => pair(s.runP50, s.runP90)),
    row("Queue-to-green p50 / p90", (s) => pair(s.greenP50, s.greenP90)),
    row("Queue wait p50 / p90 (sampled jobs)", (s) =>
      pair(s.waitP50, s.waitP90),
    ),
    row("Cancelled share", (s) => share(s.cancelled, s.completed)),
    row("Failure share", (s) => share(s.failed, s.completed)),
    row("Re-run share", (s) => share(s.reruns, s.completed)),
    row("Flake proxy (failed, then passed on a re-run)", (s) =>
      share(s.flakes, s.completed),
    ),
    row("Merge-group eject rate", (s) => share(s.mgEjected, s.mgCompleted)),
    row("Skipped-run noise", (s) => share(s.skipped, s.allCompleted)),
    `| Repos whose critical path grew | - | ${String(agg.criticalPathGrew)} |`,
    `| Repos whose re-run rate grew | - | ${String(agg.rerunGrew)} |`,
    "",
    "### Workflow audit (current)",
    "",
    "| Check | Value |",
    "|---|---|",
    ...auditRows.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    READING,
    "",
  ].join("\n");
}

const arrow = (a: string, b: string): string => `${a} → ${b}`;
const pc = (x: number | null): string =>
  x == null ? "-" : `${String(Math.round(100 * x))}%`;

export function repoTable(agg: AnalysisResult): string {
  const rows = Object.entries(agg.perRepo)
    .sort((a, b) => b[1].cur.completed - a[1].cur.completed)
    .map(([k, r]) => {
      if (r.partial)
        return `| ${k} | unknown | unknown | unknown | unknown | partial: ${String(r.failed)} failed, ${String(r.truncated)} truncated |`;
      const f = [
        r.criticalPathGrew && "critical path",
        r.rerunGrew && "re-run",
        r.audit.queueWithoutMergeGroup && "queue without merge_group",
        r.audit.pathFilterNoAggregate && "path filters without aggregate",
      ].filter(Boolean);
      return `| ${k} | ${r.cur.mergedPrs != null ? String(r.cur.mergedPrs) : "-"} | ${String(r.cur.completed)} | ${arrow(
        duration(r.prev.runP50),
        duration(r.cur.runP50),
      )} | ${arrow(pc(r.prev.rerunShare), pc(r.cur.rerunShare))} | ${f.join(", ") || "-"} |`;
    });
  return [
    "Local detail: never paste into a PR, issue or committed file.",
    "",
    "| Repo | Merged PRs | Runs | Run time p50 prev→cur | Re-run share prev→cur | Flags |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

// A gh failure message holds the command line, which names a repo: print the message only for a bad --range.
export const errorLine = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return msg.startsWith("bad --range")
    ? msg
    : "CI health: failed with an unexpected error (detail withheld, it may name a repo)";
};

export async function main(
  argv: string[],
  runner: GhRunner = includeRunner,
  now = Date.now(),
): Promise<void> {
  const i = argv.indexOf("--range");
  const range = i >= 0 ? (argv[i + 1] ?? "30d") : "30d";
  const days = parseRange(range);
  const repos = await collect(runner, days, now);
  if (!repos) {
    console.log(SKIPPED);
    return;
  }
  const agg = analyze(repos);
  process.stdout.write(report(agg, range));
  if (argv.includes("--repos")) process.stdout.write(`\n${repoTable(agg)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), includeRunner).catch((e: unknown) => {
    console.error(errorLine(e));
    process.exit(1);
  });
}
