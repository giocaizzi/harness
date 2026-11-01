// Token weather facts, free of engine imports so node can test them. Pure: facts in, one display line out.
// percent: context fullness; usage: the last main-loop turn's token counts; turns: main-loop turns since the
// session (or /clear) began; ttlMs / sinceMs: the prompt-cache TTL and the time since that turn ended.
import type {
  AzurePrItem,
  AzurePrPolicy,
  ForecastFacts,
  ForecastResult,
  ForecastSegment,
  ForgeType,
  GitHubPrPayload,
  GitLabMrPayload,
  PrCheckStatus,
  PrInfo,
  RateLimitSample,
  RepoState,
} from "./types.mjs";

export const TTL_MS = { "5m": 300_000, "1h": 3_600_000 } as const;

export const clock = (ms: number): string =>
  `${String(Math.floor(ms / 60_000))}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

const BLOCKS = "▁▂▃▄▅▆▇█";

// Nerd Font icons (BMP private use, so a Raster could take them too), checked present in JetBrainsMono Nerd Font,
// which chezmoi installs and sets in Ghostty, VS Code and Windows Terminal. Each is drawn followed by a space:
// Ghostty then draws the icon at full size instead of squeezing it into one cell.
// One icon per part, the same in the status line and the band: every part is drawn `[icon value]`.
export const ICON: Record<string, string> = {
  user: "\uf007", // nf-fa-user
  branch: "\ue725", // nf-dev-git_branch
  cloud: "\uf0c2", // nf-fa-cloud (the GCP project)
  session: "\uf02b", // nf-fa-tag
  path: "\uf07c", // nf-fa-folder_open
  model: "\uf2db", // nf-fa-microchip
  cost: "\uf155", // nf-fa-usd
  pr: "\uf407", // nf-oct-git_pull_request
  merged: "\uf419", // nf-oct-git_merge
  pending: "\uf252", // nf-fa-hourglass_half
  sync: "\uf47f", // nf-oct-git_compare (ahead and behind)
  changes: "\uf448", // nf-oct-pencil
  agents: "\uf0c0", // nf-fa-users
  forecast: "\uf244", // nf-fa-battery_empty
  cache: "\uf472", // nf-oct-database
  ttl: "\uf520", // nf-oct-stopwatch
  trend: "\uf201", // nf-fa-line_chart
  hint: "\uf071", // nf-fa-warning
};

// A weather icon for how full the context is: sunny, cloudy, showers, thunderstorm, lightning (nf-weather-*).
export const glyph = (ctx?: number | null): string =>
  ctx == null
    ? ""
    : ctx < 25
      ? "\ue30d"
      : ctx < 50
        ? "\ue302"
        : ctx < 75
          ? "\ue319"
          : ctx < 90
            ? "\ue31d"
            : "\ue315";

// A battery for how much of a rate-limit window is left (nf-fa-battery_0..4, full to empty as `used` rises).
export const battery = (used: number): string =>
  String.fromCharCode(
    0xf244 - Math.min(4, Math.max(0, Math.round((100 - used) / 25))),
  );

// The spinner's word while a tool runs: a Nerd Font icon and a verb, null for a tool with no personality.
export const ACTIVITY: Record<string, [string, string]> = {
  Bash: ["\uf489", "Running"],
  Read: ["\uf4a5", "Reading"],
  Grep: ["\uf422", "Searching"],
  Glob: ["\uf422", "Searching"],
  Edit: ["\uf448", "Editing"],
  Write: ["\uf448", "Editing"],
  NotebookEdit: ["\uf448", "Editing"],
  WebFetch: ["\uf0ac", "Browsing"],
  WebSearch: ["\uf0ac", "Browsing"],
  Agent: ["\uf0c0", "Delegating"],
};

export function activityLabel(tool?: string | null): string | null {
  if (tool === undefined || tool === null) return null;
  const a =
    ACTIVITY[tool] ?? (tool.startsWith("mcp__") ? ["\uf1e6", "Calling"] : null);
  return a ? `${a[0]} ${a[1]}` : null;
}

// The forge a remote URL belongs to: github, gitlab, azure, or null for any other.
export function forgeOf(url?: string | null): ForgeType | null {
  if (!url) return null;
  if (/github\.com[:/]/.test(url)) return "github";
  if (/dev\.azure\.com|visualstudio\.com/.test(url)) return "azure";
  if (url.includes("gitlab")) return "gitlab";
  return null;
}

// A pull request as every forge's reader returns it: number, url, state (open | merged | closed) and one entry per
// check (pass | fail | pending).
// GitHub: `gh pr view --json number,url,state,statusCheckRollup`.
export function githubPr(j?: GitHubPrPayload | null): PrInfo | null {
  if (!j) return null;
  const check = (c: {
    conclusion?: string;
    state?: string;
    status?: string;
  }): PrCheckStatus =>
    [
      "FAILURE",
      "ERROR",
      "TIMED_OUT",
      "CANCELLED",
      "STARTUP_FAILURE",
      "ACTION_REQUIRED",
    ].includes(c.conclusion ?? c.state ?? "")
      ? "fail"
      : (c.status ? c.status !== "COMPLETED" : c.state === "PENDING")
        ? "pending"
        : "pass";
  return {
    number: j.number,
    url: j.url ?? null,
    state: (j.state ?? "OPEN").toLowerCase(),
    checks: (j.statusCheckRollup ?? []).map(check),
  };
}

// GitLab: `glab mr view --output json` (the API's merge request): its head pipeline is its one check.
export function gitlabMr(j?: GitLabMrPayload | null): PrInfo | null {
  if (!j) return null;
  const p = (j.head_pipeline ?? j.pipeline)?.status;
  const check: PrCheckStatus[] = !p
    ? []
    : p === "success" || p === "skipped"
      ? ["pass"]
      : ["failed", "canceled"].includes(p)
        ? ["fail"]
        : ["pending"];
  return {
    number: j.iid,
    url: j.web_url ?? null,
    state:
      j.state === "opened"
        ? "open"
        : j.state === "merged"
          ? "merged"
          : "closed",
    checks: check,
  };
}

// Azure DevOps: `az repos pr list --source-branch <branch> --status all --top 1` and `az repos pr policy list --id <n>`:
// each policy evaluation is a check.
export function azurePr(
  list?: readonly AzurePrItem[] | null,
  policies?: readonly AzurePrPolicy[] | null,
): PrInfo | null {
  const j = list?.[0];
  if (j?.pullRequestId === undefined) return null;
  const check = (p: AzurePrPolicy): PrCheckStatus =>
    p.status === "rejected" || p.status === "broken"
      ? "fail"
      : p.status === "running" || p.status === "queued"
        ? "pending"
        : "pass";
  const state =
    j.status === "completed"
      ? "merged"
      : j.status === "abandoned"
        ? "closed"
        : "open";
  const url = j.repository?.webUrl
    ? `${j.repository.webUrl}/pullrequest/${String(j.pullRequestId)}`
    : null;
  return {
    number: j.pullRequestId,
    url,
    state,
    checks: (policies ?? []).map(check),
  };
}

// Roll up one forge's PR and git facts into the band's repo state.
export function repoState(
  pr?: PrInfo | null,
  counts?: string | null,
  shortstat?: string | null,
  porcelain?: string | null,
): RepoState {
  const [behind = 0, ahead = 0] = (counts ?? "")
    .trim()
    .split(/\s+/)
    .map(Number);
  const checks = pr?.checks ?? [];
  const ci: "pass" | "fail" | "pending" | null = checks.includes("fail")
    ? "fail"
    : checks.includes("pending")
      ? "pending"
      : checks.length
        ? "pass"
        : null;
  const n = (re: RegExp): number => Number(re.exec(shortstat ?? "")?.[1] ?? 0);
  const untracked = (porcelain ?? "")
    .split("\n")
    .filter((l) => l.startsWith("??")).length;
  return {
    pr: pr
      ? {
          number: pr.number,
          url: pr.url,
          state: pr.state,
          ci,
          passed: checks.filter((c) => c === "pass").length,
          total: checks.length,
        }
      : null,
    ahead: ahead || 0,
    behind: behind || 0,
    changes: {
      files: n(/(\d+) files? changed/),
      added: n(/(\d+) insertions?/),
      removed: n(/(\d+) deletions?/),
      untracked,
    },
  };
}

// Human-friendly token count: 120, 4.2k, 180k, 1.2M.
export const tokens = (n?: number | null): string => {
  if (n == null) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

// Human-friendly duration: 42s, 3m12s, 1h04m.
export const duration = (ms: number): string =>
  ms < 1000
    ? `${String(Math.round(ms))}ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${String(Math.floor(ms / 60_000))}m ${String(Math.round((ms % 60_000) / 1000))}s`;

export function footerText(t: {
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  cost?: number | null;
}): string {
  const u = t.usage;
  const input =
    u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
  const hit = input
    ? Math.round((100 * u.cache_read_input_tokens) / input)
    : null;
  return [
    `↑${tokens(input)}`,
    `↓${tokens(u.output_tokens)}`,
    hit == null ? null : `↺${String(hit)}%`,
    t.cost == null ? null : `$${t.cost.toFixed(2)}`,
  ]
    .filter((x): x is string => x !== null)
    .join(" ");
}

export function editStat(
  tool?: string | null,
  input?: Record<string, unknown> | null,
): string | null {
  const lines = (x: unknown): number =>
    typeof x === "string" && x ? x.split("\n").length : 0;
  if (tool === "Write") return `+${String(lines(input?.content))}`;
  const rawEdits =
    tool === "Edit"
      ? [input ?? {}]
      : tool === "MultiEdit" && Array.isArray(input?.edits)
        ? (input.edits as Record<string, unknown>[])
        : null;
  if (!rawEdits) return null;
  const added = rawEdits.reduce(
    (n, x) => n + lines(typeof x.new_string === "string" ? x.new_string : ""),
    0,
  );
  const removed = rawEdits.reduce(
    (n, x) => n + lines(typeof x.old_string === "string" ? x.old_string : ""),
    0,
  );
  return `+${String(added)} -${String(removed)}`;
}

export function fullAt(
  samples: readonly RateLimitSample[],
  resetsAt?: number | null,
): number | null {
  let s = samples.filter((x) => x.pct != null);
  let drop = -1;
  for (let i = s.length - 1; i > 0; i--) {
    const curr = s[i]?.pct;
    const prev = s[i - 1]?.pct;
    if (curr != null && prev != null && curr < prev) {
      drop = i;
      break;
    }
  }
  if (drop > 0) s = s.slice(drop);
  if (s.length < 2) return null;
  const a = s[0];
  const b = s.at(-1);
  if (!a || !b || a.pct == null || b.pct == null) return null;
  const rate = (b.pct - a.pct) / (b.at - a.at);
  if (!(rate > 0) || b.pct >= 100) return null;
  const at = b.at + (100 - b.pct) / rate;
  return resetsAt != null && at >= resetsAt ? null : at;
}

export function when(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return new Date(now).toDateString() === d.toDateString()
    ? hm
    : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] ?? ""} ${hm}`;
}

