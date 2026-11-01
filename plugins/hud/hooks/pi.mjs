import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { linkRepo } from "./links.mjs";
import { createFacts, FEATURES, fetchState, refsRule, rewrite, settings, } from "./rewrite.mjs";
import { azurePr, forgeOf, githubPr, gitlabMr, glyph, ICON, repoState, } from "./weather.mjs";
export function piStatus({ pct, model, repo, agents = [], }) {
    const parts = [];
    if (pct != null)
        parts.push(`[${glyph(pct)} ctx:${String(Math.round(pct))}%]`);
    if (model)
        parts.push(`[${ICON.model ?? ""} ${model}]`);
    const pr = repo?.pr;
    if (pr) {
        const icon = pr.state === "merged"
            ? (ICON.merged ?? "")
            : pr.ci === "pending"
                ? (ICON.pending ?? "")
                : (ICON.pr ?? "");
        const ci = pr.ci === "fail"
            ? " ✗"
            : pr.total
                ? ` ${String(pr.passed)}/${String(pr.total)}`
                : "";
        parts.push(`[${icon} #${String(pr.number)}${pr.state === "open" ? ci : ` ${pr.state}`}]`);
    }
    if (repo?.ahead || repo?.behind)
        parts.push(`[${ICON.sync ?? ""} ↑${String(repo.ahead)} ↓${String(repo.behind)}]`);
    const c = repo?.changes;
    if (c && (c.files || c.untracked))
        parts.push(`[${ICON.changes ?? ""} ${String(c.files + c.untracked)} +${String(c.added)} -${String(c.removed)}]`);
    for (const a of agents)
        parts.push(`[${ICON.agents ?? ""} ${[a.agent, a.model, a.thinking].filter((x) => Boolean(x)).join(" · ")}]`);
    return parts.join(" ");
}
const run = (argv, cwd) => new Promise((resolve) => execFile(argv[0] ?? "", argv.slice(1), { cwd, timeout: 8000, windowsHide: true }, (err, out) => {
    resolve(err ? null : out);
}));
export async function readRepo(cwd, exec = run) {
    const j = async (argv) => {
        try {
            return JSON.parse((await exec(argv, cwd)) ?? "null");
        }
        catch {
            return null;
        }
    };
    const forge = forgeOf((await exec(["git", "remote", "get-url", "origin"], cwd))?.trim());
    let pr = null;
    if (forge === "github")
        pr = githubPr((await j([
            "gh",
            "pr",
            "view",
            "--json",
            "number,url,state,statusCheckRollup",
        ])));
    if (forge === "gitlab")
        pr = gitlabMr((await j(["glab", "mr", "view", "--output", "json"])));
    if (forge === "azure") {
        const branch = (await exec(["git", "branch", "--show-current"], cwd))?.trim();
        const list = branch
            ? (await j([
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
            ]))
            : null;
        const id = list?.[0]
            ?.pullRequestId;
        pr = azurePr(list, id
            ? (await j([
                "az",
                "repos",
                "pr",
                "policy",
                "list",
                "--id",
                String(id),
                "--output",
                "json",
            ]))
            : null);
    }
    const counts = await exec(["git", "rev-list", "--left-right", "--count", "@{u}...HEAD"], cwd);
    return {
        ...repoState(pr, counts, await exec(["git", "diff", "--shortstat", "HEAD"], cwd), await exec(["git", "status", "--porcelain"], cwd)),
        links: await linkRepo((argv) => exec(argv, cwd)),
    };
}
export function rewriteMessage(message, fn) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
        return null;
    let changed = false;
    const content = [];
    for (const b of message.content) {
        if (b.type !== "text" || typeof b.text !== "string") {
            content.push(b);
            continue;
        }
        const text = fn(b.text);
        if (text !== b.text)
            changed = true;
        content.push(text === b.text ? b : { ...b, text });
    }
    return changed ? { ...message, content } : null;
}
export const PI_DEFAULTS = { replyTimes: "off" };
export function piOptions(env = process.env, read = (p) => readFileSync(p, "utf8")) {
    const dir = env.PI_CODING_AGENT_DIR ??
        join(env.HOME ?? env.USERPROFILE ?? homedir(), ".pi", "agent");
    try {
        return {
            ...PI_DEFAULTS,
            ...JSON.parse(read(join(dir, "hud.json"))),
        };
    }
    catch {
        return { ...PI_DEFAULTS };
    }
}
export const piFacts = (cwd, exec = run) => createFacts({
    stat: async (p) => {
        try {
            const s = await stat(p);
            return s.isDirectory() ? "dir" : s.isFile() ? "file" : null;
        }
        catch {
            return null;
        }
    },
    commit: async (sha) => (await exec(["git", "cat-file", "-e", `${sha}^{commit}`], cwd)) !== null,
    state: (r, ref) => fetchState((argv) => exec(argv, cwd), r, ref),
});
const SETTLE_MS = 1500;
export default function hudExtension(pi, deps = {}) {
    let repo = null;
    let facts = null;
    const agents = new Map();
    const draw = (ctx) => {
        try {
            if (!ctx.hasUI)
                return;
            const getUsage = ctx.getContextUsage;
            const usage = getUsage?.();
            const pct = usage?.percent ?? null;
            const modelObj = ctx.model;
            const ui = ctx.ui;
            ui.setStatus("hud", piStatus({
                pct,
                model: modelObj?.id,
                repo,
                agents: [...agents.values()],
            }));
        }
        catch {
            // ignore
        }
    };
    const refresh = async (ctx) => {
        try {
            repo = await (deps.readRepo ?? readRepo)(ctx.cwd);
        }
        catch {
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
        if (e.toolName !== "subagent")
            return;
        const args = e.args;
        const modelObj = ctx.model;
        agents.set(e.toolCallId, {
            agent: args?.agent,
            model: modelObj?.id,
        });
        draw(ctx);
    });
    pi.on("tool_execution_update", (e, ctx) => {
        const callId = e.toolCallId;
        const a = agents.get(callId);
        const partial = e.partialResult;
        const d = partial?.details;
        if (!a || !d?.thinking)
            return;
        agents.set(callId, {
            ...a,
            model: typeof d.model === "string" ? d.model.split("/").pop() : a.model,
            thinking: d.thinking,
        });
        draw(ctx);
    });
    pi.on("tool_execution_end", (e, ctx) => {
        if (agents.delete(e.toolCallId))
            draw(ctx);
    });
    pi.registerCommand?.("refresh-refs", {
        description: "Look up the issue and PR states, files and commits in the next replies again",
        handler: async (_args, ctx) => {
            await Promise.resolve();
            facts = null;
            const ui = ctx.ui;
            ui?.notify?.("hud: lookups cleared; the next replies look them up again.", "info");
        },
    });
    pi.on("before_agent_start", (e) => {
        const opts = e.systemPromptOptions;
        if (!opts)
            return;
        const rule = refsRule(repo?.links ?? null, settings(deps.options ?? piOptions(), process.env, false));
        if (!rule)
            return;
        const g = (opts.promptGuidelines ??= []);
        if (!g.includes(rule))
            g.push(rule);
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
            facts ??= (deps.facts ?? piFacts)(ctx.cwd);
            const c = {
                repo: repo?.links ?? null,
                cwd: ctx.cwd,
                home: process.env.HOME ?? process.env.USERPROFILE,
                now: Date.now(),
            };
            const once = () => rewriteMessage(e.message, (t) => rewrite(t, o, c, facts));
            let message = once();
            if (facts.pending) {
                await facts.settle(SETTLE_MS);
                message = once();
            }
            return message ? { message } : undefined;
        }
        catch {
            return undefined;
        }
    });
}
