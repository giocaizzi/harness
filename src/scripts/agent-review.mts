#!/usr/bin/env node
// Weekly agent review without an agent: the agent-review skill's queries, run straight against Loki, printed as
// Markdown; with --evals <dir>, also writes skill-trigger eval stubs for `claude plugin eval`. Runbook:
// docs/agent-review.md.
//
// Loki access, read from the environment (never printed):
//   GRAFANA_URL + GRAFANA_TOKEN  query through Grafana's datasource proxy (LOKI_UID, default "loki")
//   LOKI_URL                     query Loki directly (plus LOKI_HEADERS, "Key=Value,Key2=Value2")
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(startDir: string): string {
  let cur = startDir;
  while (cur !== dirname(cur)) {
    if (existsSync(join(cur, ".claude-plugin", "marketplace.json"))) {
      return cur;
    }
    cur = dirname(cur);
  }
  return resolve(startDir, "..");
}

const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

// The review's LogQL, shared with the repo's agent-review skill; `$r` is the review range (e.g. 7d).
export const QUERIES: Record<string, string> = JSON.parse(
  readFileSync(
    join(ROOT, ".agents/skills/agent-review/references/queries.json"),
    "utf8",
  ),
) as Record<string, string>;

export type LokiMetricLabels = Record<string, string | undefined>;

export interface LokiRow {
  labels: LokiMetricLabels;
  value: number;
}

export interface LokiEndpoint {
  base: string;
  headers: Record<string, string>;
}

interface LokiQueryResponse {
  data: {
    result: {
      metric: LokiMetricLabels;
      value: [number, string];
    }[];
  };
}

export interface SkillUseCounts {
  user: number;
  model: number;
  nested: number;
}

export interface RoutingShape {
  drivers: number;
  workers: number;
  workerPerDriver: number;
  nestedShare: number;
  driverEditShare: number;
  medianDriverEdits: number;
  opusPerDriver: number;
  reviewers: number;
  reviewerSonnetShare: number;
  high: Record<string, number>;
  summaryShare: number;
  untracked: number;
}

export interface VersionShapeItem {
  version: string;
  sessions: number;
  costPerSession: number;
  opusShare: number;
  sonnetShare: number;
  summaryShare: number;
  workerPerDriver: number;
  highShare: number;
}

export interface LspShareTypeItem {
  agent: string;
  lsp: number;
  grep: number;
  share: number;
}

export interface LspShare {
  types: LspShareTypeItem[];
  lsp: number;
  grep: number;
  share: number;
  ops: number;
  failureRate: number;
}

export interface EvalStub {
  dir: string;
  files: Record<string, string>;
}

export type ReviewData = Record<string, LokiRow[]>;

export function parsePairs(s = ""): Record<string, string> {
  return Object.fromEntries(
    s
      .split(",")
      .map((p) => p.split("="))
      .filter(([k, v]) => k && v != null)
      .map(([k, ...v]) => [k?.trim() ?? "", v.join("=").trim()]),
  );
}

export function endpoint(env: NodeJS.ProcessEnv): LokiEndpoint | null {
  if (env.GRAFANA_URL && env.GRAFANA_TOKEN) {
    return {
      base: `${env.GRAFANA_URL.replace(/\/$/, "")}/api/datasources/proxy/uid/${env.LOKI_UID ?? "loki"}`,
      headers: { Authorization: `Bearer ${env.GRAFANA_TOKEN}` },
    };
  }
  if (env.LOKI_URL)
    return {
      base: env.LOKI_URL.replace(/\/$/, ""),
      headers: parsePairs(env.LOKI_HEADERS),
    };
  return null;
}