export const TONE_RGB = {
  ok: 0x7f849c,
  warn: 0xf9e2af,
  bad: 0xf38ba8,
} as const;

export function sparkCells(
  values: readonly number[],
  rows: number,
  lo = 0,
  hi = 100,
): number[] {
  const out: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (const v of values) {
      const share = (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1);
      const eighths =
        Math.max(1, Math.round(share * rows * 8)) - (rows - 1 - r) * 8;
      const level = Math.min(8, Math.max(0, eighths));
      const codePoint = level ? (BLOCKS.codePointAt(level - 1) ?? 32) : 32;
      const color =
        v >= 80 ? TONE_RGB.bad : v >= 50 ? TONE_RGB.warn : TONE_RGB.ok;
      out.push(codePoint, color, 0x01000000);
    }
  }
  return out;
}

export function sparkRange(values: readonly number[]): [number, number] {
  if (!values.length) return [0, 10];
  const lo = Math.max(0, Math.min(...values) - 2);
  return [lo, Math.min(100, Math.max(lo + 10, Math.max(...values)))];
}

export function forecast({
  percent,
  usage,
  turns = 0,
  ttlMs,
  sinceMs,
  showCtx = true,
}: ForecastFacts): ForecastResult {
  const ctx = percent == null ? null : Math.round(percent);
  const total = usage
    ? usage.cache_read_input_tokens +
      usage.cache_creation_input_tokens +
      usage.input_tokens
    : 0;
  const hit =
    total > 0
      ? Math.round((100 * (usage?.cache_read_input_tokens ?? 0)) / total)
      : null;
  const left =
    usage && ttlMs != null && sinceMs != null ? ttlMs - sinceMs : null;
  const hints: string[] = [];
  if (ctx != null && ctx >= 80) hints.push("compact soon");
  const cold = hit != null && hit < 50 && turns > 1;
  if (cold) hints.push("cache cold");
  if (left != null && left <= 0) hints.push("cache expired");
  const segments: ForecastSegment[] = [
    showCtx && ctx != null
      ? {
          kind: "ctx",
          value: `${String(ctx)}%`,
          text: `ctx ${String(ctx)}%`,
          tone: ctx >= 80 ? "bad" : ctx >= 50 ? "warn" : "ok",
        }
      : null,
    hit == null
      ? null
      : {
          kind: "cache",
          value: `${String(hit)}%`,
          text: `cache ${String(hit)}%`,
          tone: cold ? "bad" : "ok",
        },
    left !== null && left > 0
      ? {
          kind: "ttl",
          value: clock(left),
          text: `ttl ${clock(left)}`,
          tone: left <= 60_000 ? "warn" : "ok",
        }
      : null,
    ...hints.map((text): ForecastSegment => ({
      kind: "hint",
      value: text,
      text,
      tone: text === "compact soon" ? "warn" : "bad",
    })),
  ].filter((x): x is ForecastSegment => x !== null);
  const text = segments.map((x) => x.text).join(" · ");
  return { ctx, hit, left, hints, text, segments };
}
