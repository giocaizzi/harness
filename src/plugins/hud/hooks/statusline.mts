// Status lines for both CLIs (`statusLine.command`), one script: `node statusline.mjs claude` for Claude Code's two-line
// prompt (user, git, GCP, path, model, context, rate-limit windows, cost), `node statusline.mjs subagent` for Claude
// Code's agent-panel rows (`subagentStatusLine.command`), no argument for Copilot CLI's token-weather line and its running subagents. Each CLI pipes its session status as JSON on stdin. Copilot's token totals are cumulative and include cache
// reads and writes, so its hit rate is the session's, not the last turn's. No TTL: Copilot has none.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ICON, battery, forecast, glyph, tokens } from "./weather.mjs";

export interface CopilotStatusInput {
  context_window?: {
    total_input_tokens?: number;
    total_cache_read_tokens?: number;
    total_cache_write_tokens?: number;
    last_call_input_tokens?: number;
    current_context_used_percentage?: number;
    used_percentage?: number;
    displayed_context_limit?: number;
  };
  cost?: {
    total_premium_requests?: number;
  };
  transcript_path?: string;
  [key: string]: unknown;
}

export function copilotWeather(status?: CopilotStatusInput | null): string {
  const c = status?.context_window ?? {};
  const read = c.total_cache_read_tokens ?? 0;
  const write = c.total_cache_write_tokens ?? 0;
  const usage = c.total_input_tokens
    ? {
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
        input_tokens: Math.max(0, c.total_input_tokens - read - write),
      }
    : undefined;
  const turns =
    c.total_input_tokens &&
    c.total_input_tokens > (c.last_call_input_tokens ?? 0)
      ? 2
      : 1;
  const f = forecast({
    percent:
      c.current_context_used_percentage ?? c.used_percentage ?? undefined,
    usage,
    turns,
  });
  const req = status?.cost?.total_premium_requests;
  return [
    f.ctx == null ? null : `[${glyph(f.ctx)} ${String(f.ctx)}%]`,
    ...f.segments
      .filter((x) => x.kind !== "ctx")
      .map((x) => `[${ICON[x.kind] ?? ""} ${x.value}]`),
    req !== undefined && req > 0
      ? `[${ICON.cost ?? ""} ${String(req)} req]`
      : null,
  ]
    .filter((x): x is string => Boolean(x))
    .join(" ");
}

const rgb = (hex: number): string =>
  `\x1b[38;2;${String((hex >> 16) & 255)};${String((hex >> 8) & 255)};${String(hex & 255)}m`;
const C = {
  blue: rgb(0x89b4fa),
  pink: rgb(0xcba6f7),
  white: rgb(0xcdd6f4),
  red: rgb(0xf38ba8),
  yellow: rgb(0xf9e2af),
  grey: rgb(0x6c7086),
} as const;
const RESET = "\x1b[0m";
const paint = (color: string, text: string): string =>
  `${color}${text}${RESET}`;
const tone = (pct: number): string =>
  pct >= 80 ? C.red : pct >= 50 ? C.yellow : C.blue;

export function remaining(resetsAt: number, now: number): string {
  const s = resetsAt - now;
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d
    ? `${String(d)}d${String(h)}h`
    : h
      ? `${String(h)}h${String(m)}m`
      : `${String(m)}m`;
}

export function gcpProject(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: string = process.platform,
): string | undefined {
  if (env.CLOUDSDK_CORE_PROJECT) return env.CLOUDSDK_CORE_PROJECT;
  const dir =
    env.CLOUDSDK_CONFIG ??
    (platform === "win32"
      ? join(env.APPDATA ?? "", "gcloud")
      : join(home, ".config", "gcloud"));
  try {
    const readActive = (): string => {
      try {
        const val = readFileSync(join(dir, "active_config"), "utf8").trim();
        return val ? val : "default";
      } catch {
        return "default";
      }
    };
    const name = env.CLOUDSDK_ACTIVE_CONFIG_NAME ?? readActive();
    return /^\[core\][^\[]*?^project\s*=\s*(\S+)/ms.exec(
      readFileSync(join(dir, "configurations", `config_${name}`), "utf8"),
    )?.[1];
  } catch {
    return undefined;
  }
}

export interface GitBranchState {
  branch?: string;
  dirty: boolean;
}

export function gitState(cwd: string): GitBranchState | undefined {
  try {
    const out = execFileSync(
      "git",
      ["-C", cwd, "status", "--porcelain=v2", "--branch", "-uno"],
      { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] },
    );
    const lines = out.split("\n").filter(Boolean);
    const head = lines.find((l) => l.startsWith("# branch.head "))?.slice(14);
    const oid = lines.find((l) => l.startsWith("# branch.oid "))?.slice(13, 20);
    return {
      branch: head === "(detached)" ? oid : head,
      dirty: lines.some((l) => !l.startsWith("#")),
    };
  } catch {
    return undefined;
  }
}