async function query(
  ep: LokiEndpoint,
  expr: string,
  fetchFn: typeof fetch,
): Promise<LokiRow[]> {
  const res = await fetchFn(
    `${ep.base}/loki/api/v1/query?query=${encodeURIComponent(expr)}`,
    {
      headers: ep.headers,
    },
  );
  if (!res.ok)
    throw new Error(
      `Loki answered ${String(res.status)} for ${expr.slice(0, 60)}...`,
    );
  const json = (await res.json()) as LokiQueryResponse;
  return json.data.result.map((r) => ({
    labels: r.metric,
    value: Number(r.value[1]),
  }));
}

export async function collect(
  ep: LokiEndpoint,
  range: string,
  fetchFn: typeof fetch = fetch,
): Promise<ReviewData> {
  const out: ReviewData = {};
  for (const [k, q] of Object.entries(QUERIES)) {
    out[k] = await query(ep, q.replaceAll("$r", range), fetchFn);
  }
  return out;
}

// Skills shipped in this checkout, as `plugin:skill`.
export function knownSkills(root: string = ROOT): string[] {
  const plugins = join(root, "plugins");
  return readdirSync(plugins).flatMap((p) => {
    const dir = join(plugins, p, "skills");
    return existsSync(dir) ? readdirSync(dir).map((s) => `${p}:${s}`) : [];
  });
}

const sum = (rows: LokiRow[] = []): number =>
  rows.reduce((a, r) => a + r.value, 0);
const usd = (v: number): string => `$${v.toFixed(2)}`;
const table = (head: string[], rows: (string | number)[][]): string =>
  rows.length
    ? [
        `| ${head.join(" | ")} |`,
        `|${head.map(() => "---").join("|")}|`,
        ...rows.map((r) => `| ${r.join(" | ")} |`),
      ].join("\n")
    : "_none_";
const top = (rows: LokiRow[] = [], n = 15): LokiRow[] =>
  [...rows].sort((a, b) => b.value - a.value).slice(0, n);

// model: the model picked the skill from its description (Claude Code's claude-proactive, the guard's via=tool);
// nested: another skill told it to; user: typed by the user.
const TRIGGER: Record<string, keyof SkillUseCounts> = {
  "claude-proactive": "model",
  "nested-skill": "nested",
};

export function skillUse(
  data: ReviewData,
  known: string[],
): Record<string, SkillUseCounts> {
  const use: Record<string, SkillUseCounts> = Object.fromEntries(
    known.map((s) => [s, { user: 0, model: 0, nested: 0 }]),
  );
  for (const r of data.skillsClaude ?? []) {
    const s = r.labels.skill_name;
    if (!s || !use[s]) continue;
    const tr = TRIGGER[r.labels.invocation_trigger ?? ""] ?? "user";
    use[s][tr] += r.value;
  }
  for (const r of data.skillsGuard ?? []) {
    const s = Object.keys(use).find(
      (k) => k === r.labels.skill || k.endsWith(`:${r.labels.skill ?? ""}`),
    );
    if (s && use[s]) {
      const mode = r.labels.via === "tool" ? "model" : "user";
      use[s][mode] += r.value;
    }
  }
  return use;
}

// Routing shape: per-spawn rows joined on agent_id (subagent_completed names the type; tool_result and api_request
// carry the calling agent's id), reduced to aggregates. Ids never leave this function.
const isType = (name: string | undefined, t: string): boolean =>
  new RegExp(`(^|:)${t}$`).test(name ?? "") ||
  (t === "worker" && name === "dev-tools-worker");

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

// The effort a spawn ran at: the one most of its spend went to. Map agent_id -> effort; ids never leave the callers.
export function effortByAgent(data: ReviewData): Map<string, string> {
  const effortOf = new Map<string, string>();
  const spend = new Map<string, number>();
  for (const r of data.agentCost ?? []) {
    const agentId = r.labels.agent_id ?? "";
    const effort = r.labels.effort ?? "";
    const k = `${agentId}\u0000${effort}`;
    spend.set(k, (spend.get(k) ?? 0) + r.value);
    const cur = effortOf.get(agentId);
    if (
      !cur ||
      (spend.get(k) ?? 0) > (spend.get(`${agentId}\u0000${cur}`) ?? 0)
    ) {
      effortOf.set(agentId, effort);
    }
  }
  return effortOf;
}

