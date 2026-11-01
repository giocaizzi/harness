#!/usr/bin/env node
// PR graph: how consistently dependent PRs are stacked, plus PR size and pace, across every repo `gh` can reach
// (all owners, every authenticated host). Aggregates only; --repos adds a per-repo table for local reading. Runbook: docs/agent-review.md.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const DAY = 86400000;
const SKIPPED = "PR graph: skipped (gh is not installed or not authenticated).";
const MANIFESTS = new Set([
  "package.json",
  "plugin.json",
  "marketplace.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "VERSION",
  ".release-please-manifest.json",
  "CHANGELOG.md",
]);

export const HOT_SHARE = 0.2;
export const HOT_MIN = 3;

const QUERY = `query($q:String!,$cursor:String){search(query:$q,type:ISSUE,first:50,after:$cursor){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{number baseRefName headRefName createdAt closedAt mergedAt additions deletions repository{nameWithOwner defaultBranchRef{name}} files(first:100){totalCount nodes{path}}}}}}`;

export type GhRunner = (args: string[]) => Promise<string>;

export interface GraphQLPrNode {
  number: number;
  baseRefName: string;
  headRefName: string;
  createdAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  additions?: number;
  deletions?: number;
  repository: {
    nameWithOwner: string;
    defaultBranchRef?: { name: string } | null;
  };
  files?: {
    totalCount: number;
    nodes: { path: string }[];
  };
}

interface GraphQLSearchResponse {
  data: {
    search: {
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes: (GraphQLPrNode | null)[];
    };
  };
}

interface HostAccount {
  state?: string;
  active?: boolean;
}

interface HostsStatusResponse {
  hosts?: Record<string, HostAccount[]>;
}

export interface CollectedPr {
  repo: string;
  base: string;
  head: string;
  defaultBranch?: string;
  created: number;
  closed: number | null;
  merged: number | null;
  lines: number;
  paths: string[];
  fileCount: number;
}

export interface LinesQuantiles {
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

export interface RepoPrGraph {
  prs: number;
  stacked: number;
  stackedPairs: number;
  overlapPairs: number;
  refinedPairs: number;
}

export interface AggregatedPrGraph {
  perDay: number;
  linesQ: LinesQuantiles | null;
  small: number;
  manifestOnlyPrs: number;
  openToMergeP50: number | null;
  refinedPairs: number;
  hotFiles: number;
  prs: number;
  repos: number;
  stacked: number;
  stackedPairs: number;
  overlapPairs: number;
  manifestOnly: number;
  truncated: number;
  overlapPrs: number;
  perRepo: Record<string, RepoPrGraph>;
}

export function parseRange(s = "30d"): number {
  const m = /^(\d+)([dw])$/.exec(s);
  if (!m || !Number(m[1])) throw new Error(`bad --range "${s}" (use Nd or Nw)`);
  return Number(m[1]) * (m[2] === "w" ? 7 : 1);
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// 7-day [from, to] date windows (inclusive) covering the last `days` days up to now; search returns <= 1000 hits per query.
export function chunks(days: number, now: number): [string, string][] {
  const out: [string, string][] = [];
  const end = Math.floor(now / DAY) * DAY;
  for (let s = end - days * DAY; s <= end; s += 7 * DAY) {
    out.push([day(s), day(Math.min(s + 6 * DAY, end))]);
  }
  return out;
}

export async function ghRunner(args: string[]): Promise<string> {
  const res = await run("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  return res.stdout;
}

export async function hosts(runner: GhRunner): Promise<string[]> {
  try {
    const raw = await runner(["auth", "status", "--json", "hosts"]);
    const j = JSON.parse(raw) as HostsStatusResponse;
    const entries = j.hosts ? Object.entries(j.hosts) : [];
    return entries
      .filter(([, accts]) =>
        accts.some((a) => a.state === "success" && a.active !== false),
      )
      .map(([h]) => h);
  } catch {
    return [];
  }
}

export async function fetchPrs(
  runner: GhRunner,
  host: string,
  from: string,
  to: string,
): Promise<({ host: string } & GraphQLPrNode)[]> {
  const out: ({ host: string } & GraphQLPrNode)[] = [];
  let cursor: string | null = null;
  do {
    const args = [
      "api",
      "graphql",
      "--hostname",
      host,
      "-f",
      `q=author:@me is:pr created:${from}..${to}`,
      "-f",
      `query=${QUERY}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const parsed = JSON.parse(await runner(args)) as GraphQLSearchResponse;
    const s = parsed.data.search;
    for (const n of s.nodes) {
      if (n?.number != null) out.push({ host, ...n });
    }
    cursor = s.pageInfo.hasNextPage ? s.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

export async function collect(
  runner: GhRunner,
  days: number,
  now = Date.now(),
): Promise<CollectedPr[] | null> {
  const hs = await hosts(runner);
  if (!hs.length) return null;
  const seen = new Map<string, { host: string } & GraphQLPrNode>();
  for (const h of hs) {
    for (const [from, to] of chunks(days, now)) {
      try {
        for (const p of await fetchPrs(runner, h, from, to)) {
          seen.set(`${h}/${p.repository.nameWithOwner}#${String(p.number)}`, p);
        }
      } catch {
        console.error(
          `PR graph: a query failed for ${from}..${to}; continuing`,
        );
      }
    }
  }
  return [...seen.values()].map((p) => ({
    repo: `${p.host}/${p.repository.nameWithOwner}`,
    base: p.baseRefName,
    head: p.headRefName,
    defaultBranch: p.repository.defaultBranchRef?.name,
    created: Date.parse(p.createdAt),
    closed: p.closedAt ? Date.parse(p.closedAt) : null,
    merged: p.mergedAt ? Date.parse(p.mergedAt) : null,
    lines: (p.additions ?? 0) + (p.deletions ?? 0),
    paths: (p.files?.nodes ?? []).map((f) => f.path),
    fileCount: p.files?.totalCount ?? 0,
  }));
}

const manifestOnly = (paths: string[]): boolean =>
  paths.length > 0 &&
  paths.every(
    (p) => MANIFESTS.has(p.split("/").pop() ?? "") || p.endsWith(".csproj"),
  );
const pct = (n: number, d: number): string =>
  d ? `${String(Math.round((100 * n) / d))}%` : "0%";
const nearest = (sorted: number[], q: number): number | null =>
  sorted.length ? (sorted[Math.ceil(q * sorted.length) - 1] ?? null) : null;

// Compact duration: `Xm`, `Xh Ym`, `Xd Yh`; '-' when unknown.
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "-";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${String(m)}m`;
  if (m < 1440) return `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
  return `${String(Math.floor(m / 1440))}d ${String(Math.floor((m % 1440) / 60))}h`;
}