export interface ClaudeStatusInput {
  workspace?: { current_dir?: string };
  cwd?: string;
  session_name?: string;
  session_id?: string;
  model?: { display_name?: string };
  context_window?: { used_percentage?: number };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
  cost?: { total_cost_usd?: number };
  effort?: { level?: string };
  [key: string]: unknown;
}

export interface ClaudeFactsInput {
  user?: string;
  host?: string;
  git?: GitBranchState;
  gcp?: string;
  now: number;
  home?: string;
}

export function claudeStatusline(
  status: ClaudeStatusInput,
  facts: ClaudeFactsInput,
): string {
  const cwd = status.workspace?.current_dir ?? status.cwd;
  const path = cwd
    ? facts.home && cwd.startsWith(facts.home)
      ? `~${cwd.slice(facts.home.length)}`
      : cwd
    : "~";
  const part = (icon: string, value: string, color: string): string =>
    `${paint(C.grey, "[")}${paint(color, `${icon} ${value}`)}${paint(C.grey, "]")}`;
  const line1: string[] = [
    part(ICON.user ?? "", `${facts.user ?? ""}@${facts.host ?? ""}`, C.white),
  ];
  if (facts.git?.branch)
    line1.push(
      part(
        ICON.branch ?? "",
        `${facts.git.branch}${facts.git.dirty ? " *" : ""}`,
        C.red,
      ),
    );
  if (facts.gcp) line1.push(part(ICON.cloud ?? "", facts.gcp, C.yellow));
  if (status.session_name)
    line1.push(part(ICON.session ?? "", status.session_name, C.blue));

  const line2: string[] = [part(ICON.path ?? "", path, C.pink)];
  if (status.model?.display_name)
    line2.push(part(ICON.model ?? "", status.model.display_name, C.white));
  const ctx = status.context_window?.used_percentage;
  if (ctx != null)
    line2.push(part(glyph(ctx), `${String(Math.trunc(ctx))}%`, tone(ctx)));
  const windows: [
    string,
    { used_percentage?: number; resets_at?: number } | undefined,
  ][] = [
    ["5h", status.rate_limits?.five_hour],
    ["7d", status.rate_limits?.seven_day],
  ];
  for (const [label, w] of windows) {
    if (w?.used_percentage == null) continue;
    const pct = Math.trunc(w.used_percentage);
    line2.push(
      part(
        battery(pct),
        `${label} ${String(pct)}%${w.resets_at ? ` ${remaining(w.resets_at, facts.now)}` : ""}`,
        tone(pct),
      ),
    );
  }
  const usd = status.cost?.total_cost_usd;
  if (usd != null) line2.push(part(ICON.cost ?? "", usd.toFixed(2), C.grey));
  return `${paint(C.blue, "┌")}${line1.join(" ")}\n${paint(C.blue, "└")}${line2.join(" ")}\n`;
}

export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id);
  if (!m) return id;
  const name = m[1] ?? "";
  const first = name.charAt(0).toUpperCase();
  const rest = name.slice(1);
  const major = m[2] ?? "";
  const minor = m[3] ? `.${m[3]}` : "";
  return `${first}${rest} ${major}${minor}`;
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60
    ? `${String(s)}s`
    : s < 3600
      ? `${String(Math.floor(s / 60))}m ${String(s % 60)}s`
      : `${String(Math.floor(s / 3600))}h ${String(Math.floor((s % 3600) / 60))}m`;
}

export interface TaskItem {
  id?: string;
  name?: string;
  agentType?: string;
  model?: string;
  effort?: string | number;
  status?: string;
  startTime?: number;
  tokenCount?: number;
  label?: string;
  description?: string;
}

export interface SubagentRowsInput {
  tasks?: TaskItem[];
  columns?: number;
  [key: string]: unknown;
}

export function subagentRows(
  input?: SubagentRowsInput | null,
  now: number = Date.now(),
  effort: { forced?: string; session?: string } = {},
): string {
  const tasks = input?.tasks ?? [];
  const width = Math.max(
    0,
    ...tasks.map((t) => (t.name ?? t.agentType ?? "").length),
  );
  return tasks
    .map((t) => {
      const name = (t.name ?? t.agentType ?? "").padEnd(width + 2);
      const effortVal =
        effort.forced ??
        (typeof t.effort === "number" ? tokens(t.effort) : t.effort) ??
        effort.session;
      const right = [
        t.model ? modelName(t.model) : null,
        effortVal,
        t.status === "running" && t.startTime
          ? elapsed(now - t.startTime)
          : null,
        `↓ ${tokens(t.tokenCount ?? 0)} tokens`,
      ]
        .filter((x): x is string => Boolean(x))
        .join(" · ");
      let label = t.label ?? t.description ?? "";
      const room = input?.columns
        ? input.columns - name.length - right.length - 2
        : Infinity;
      if (label.length > room)
        label = room > 1 ? `${label.slice(0, room - 1)}…` : "";
      const gap = input?.columns
        ? Math.max(2, input.columns - name.length - label.length - right.length)
        : 2;
      return JSON.stringify({
        id: t.id,
        content: `${name}${label}${" ".repeat(gap)}${paint(C.grey, right)}`,
      });
    })
    .map((line) => `${line}\n`)
    .join("");
}

