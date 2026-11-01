import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { linkRepo } from "./links.mjs";
import {
  createFacts,
  FEATURES,
  fetchState,
  refsRule,
  rewrite,
  settings,
} from "./rewrite.mjs";
import {
  azurePr,
  forgeOf,
  githubPr,
  gitlabMr,
  glyph,
  ICON,
  repoState,
} from "./weather.mjs";
import type {
  Facts,
  ForgeRepoInfo,
  RepoState,
  WorkItemReference,
} from "./types.mjs";

export interface PiStatusArgs {
  pct?: number | null;
  model?: string | null;
  repo?: (RepoState & { links?: ForgeRepoInfo | null }) | null;
  agents?: { agent?: string; model?: string; thinking?: string }[];
}

export function piStatus({
  pct,
  model,
  repo,
  agents = [],
}: PiStatusArgs): string {
  const parts: string[] = [];
  if (pct != null)
    parts.push(`[${glyph(pct)} ctx:${String(Math.round(pct))}%]`);
  if (model) parts.push(`[${ICON.model ?? ""} ${model}]`);
  const pr = repo?.pr;
  if (pr) {
    const icon =
      pr.state === "merged"
        ? (ICON.merged ?? "")
        : pr.ci === "pending"
          ? (ICON.pending ?? "")
          : (ICON.pr ?? "");
    const ci =
      pr.ci === "fail"
        ? " ✗"
        : pr.total
          ? ` ${String(pr.passed)}/${String(pr.total)}`
          : "";
    parts.push(
      `[${icon} #${String(pr.number)}${pr.state === "open" ? ci : ` ${pr.state}`}]`,
    );
  }
  if (repo?.ahead || repo?.behind)
    parts.push(
      `[${ICON.sync ?? ""} ↑${String(repo.ahead)} ↓${String(repo.behind)}]`,
    );
  const c = repo?.changes;
  if (c && (c.files || c.untracked))
    parts.push(
      `[${ICON.changes ?? ""} ${String(c.files + c.untracked)} +${String(c.added)} -${String(c.removed)}]`,
    );
  for (const a of agents)
    parts.push(
      `[${ICON.agents ?? ""} ${[a.agent, a.model, a.thinking].filter((x): x is string => Boolean(x)).join(" · ")}]`,
    );
  return parts.join(" ");
}

const run = (argv: string[], cwd?: string): Promise<string | null> =>
  new Promise((resolve) =>
    execFile(
      argv[0] ?? "",
      argv.slice(1),
      { cwd, timeout: 8000, windowsHide: true },
      (err, out) => {
        resolve(err ? null : out);
      },
    ),
  );