// Paths touched by more than HOT_SHARE of a repo's PRs and by at least HOT_MIN of them.
const hotFiles = (list: CollectedPr[]): Set<string> => {
  const n = new Map<string, number>();
  for (const p of list) {
    for (const x of new Set(p.paths)) {
      n.set(x, (n.get(x) ?? 0) + 1);
    }
  }
  return new Set(
    [...n]
      .filter(([, c]) => c > HOT_SHARE * list.length && c >= HOT_MIN)
      .map(([x]) => x),
  );
};
const isStacked = (p: CollectedPr): boolean =>
  Boolean(p.defaultBranch) && p.base !== p.defaultBranch;

export function graph(
  prs: CollectedPr[],
  now = Date.now(),
  days = 30,
): AggregatedPrGraph {
  const byRepo = new Map<string, CollectedPr[]>();
  for (const p of prs) {
    if (!byRepo.has(p.repo)) byRepo.set(p.repo, []);
    byRepo.get(p.repo)?.push(p);
  }
  const lines = prs.map((p) => p.lines).sort((a, b) => a - b);
  const mergeMs = prs
    .flatMap((p) => (p.merged != null ? [p.merged - p.created] : []))
    .sort((a, b) => a - b);
  const agg: AggregatedPrGraph = {
    perDay: prs.length / days,
    linesQ: prs.length
      ? {
          p25: nearest(lines, 0.25),
          p50: nearest(lines, 0.5),
          p75: nearest(lines, 0.75),
          p90: nearest(lines, 0.9),
        }
      : null,
    small: prs.filter((p) => p.lines <= 10).length,
    manifestOnlyPrs: prs.filter((p) => manifestOnly(p.paths)).length,
    openToMergeP50: nearest(mergeMs, 0.5),
    refinedPairs: 0,
    hotFiles: 0,
    prs: prs.length,
    repos: byRepo.size,
    stacked: prs.filter(isStacked).length,
    stackedPairs: 0,
    overlapPairs: 0,
    manifestOnly: 0,
    truncated: prs.filter((p) => p.fileCount > 100).length,
    overlapPrs: 0,
    perRepo: {},
  };
  const inOverlap = new Set<CollectedPr>();
  for (const [repo, list] of byRepo) {
    const r: RepoPrGraph = {
      prs: list.length,
      stacked: list.filter(isStacked).length,
      stackedPairs: 0,
      overlapPairs: 0,
      refinedPairs: 0,
    };
    const hot = hotFiles(list);
    agg.hotFiles += hot.size;
    const sorted = [...list].sort((a, b) => a.created - b.created);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (!a || !b) continue;
        if (!(a.created <= b.created && b.created < (a.closed ?? now)))
          continue;
        if (b.base === a.head || a.base === b.head) {
          r.stackedPairs++;
          continue;
        }
        const bp = new Set(b.paths);
        const shared = a.paths.filter((x) => bp.has(x));
        if (!shared.length) continue;
        r.overlapPairs++;
        if (shared.some((x) => !hot.has(x))) r.refinedPairs++;
        if (manifestOnly(shared)) agg.manifestOnly++;
        inOverlap.add(a);
        inOverlap.add(b);
      }
    }
    agg.stackedPairs += r.stackedPairs;
    agg.overlapPairs += r.overlapPairs;
    agg.refinedPairs += r.refinedPairs;
    agg.perRepo[repo] = r;
  }
  agg.overlapPrs = inOverlap.size;
  return agg;
}