export interface CopilotAgentItem {
  name?: string;
  model?: string;
  at?: number;
  effort?: string;
}

export function copilotAgents(
  events: string,
  settings: Record<string, unknown> | null | undefined,
  now: number,
): string[] {
  const running = new Map<string, CopilotAgentItem>();
  let session: string | null = null;
  for (const line of events.split("\n")) {
    if (
      !line.includes('"type":"subagent.') &&
      !line.includes('"type":"session.')
    )
      continue;
    let e: {
      type?: string;
      agentId?: string;
      timestamp?: string;
      data?: Record<string, unknown>;
    };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    const data = e.data;
    if (!data || typeof data !== "object") continue;
    const id = (e.agentId ?? data.toolCallId) as string | undefined;
    if (
      ["session.start", "session.resume", "session.model_change"].includes(
        e.type ?? "",
      ) &&
      !e.agentId &&
      "reasoningEffort" in data
    ) {
      session = data.reasoningEffort as string;
    }
    if (
      ["session.start", "session.resume", "session.shutdown"].includes(
        e.type ?? "",
      )
    ) {
      running.clear();
    }
    if (e.type === "subagent.started" && id) {
      running.set(id, {
        name: data.agentName as string | undefined,
        model: data.model as string | undefined,
        at: Date.parse(e.timestamp ?? ""),
      });
    }
    if (e.type === "subagent.configured" && id && running.has(id)) {
      const prev = running.get(id);
      running.set(id, {
        ...prev,
        model: (data.model as string | undefined) ?? prev?.model,
        effort: data.reasoningEffort as string | undefined,
      });
    }
    if (e.type === "subagent.completed" || e.type === "subagent.failed") {
      if (id) running.delete(id);
    }
  }
  const subagentsObj = (
    settings?.subagents as Record<string, unknown> | undefined
  )?.agents as Record<string, { effortLevel?: string }> | undefined;
  return [...running.values()].map((a) => {
    const set = a.name ? subagentsObj?.[a.name]?.effortLevel : undefined;
    const effort = a.effort ?? (set && set !== "inherit" ? set : session);
    const parts = [
      a.name?.split(":").pop(),
      a.model ? modelName(a.model) : null,
      effort,
      a.at !== undefined && Number.isNaN(a.at)
        ? null
        : elapsed(now - (a.at ?? now)),
    ];
    return `[${ICON.agents ?? ""} ${parts.filter((x): x is string => Boolean(x)).join(" · ")}]`;
  });
}

const effortFile = (session: string): string =>
  join(tmpdir(), `hud-effort-${session.replace(/[^\w-]/g, "")}`);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const status = JSON.parse(
      readFileSync(0, "utf8") || "{}",
    ) as ClaudeStatusInput & CopilotStatusInput;
    if (process.argv[2] === "claude") {
      const cwd = status.workspace?.current_dir ?? status.cwd;
      const home = homedir();
      if (status.session_id && status.effort?.level) {
        writeFileSync(effortFile(status.session_id), status.effort.level);
      }
      process.stdout.write(
        claudeStatusline(status, {
          user: userInfo().username,
          host: hostname().split(".")[0],
          git: cwd ? gitState(cwd) : undefined,
          gcp: gcpProject(),
          now: Math.floor(Date.now() / 1000),
          home,
        }),
      );
    } else if (process.argv[2] === "subagent") {
      let session: string | undefined;
      try {
        session = status.session_id
          ? readFileSync(effortFile(status.session_id), "utf8")
          : undefined;
      } catch {
        // no main status line drawn yet
      }
      process.stdout.write(
        subagentRows(status, Date.now(), {
          forced: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? undefined,
          session: status.effort?.level ?? session,
        }),
      );
    } else {
      const read = (...p: string[]): string => {
        try {
          return readFileSync(join(status.transcript_path ?? "", ...p), "utf8");
        } catch {
          return "";
        }
      };
      let settingsObj: Record<string, unknown> | undefined;
      try {
        settingsObj = JSON.parse(read("..", "..", "settings.json")) as Record<
          string,
          unknown
        >;
      } catch {
        // none
      }
      const agents = status.transcript_path
        ? copilotAgents(read("events.jsonl"), settingsObj, Date.now())
        : [];
      process.stdout.write(
        [copilotWeather(status), ...agents].filter(Boolean).join(" "),
      );
    }
  } catch {
    // print nothing
  }
}