export function routingShape(data: ReviewData): RoutingShape {
  const type = new Map<string, string>();
  const model = new Map<string, string>();
  for (const r of data.agentIds ?? []) {
    const agentId = r.labels.agent_id ?? "";
    if (!type.has(agentId)) {
      type.set(agentId, r.labels.agent_type ?? "");
      model.set(agentId, r.labels.model ?? "");
    }
  }
  const ids = (t: string): string[] =>
    [...type.keys()].filter((id) => isType(type.get(id), t));
  const drivers = ids("driver");
  const workers = ids("worker");
  const reviewers = ids("reviewer");
  const nested = sum(
    (data.agentSpawns ?? []).filter(
      (r) =>
        isType(r.labels.agent, "worker") &&
        isType(type.get(r.labels.agent_id ?? ""), "driver"),
    ),
  );
  const edits = new Map(
    (data.agentEdits ?? []).map((r) => [r.labels.agent_id ?? "", r.value]),
  );
  const driverEdits = drivers.reduce((a, id) => a + (edits.get(id) ?? 0), 0);
  const effortOf = effortByAgent(data);
  const high: Record<string, number> = {};
  for (const [id, e] of effortOf) {
    if (/high|max/.test(e)) {
      const t = type.get(id) ?? "(unknown)";
      high[t] = (high[t] ?? 0) + 1;
    }
  }
  const opusDriver = sum(
    (data.agentCost ?? []).filter(
      (r) =>
        drivers.includes(r.labels.agent_id ?? "") &&
        (r.labels.model ?? "").includes("opus"),
    ),
  );
  const subagentSpend = sum(
    (data.costBySource ?? []).filter((r) =>
      (r.labels.query_source ?? "").startsWith("agent"),
    ),
  );
  const summary = sum(
    (data.costBySource ?? []).filter(
      (r) => r.labels.query_source === "agent_summary",
    ),
  );
  const tracked = sum(
    (data.agentCost ?? []).filter((r) =>
      (r.labels.query_source ?? "").startsWith("agent:"),
    ),
  );
  const untracked = Math.max(
    0,
    sum(
      (data.costBySource ?? []).filter((r) =>
        (r.labels.query_source ?? "").startsWith("agent:"),
      ),
    ) - tracked,
  );
  return {
    drivers: drivers.length,
    workers: workers.length,
    workerPerDriver: drivers.length ? workers.length / drivers.length : 0,
    nestedShare: workers.length ? nested / workers.length : 0,
    driverEditShare: sum(data.agentEdits)
      ? driverEdits / sum(data.agentEdits)
      : 0,
    medianDriverEdits: median(drivers.map((id) => edits.get(id) ?? 0)),
    opusPerDriver: drivers.length ? opusDriver / drivers.length : 0,
    reviewers: reviewers.length,
    reviewerSonnetShare: reviewers.length
      ? reviewers.filter((id) => (model.get(id) ?? "").includes("sonnet"))
          .length / reviewers.length
      : 0,
    high,
    summaryShare: subagentSpend ? summary / subagentSpend : 0,
    untracked,
  };
}

// By plugin version: Claude Code sessions joined to the guard's guard.session record on session_id. A session's version is
// the highest announced (a resumed session announces again); none: (unknown). Aggregates only; ids never leave this function.
const semver = (v: string): number[] =>
  v.split(".").map((n) => parseInt(n, 10) || 0);
const cmpSemver = (a: string, b: string): number => {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
};

interface VersionGroup {
  sessions: Set<string>;
  cost: number;
  opus: number;
  sonnet: number;
  summary: number;
  sub: number;
  spawns: Map<string, string>;
}

