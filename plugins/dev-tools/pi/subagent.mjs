// pi extension: the plugins' agents (scout, escalate, api-reviewer, verifier) as a `subagent` tool, since pi has no subagents.
// Each call runs the agent in its own `pi -p --no-session` process with the agent's prompt appended and its tools
// narrowed, on the session's model at the agent's effort; the final text comes back as the tool result. Loaded from the root package.json.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MAX_DEPTH, PLUGINS, THINKING, TOOLS } from "./constants.mjs";
export { MAX_DEPTH } from "./constants.mjs";
/** Load the Claude-format agents every plugin ships (`agents/*.md`). */
export function loadAgents(root = PLUGINS) {
    const agents = [];
    for (const plugin of readdirSync(root)) {
        const dir = join(root, plugin, "agents");
        if (!existsSync(dir))
            continue;
        for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
            const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(readFileSync(join(dir, file), "utf8"));
            const frontmatterText = m?.[1];
            const promptBody = m?.[2];
            if (frontmatterText === undefined || promptBody === undefined)
                continue;
            const fm = {};
            for (const match of frontmatterText.matchAll(/^(\w+):\s*(.*)$/gm)) {
                const key = match[1];
                const value = match[2];
                if (key !== undefined && value !== undefined) {
                    fm[key] = value.trim();
                }
            }
            const tools = fm.tools
                ? [
                    ...new Set(fm.tools
                        .split(",")
                        .flatMap((t) => TOOLS[t.trim().toLowerCase()] ?? [])),
                ]
                : null;
            const effort = fm.effort;
            const thinking = effort !== undefined && THINKING.has(effort) ? effort : undefined;
            const configuredName = fm.name;
            agents.push({
                name: configuredName !== undefined && configuredName.length > 0
                    ? configuredName
                    : basename(file, ".md"),
                description: fm.description ?? "",
                tools,
                thinking,
                prompt: promptBody.trim(),
            });
        }
    }
    return agents;
}
/** Build the `pi` argv for a single subagent invocation. */
export function piArgs(agent, task, promptFile, model) {
    return [
        "-p",
        "--no-session",
        ...(model ? ["--model", model] : []),
        ...(agent.thinking ? ["--thinking", agent.thinking] : []),
        ...(agent.tools?.length ? ["--tools", agent.tools.join(",")] : []),
        "--append-system-prompt",
        promptFile,
        `Task: ${task}`,
    ];
}
// How to start pi again: the running entry point under the same node, else `pi` on PATH.
const piCommand = () => {
    const entry = process.argv[1];
    return entry && existsSync(entry) ? [process.execPath, entry] : ["pi"];
};
// The child's environment: the guard's stop check and factory result gate are off there, since the parent's own stop
// runs them once the subagent's work is part of its turn; and the guard keeps the child's reminders as its own agent's within the
// parent session, so the skills either loads count for both.
// `PI_SUBAGENT_DEPTH` counts the nesting: an agent without a `tools` list (driver, escalate) gets this tool again in its
// child, so a driver can fan out to workers, and the tool refuses past `MAX_DEPTH` (Claude Code's default limit).
/** Return the current subagent nesting depth from `PI_SUBAGENT_DEPTH`. */
export const depthOf = (env = process.env) => Number.parseInt(env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
/** Build the child environment with guard stop checks off and nesting depth incremented. */
export const childEnv = (env = process.env, { session, agent } = {}) => ({
    ...env,
    GUARD_STOP_CHECK: "off",
    GUARD_RESULT_GATE: "off",
    PI_SUBAGENT_DEPTH: String(depthOf(env) + 1),
    ...(session ? { GUARD_PARENT_SESSION: session, GUARD_AGENT_ID: agent } : {}),
});
function run(argv, cwd, signal, ids) {
    return new Promise((resolve) => {
        const command = argv[0];
        if (!command) {
            resolve({ code: 1, out: "", err: "Missing command" });
            return;
        }
        const child = spawn(command, argv.slice(1), {
            cwd,
            signal,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env: childEnv(process.env, ids),
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => {
            out += d.toString();
        });
        child.stderr.on("data", (d) => {
            err += d.toString();
        });
        child.on("error", (e) => {
            resolve({ code: 1, out, err: err + e.message });
        });
        child.on("close", (code) => {
            resolve({ code, out, err });
        });
    });
}
/** Register the `subagent` tool on a pi extension host. */
export default function subagentExtension(pi, deps = {}) {
    const agents = (deps.loadAgents ?? loadAgents)();
    if (!agents.length)
        return;
    const list = agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
    pi.registerTool({
        name: "subagent",
        label: "Subagent",
        description: `Run a task in a separate pi session as one of these agents, and get its final answer:\n${list}`,
        parameters: {
            type: "object",
            properties: {
                agent: {
                    type: "string",
                    enum: agents.map((a) => a.name),
                    description: "Agent name",
                },
                task: {
                    type: "string",
                    description: "Self-contained brief: goal, scope, what to report",
                },
            },
            required: ["agent", "task"],
        },
        async execute(id, params, signal, onUpdate, ctx) {
            const agent = agents.find((a) => a.name === params.agent);
            if (!agent) {
                throw new Error(`Unknown agent ${params.agent}; one of ${agents.map((a) => a.name).join(", ")}`);
            }
            if (depthOf() >= MAX_DEPTH) {
                throw new Error(`Subagents nest at most ${String(MAX_DEPTH)} deep; return the split to your caller instead of spawning ${agent.name}`);
            }
            if (depthOf() > 0 &&
                (params.agent === "driver" || params.agent === "escalate")) {
                throw new Error(`A subagent cannot spawn another ${params.agent}: you are already running at the judgement tier. Plan or investigate directly, then fan edits out to workers.`);
            }
            const dir = mkdtempSync(join(tmpdir(), "pi-subagent-"));
            try {
                const file = join(dir, `${agent.name}.md`);
                writeFileSync(file, agent.prompt);
                const model = ctx?.model
                    ? `${ctx.model.provider}/${ctx.model.id}`
                    : undefined;
                // The child's model and thinking level, before it starts, for extensions that show them (hud).
                onUpdate?.({
                    content: [],
                    details: {
                        model,
                        ...(agent.thinking ? { thinking: agent.thinking } : {}),
                    },
                });
                const configuredSession = process.env.GUARD_PARENT_SESSION;
                const session = configuredSession !== undefined && configuredSession.length > 0
                    ? configuredSession
                    : ctx?.sessionManager?.getSessionId?.();
                const r = await (deps.run ?? run)([...piCommand(), ...piArgs(agent, params.task, file, model)], ctx?.cwd, signal, { session, agent: `${agent.name}-${id}` });
                if (r.code !== 0) {
                    throw new Error(`${agent.name} failed (exit ${String(r.code)}): ${(r.err || r.out).trim().slice(-2000)}`);
                }
                return {
                    content: [{ type: "text", text: r.out.trim() || "(no output)" }],
                    details: undefined,
                };
            }
            finally {
                rmSync(dir, { recursive: true, force: true });
            }
        },
    });
}