export async function readRepo(
  cwd: string,
  exec: (argv: string[], cwd?: string) => Promise<string | null> = run,
): Promise<RepoState & { links: ForgeRepoInfo | null }> {
  const j = async (argv: string[]): Promise<Record<string, unknown> | null> => {
    try {
      return JSON.parse((await exec(argv, cwd)) ?? "null") as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  };
  const forge = forgeOf(
    (await exec(["git", "remote", "get-url", "origin"], cwd))?.trim(),
  );
  let pr = null;
  if (forge === "github")
    pr = githubPr(
      (await j([
        "gh",
        "pr",
        "view",
        "--json",
        "number,url,state,statusCheckRollup",
      ])) as never,
    );
  if (forge === "gitlab")
    pr = gitlabMr(
      (await j(["glab", "mr", "view", "--output", "json"])) as never,
    );
  if (forge === "azure") {
    const branch = (
      await exec(["git", "branch", "--show-current"], cwd)
    )?.trim();
    const list = branch
      ? ((await j([
          "az",
          "repos",
          "pr",
          "list",
          "--source-branch",
          branch,
          "--status",
          "all",
          "--top",
          "1",
          "--output",
          "json",
        ])) as never)
      : null;
    const id = (list as { pullRequestId?: number }[] | null)?.[0]
      ?.pullRequestId;
    pr = azurePr(
      list,
      id
        ? ((await j([
            "az",
            "repos",
            "pr",
            "policy",
            "list",
            "--id",
            String(id),
            "--output",
            "json",
          ])) as never)
        : null,
    );
  }
  const counts = await exec(
    ["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"],
    cwd,
  );
  return {
    ...repoState(
      pr,
      counts,
      await exec(["git", "diff", "--shortstat", "HEAD"], cwd),
      await exec(["git", "status", "--porcelain"], cwd),
    ),
    links: await linkRepo((argv) => exec(argv, cwd)),
  };
}

export interface PiMessageBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface PiMessage {
  role: string;
  content: PiMessageBlock[];
  [key: string]: unknown;
}

export function rewriteMessage(
  message: PiMessage,
  fn: (text: string) => string,
): PiMessage | null {
  if (message.role !== "assistant" || !Array.isArray(message.content))
    return null;
  let changed = false;
  const content: PiMessageBlock[] = [];
  for (const b of message.content) {
    if (b.type !== "text" || typeof b.text !== "string") {
      content.push(b);
      continue;
    }
    const text = fn(b.text);
    if (text !== b.text) changed = true;
    content.push(text === b.text ? b : { ...b, text });
  }
  return changed ? { ...message, content } : null;
}

export const PI_DEFAULTS = { replyTimes: "off" } as const;

export function piOptions(
  env: NodeJS.ProcessEnv = process.env,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Record<string, unknown> {
  const dir =
    env.PI_CODING_AGENT_DIR ??
    join(env.HOME ?? env.USERPROFILE ?? homedir(), ".pi", "agent");
  try {
    return {
      ...PI_DEFAULTS,
      ...(JSON.parse(read(join(dir, "hud.json"))) as Record<string, unknown>),
    };
  } catch {
    return { ...PI_DEFAULTS };
  }
}

export const piFacts = (
  cwd: string,
  exec: (argv: string[], cwd?: string) => Promise<string | null> = run,
): Facts =>
  createFacts({
    stat: async (p: string) => {
      try {
        const s = await stat(p);
        return s.isDirectory() ? "dir" : s.isFile() ? "file" : null;
      } catch {
        return null;
      }
    },
    commit: async (sha: string) =>
      (await exec(["git", "cat-file", "-e", `${sha}^{commit}`], cwd)) !== null,
    state: (r: ForgeRepoInfo, ref: WorkItemReference) =>
      fetchState((argv) => exec(argv, cwd), r, ref),
  });

const SETTLE_MS = 1500;

export interface PiExtensionApi {
  on: (
    event: string,
    handler: (
      e: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Promise<unknown> | undefined,
  ) => void;
  registerCommand?: (
    name: string,
    command: {
      description: string;
      handler: (args: string, ctx: Record<string, unknown>) => Promise<void>;
    },
  ) => void;
}

export interface PiDeps {
  readRepo?: (
    cwd: string,
  ) => Promise<RepoState & { links: ForgeRepoInfo | null }>;
  options?: Record<string, unknown>;
  facts?: (cwd: string) => Facts;
  hyperlinks?: () => Promise<boolean>;
}

export default function hudExtension(
  pi: PiExtensionApi,
  deps: PiDeps = {},
): void {
  let repo: (RepoState & { links: ForgeRepoInfo | null }) | null = null;
  let facts: Facts | null = null;
  const agents = new Map<
    string,
    { agent?: string; model?: string; thinking?: string }
  >();
  const draw = (ctx: Record<string, unknown>): void => {
    try {
      if (!ctx.hasUI) return;
      const getUsage = ctx.getContextUsage as
        (() => { percent?: number }) | undefined;
      const usage = getUsage?.();
      const pct = usage?.percent ?? null;
      const modelObj = ctx.model as { id?: string } | undefined;
      const ui = ctx.ui as { setStatus: (k: string, v: string) => void };
      ui.setStatus(
        "hud",
        piStatus({
          pct,
          model: modelObj?.id,
          repo,
          agents: [...agents.values()],
        }),
      );
    } catch {
      // ignore
    }
  };
  const refresh = async (ctx: Record<string, unknown>): Promise<void> => {
    try {
      repo = await (deps.readRepo ?? readRepo)(ctx.cwd as string);
    } catch {
      repo = null;
    }
    draw(ctx);
  };
  pi.on("session_start", (_e, ctx) => {
    facts = null;
    agents.clear();
    void refresh(ctx);
  });
  pi.on("turn_end", (_e, ctx) => {
    draw(ctx);
  });
  pi.on("tool_execution_start", (e, ctx) => {
    if (e.toolName !== "subagent") return;
    const args = e.args as { agent?: string } | undefined;
    const modelObj = ctx.model as { id?: string } | undefined;
    agents.set(e.toolCallId as string, {
      agent: args?.agent,
      model: modelObj?.id,
    });
    draw(ctx);
  });
  pi.on("tool_execution_update", (e, ctx) => {
    const callId = e.toolCallId as string;
    const a = agents.get(callId);
    const partial = e.partialResult as
      { details?: { model?: string; thinking?: string } } | undefined;
    const d = partial?.details;
    if (!a || !d?.thinking) return;
    agents.set(callId, {
      ...a,
      model: typeof d.model === "string" ? d.model.split("/").pop() : a.model,
      thinking: d.thinking,
    });
    draw(ctx);
  });
  pi.on("tool_execution_end", (e, ctx) => {
    if (agents.delete(e.toolCallId as string)) draw(ctx);
  });
  pi.registerCommand?.("refresh-refs", {
    description:
      "Look up the issue and PR states, files and commits in the next replies again",
    handler: async (_args, ctx) => {
      await Promise.resolve();
      facts = null;
      const ui = ctx.ui as
        { notify?: (msg: string, type: string) => void } | undefined;
      ui?.notify?.(
        "hud: lookups cleared; the next replies look them up again.",
        "info",
      );
    },
  });
  pi.on("before_agent_start", (e) => {
    const opts = e.systemPromptOptions as
      { promptGuidelines?: string[] } | undefined;
    if (!opts) return;
    const rule = refsRule(
      repo?.links ?? null,
      settings(deps.options ?? piOptions(), process.env, false),
    );
    if (!rule) return;
    const g = (opts.promptGuidelines ??= []);
    if (!g.includes(rule)) g.push(rule);
  });
  pi.on("agent_settled", (_e, ctx) => void refresh(ctx));
  pi.on("message_end", async (e, ctx) => {
    try {
      const links = Boolean(ctx.hasUI) && Boolean(await deps.hyperlinks?.());
      const all = settings(deps.options ?? piOptions(), process.env, false);
      const secrets = all.f.replySecrets && { glyph: false, colour: false };
      const o = links
        ? all
        : {
            ...all,
            f: {
              ...Object.fromEntries(FEATURES.map((k) => [k, null])),
              replySecrets: secrets,
            },
          };
      facts ??= (deps.facts ?? piFacts)(ctx.cwd as string);
      const c = {
        repo: repo?.links ?? null,
        cwd: ctx.cwd as string,
        home: process.env.HOME ?? process.env.USERPROFILE,
        now: Date.now(),
      };
      const once = (): PiMessage | null =>
        rewriteMessage(e.message as PiMessage, (t) =>
          rewrite(t, o as never, c, facts as never),
        );
      let message = once();
      if (facts.pending) {
        await facts.settle(SETTLE_MS);
        message = once();
      }
      return message ? { message } : undefined;
    } catch {
      return undefined;
    }
  });
}