export function versionShape(data: ReviewData): VersionShapeItem[] {
  const announced = new Map<string, string>();
  for (const r of data.sessionVersions ?? []) {
    const v = r.labels.plugin_version_dev_tools;
    const sid = r.labels.session_id;
    if (!v || !sid) continue;
    const cur = announced.get(sid);
    if (!cur || cmpSemver(v, cur) > 0) announced.set(sid, v);
  }
  const versionOf = (sid: string): string => announced.get(sid) ?? "(unknown)";
  const effort = effortByAgent(data);
  const by = new Map<string, VersionGroup>();
  const get = (v: string): VersionGroup => {
    let group = by.get(v);
    if (!group) {
      group = {
        sessions: new Set(),
        cost: 0,
        opus: 0,
        sonnet: 0,
        summary: 0,
        sub: 0,
        spawns: new Map(),
      };
      by.set(v, group);
    }
    return group;
  };
  const known = new Set(
    (data.sessionCost ?? []).map((r) => r.labels.session_id ?? ""),
  );
  for (const r of data.sessionCost ?? []) {
    const sid = r.labels.session_id ?? "";
    const g = get(versionOf(sid));
    g.sessions.add(sid);
    g.cost += r.value;
  }
  for (const r of data.sessionSubagentCost ?? []) {
    const sid = r.labels.session_id ?? "";
    if (!known.has(sid)) continue;
    const g = get(versionOf(sid));
    g.sub += r.value;
    if (/opus|fable/.test(r.labels.model ?? "")) g.opus += r.value;
    if ((r.labels.model ?? "").includes("sonnet")) g.sonnet += r.value;
    if (r.labels.src === "summary") g.summary += r.value;
  }
  for (const r of data.agentIds ?? []) {
    const sid = r.labels.session_id ?? "";
    const agentId = r.labels.agent_id ?? "";
    if (known.has(sid))
      get(versionOf(sid)).spawns.set(agentId, r.labels.agent_type ?? "");
  }
  const div = (a: number, b: number): number => (b ? a / b : 0);
  return [...by]
    .map(([version, g]): VersionShapeItem => {
      const types = [...g.spawns.values()];
      const ids = [...g.spawns.keys()];
      const drivers = types.filter((t) => isType(t, "driver")).length;
      const workers = types.filter((t) => isType(t, "worker")).length;
      return {
        version,
        sessions: g.sessions.size,
        costPerSession: div(g.cost, g.sessions.size),
        opusShare: div(g.opus, g.sub),
        sonnetShare: div(g.sonnet, g.sub),
        summaryShare: div(g.summary, g.sub),
        workerPerDriver: div(workers, drivers),
        highShare: div(
          ids.filter((id) => /high|max/.test(effort.get(id) ?? "")).length,
          ids.length,
        ),
      };
    })
    .sort(
      (a, b) =>
        (a.version === "(unknown)" ? 1 : 0) -
          (b.version === "(unknown)" ? 1 : 0) ||
        cmpSemver(b.version, a.version),
    );
}