export function report(agg: AggregatedPrGraph, range: string): string {
  const rows: [string, string][] = [
    ["PRs", String(agg.prs)],
    ["Repos", String(agg.repos)],
    ["PRs per day", agg.perDay.toFixed(1)],
    [
      "Changed lines p25 / p50 / p75 / p90",
      agg.linesQ
        ? `${String(agg.linesQ.p25)} / ${String(agg.linesQ.p50)} / ${String(agg.linesQ.p75)} / ${String(agg.linesQ.p90)}`
        : "-",
    ],
    [
      "PRs of 10 lines or fewer",
      `${pct(agg.small, agg.prs)} (${String(agg.small)})`,
    ],
    [
      "Manifest-only PRs",
      `${pct(agg.manifestOnlyPrs, agg.prs)} (${String(agg.manifestOnlyPrs)})`,
    ],
    ["Median open-to-merge", fmtDuration(agg.openToMergeP50)],
    [
      "Stacked share (base is not the default branch)",
      `${pct(agg.stacked, agg.prs)} (${String(agg.stacked)})`,
    ],
    ["Open-together pairs already stacked", String(agg.stackedPairs)],
    [
      "Should-have-been-stacked pairs, hot files dropped (share a file that is not hot)",
      String(agg.refinedPairs),
    ],
    [
      "Hot files dropped (touched by more than 20% of a repo's PRs, at least 3)",
      String(agg.hotFiles),
    ],
    [
      "Should-have-been-stacked pairs, any shared file (secondary)",
      String(agg.overlapPairs),
    ],
    ["of which overlap only on version manifests", String(agg.manifestOnly)],
    [
      "Share of PRs in a should-have-been-stacked pair",
      pct(agg.overlapPrs, agg.prs),
    ],
    [
      "PRs with more than 100 files (overlap undercounted)",
      String(agg.truncated),
    ],
  ];
  return [
    `## PR graph (last ${range}, every repo gh can reach)`,
    "",
    "| Measure | Value |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "Target: hot-file-free should-have-been-stacked pairs trend to 0 and the stacked share rises (github-workflow, Landing a change). How to read each figure: .agents/skills/agent-review/references/reading.md (PR graph).",
    "",
  ].join("\n");
}

export function repoTable(agg: AggregatedPrGraph): string {
  const rows = Object.entries(agg.perRepo)
    .sort((a, b) => b[1].overlapPairs - a[1].overlapPairs)
    .map(
      ([k, r]) =>
        `| ${k} | ${String(r.prs)} | ${String(r.stacked)} | ${String(r.overlapPairs)} | ${String(r.refinedPairs)} |`,
    );
  return [
    "Local detail: never paste into a PR, issue or committed file.",
    "",
    "| Repo | PRs | Stacked | Overlap pairs | Refined pairs |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

// A gh failure message holds the command line, which names a repo: print the message only for a bad --range.
export const errorLine = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return msg.startsWith("bad --range")
    ? msg
    : "PR graph: failed with an unexpected error (detail withheld, it may name a repo)";
};

export async function main(
  argv: string[],
  runner: GhRunner = ghRunner,
  now = Date.now(),
): Promise<void> {
  const i = argv.indexOf("--range");
  const range = i >= 0 ? (argv[i + 1] ?? "30d") : "30d";
  const days = parseRange(range);
  const prs = await collect(runner, days, now);
  if (!prs) {
    console.log(SKIPPED);
    return;
  }
  const agg = graph(prs, now, days);
  process.stdout.write(report(agg, range));
  if (argv.includes("--repos")) process.stdout.write(`\n${repoTable(agg)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(errorLine(e));
    process.exit(1);
  });
}