// LSP share: LSP tool calls against grep searches (Grep tool plus Bash rg/grep), per agent type, joined on agent_id.
// An empty agent_id is the main session (or an agent-team teammate, which telemetry cannot tie to an agent). Ids never leave this function.
export function lspShare(data: ReviewData): LspShare {
  const type = new Map<string, string>();
  for (const r of data.agentIds ?? []) {
    const agentId = r.labels.agent_id ?? "";
    if (!type.has(agentId)) type.set(agentId, r.labels.agent_type ?? "");
  }
  // Codex registers the worker as `dev-tools-worker`; a row without a type is unknown.
  const typeOf = (id: string | undefined): string => {
    if (!id) return "main";
    const t = type.get(id);
    return t
      ? t.replace(/^.*:/, "").replace(/^dev-tools-worker$/, "worker")
      : "(unknown)";
  };
  const by: Record<string, { lsp: number; grep: number }> = {};
  const add = (id: string | undefined, k: "lsp" | "grep", v: number): void => {
    const t = typeOf(id);
    by[t] ??= { lsp: 0, grep: 0 };
    by[t][k] += v;
  };
  for (const r of data.agentLsp ?? []) {
    add(
      r.labels.agent_id,
      r.labels.tool_name === "LSP" ? "lsp" : "grep",
      r.value,
    );
  }
  for (const r of data.agentGrep ?? []) {
    add(r.labels.agent_id, "grep", r.value);
  }
  const types: LspShareTypeItem[] = Object.entries(by)
    .map(([agent, c]) => ({
      agent,
      ...c,
      share: c.lsp + c.grep ? c.lsp / (c.lsp + c.grep) : 0,
    }))
    .sort((a, b) => b.lsp + b.grep - (a.lsp + a.grep));
  const lsp = types.reduce((a, t) => a + t.lsp, 0);
  const grep = types.reduce((a, t) => a + t.grep, 0);
  const ops = sum(data.lspOps);
  return {
    types,
    lsp,
    grep,
    share: lsp + grep ? lsp / (lsp + grep) : 0,
    ops,
    failureRate: ops
      ? sum((data.lspOps ?? []).filter((r) => r.labels.success === "false")) /
        ops
      : 0,
  };
}

const pct = (v: number): string => `${String(Math.round(v * 100))}%`;

export function report(
  data: ReviewData,
  known: string[],
  range: string,
): string {
  const use = skillUse(data, known);
  const unused = Object.entries(use)
    .filter(([, u]) => u.user + u.model + u.nested === 0)
    .map(([s]) => s);
  const userOnly = Object.entries(use)
    .filter(([, u]) => u.user + u.nested > 0 && u.model === 0)
    .map(([s]) => s);
  const opusSub = (data.costBySource ?? []).filter(
    (r) =>
      (r.labels.query_source ?? "").startsWith("agent") &&
      /opus|fable/.test(r.labels.model ?? ""),
  );
  const unnamed = (data.subagentCost ?? []).filter((r) => !r.labels.agent_name);
  const shape = routingShape(data);
  const lspS = lspShare(data);
  const versions = versionShape(data);
  return [
    `# Agent review (last ${range})`,
    "",
    `Total ${usd(sum(data.costByHarness))} at list price; ${String(sum(data.rateLimits))} rate-limit errors.`,
    "",
    "## Cost by harness and model",
    table(
      ["harness", "model", "cost"],
      top(data.costByHarness).map((r) => [
        r.labels.service_name ?? "",
        r.labels.model ?? "",
        usd(r.value),
      ]),
    ),
    "",
    "## Claude Code cost by source",
    "Background sources (hook_prompt, away_summary, prompt_suggestion) are spend no task asked for.",
    table(
      ["source", "model", "cost"],
      top(data.costBySource).map((r) => [
        r.labels.query_source ?? "",
        r.labels.model ?? "",
        usd(r.value),
      ]),
    ),
    "",
    "### hook_prompt by plugin",
    "A mod's session fork or prompt hook, on the session's model. No plugin: Claude Code before 2.1.310, which left it unlabelled.",
    table(
      ["plugin", "model", "cost"],
      top(data.hookPromptCost).map((r) => [
        r.labels.plugin_name ?? "(unlabelled)",
        r.labels.model ?? "",
        usd(r.value),
      ]),
    ),
    "",
    "## Subagent routing",
    `Subagent spend on Opus or Fable: ${usd(sum(opusSub))}. Lookups belong on Haiku, routine edits on Sonnet (subagent-orchestration).`,
    table(
      ["agent", "model", "runs"],
      top(data.subagents).map((r) => [
        r.labels.agent_type ?? "",
        r.labels.model ?? "",
        String(r.value),
      ]),
    ),
    "",
    "### Routing shape",
    "Unique spawns joined on agent id (Claude Code). Targets: workers per driver >= 1.5, nested workers >= 50%, driver share of subagent edits <= 30%, median edits per driver <= 3, routine reviews on Sonnet >= 80%, agent_summary <= 10% of subagent spend.",
    table(
      ["measure", "value"],
      [
        [
          "drivers / workers (unique)",
          `${String(shape.drivers)} / ${String(shape.workers)}`,
        ],
        ["workers per driver", shape.workerPerDriver.toFixed(2)],
        ["workers spawned by a driver", pct(shape.nestedShare)],
        ["driver share of subagent Edit/Write", pct(shape.driverEditShare)],
        ["median edits per driver", String(shape.medianDriverEdits)],
        ["Opus per driver (incl. agent_summary)", usd(shape.opusPerDriver)],
        [
          "reviewers on Sonnet",
          `${pct(shape.reviewerSonnetShare)} of ${String(shape.reviewers)}`,
        ],
        ["agent_summary share of subagent spend", pct(shape.summaryShare)],
      ],
    ),
    "",
    `Spawns at effort high or above, by agent (only the sensitive-review agents belong here): ${
      Object.entries(shape.high)
        .map(([t, n]) => `${t} ${String(n)}`)
        .join(", ") || "none"
    }.`,
    "",
    "### By plugin version",
    "Claude Code sessions joined to the guard's `guard.session` by session id; `(unknown)`: no record (a guard before it sent one, or a session started before the window). Compare a version with the one before it.",
    table(
      [
        "dev-tools",
        "sessions",
        "cost/session",
        "Opus share of subagent cost",
        "Sonnet share",
        "workers per driver",
        "effort high+ spawns",
        "agent_summary share",
      ],
      versions.map((v) => [
        v.version,
        String(v.sessions),
        usd(v.costPerSession),
        pct(v.opusShare),
        pct(v.sonnetShare),
        v.workerPerDriver.toFixed(2),
        pct(v.highShare),
        pct(v.summaryShare),
      ]),
    ),
    "",
    "### LSP share",
    "Target: LSP share >= 5% for main, driver, scout, worker and reviewer once at least 30 searches ran; LSP failures <= 10%.",
    table(
      ["agent", "LSP", "grep searches", "share"],
      [
        ...lspS.types.map((t) => [
          t.agent,
          String(t.lsp),
          String(t.grep),
          pct(t.share),
        ]),
        ["all", String(lspS.lsp), String(lspS.grep), pct(lspS.share)],
      ],
    ),
    "",
    `LSP operations: ${String(lspS.ops)}; failure rate ${pct(lspS.failureRate)}.`,
    "",
    "### Subagent cost by agent",
    `Unattributed: ${usd(sum(unnamed))} without an agent name; ${usd(shape.untracked)} of it without an agent id either: agent-team teammates (a named spawn while agent teams are on), which telemetry cannot tie to an agent.`,
    table(
      ["agent", "model", "cost"],
      top(data.subagentCost).map((r) => [
        r.labels.agent_name ?? "(named spawn)",
        r.labels.model ?? "",
        usd(r.value),
      ]),
    ),
    "",
    "### Spawns with no model pinned",
    "Each ran on the session's model (subagent-orchestration: spawn a typed agent, such as dev-tools:worker for routine edits). web-fetch and claude-code-guide pick their own.",
    table(
      ["agent", "spawns"],
      top(data.unpinnedSpawns).map((r) => [
        r.labels.agent ?? "general-purpose",
        String(r.value),
      ]),
    ),
    "",
    "### Model swaps",
    "A subagent that finished on another model than it started on (a fallback chain): record it as a routing deviation.",
    table(
      ["agent", "model", "finished on", "runs"],
      top(data.modelSwaps).map((r) => [
        r.labels.agent_type ?? "",
        r.labels.model ?? "",
        r.labels.final_model ?? "",
        String(r.value),
      ]),
    ),
    "",
    "## Skills",
    `Never loaded: ${unused.length ? unused.join(", ") : "none"}.`,
    "",
    `Loaded, but never picked by the model from its description: ${
      userOnly.length ? userOnly.join(", ") : "none"
    }. Their descriptions are the first suspects.`,
    "",
    table(
      ["skill", "by user", "by another skill", "by model"],
      Object.entries(use)
        .filter(([, u]) => u.user + u.model + u.nested > 0)
        .sort((a, b) => b[1].model - a[1].model)
        .map(([s, u]) => [
          s,
          String(u.user),
          String(u.nested),
          String(u.model),
        ]),
    ),
    "",
    "## Guard reminders (a skill or a read tool was due and missing)",
    table(
      ["rule", "reminders"],
      top(data.reminders).map((r) => [r.labels.rule ?? "", String(r.value)]),
    ),
    "",
    "## Guard decisions",
    "An ask the user always approves is a false positive; a deny burst is a misfiring rule.",
    table(
      ["rule", "action", "via", "count"],
      top(data.decisions).map((r) => [
        r.labels.rule ?? "",
        r.labels.action ?? "",
        r.labels.via ?? "",
        String(r.value),
      ]),
    ),
    "",
    "## Guard asks answered",
    "How each ask ended (Claude Code dialog, pi confirm): a high timeout share means asks land while the user is away; a high allow share on one rule is a false positive.",
    table(
      ["harness", "result", "count"],
      top(data.askResults).map((r) => [
        r.labels.harness ?? "",
        r.labels.result ?? "",
        String(r.value),
      ]),
    ),
    "",
    "## Manual approvals by tool",
    table(
      ["tool", "approvals"],
      top(data.approvals).map((r) => [
        r.labels.tool_name ?? "",
        String(r.value),
      ]),
    ),
    "",
    "## Failing shell commands (first word)",
    table(
      ["command", "failures"],
      top(data.failing).map((r) => [
        `\`${r.labels.bash_command ?? ""}\``,
        String(r.value),
      ]),
    ),
    "",
  ].join("\n");
}

// Eval stubs for skills the model should load on its own but does not. The prompt is a placeholder: write a
// realistic request (no private values) before running `claude plugin eval`.
export function evalStubs(data: ReviewData, known: string[]): EvalStub[] {
  const use = skillUse(data, known);
  return Object.entries(use)
    .filter(([, u]) => u.model === 0)
    .map(([skill]) => {
      const parts = skill.split(":");
      const plugin = parts[0] ?? "";
      const name = parts[1] ?? "";
      return {
        dir: `${plugin}/evals/${name}-trigger`,
        files: {
          "prompt.md": `---\nmax_turns: 10\nallowed_tools: [Read, Glob, Grep, Skill]\ntags: [trigger]\n---\n\nTODO: a request that should make the model load ${skill} on its own, phrased as a user would, without naming it.\n`,
          "graders/skill-fired.md": `---\ntype: tool_used\ntool: Skill\ninput_match: '"skill"\\s*:\\s*"(?:[\\w-]+:)?${name}"'\n---\n`,
        },
      };
    });
}

async function main(argv: string[]): Promise<void> {
  const range = argv.includes("--range")
    ? (argv[argv.indexOf("--range") + 1] ?? "7d")
    : "7d";
  const evals = argv.includes("--evals")
    ? (argv[argv.indexOf("--evals") + 1] ?? null)
    : null;
  const ep = endpoint(process.env);
  if (!ep) {
    console.error(
      "Set GRAFANA_URL and GRAFANA_TOKEN, or LOKI_URL (docs/agent-review.md).",
    );
    process.exit(2);
  }
  const data = await collect(ep, range);
  const known = knownSkills();
  process.stdout.write(report(data, known, range));
  if (evals) {
    for (const s of evalStubs(data, known)) {
      for (const [f, body] of Object.entries(s.files)) {
        const path = join(evals, s.dir, f);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
      }
    }
    console.error(`Eval stubs written under ${evals}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
    console.error(msg);
    process.exit(1);
  });
}
