// The guard for harnesses that load plugins in-process (opencode, pi) rather than running command hooks: each
// event is turned into the Claude-shaped payload the command hooks get and passed to the same handlers, so the
// rules behave alike everywhere. opencode.mjs and pi.mjs only map their harness's events onto these calls.
import { spawn } from "node:child_process";
import { cmdClass } from "../core/engine.mjs";
import { emit } from "../core/otel.mjs";
import { keepAwake } from "./awake.mjs";
import { fallbackDataDir } from "./data.mjs";
import { crashResult, handle, hostFacts, pythonManager, run, } from "./guard.mjs";
import { lintFile } from "./lint.mjs";
import { createRegistrationCache } from "./registration.mjs";
import { gateFailClosed, stopCheck } from "./stop.mjs";
import { recordAttrs } from "./telemetry.mjs";
// Neither harness gives plugins a data dir; the same fallback as VS Code.
export const DATA_DIR = fallbackDataDir();
const launchDetached = (argv) => {
    const exe = argv[0];
    if (!exe)
        return undefined;
    const child = spawn(exe, argv.slice(1), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    });
    child.on("error", () => {
        // ignored
    });
    child.unref();
    return child.pid;
};
// `harness` names it in telemetry; `noAsk` turns an ask into a deny where the harness cannot ask, unless
// `deps.nativeAsk(command, rule, input)` says the harness's own prompt covers it.
export function createGuard({ harness, noAsk = false, dataDir = DATA_DIR, deps = {}, }) {
    // one per bridge: the parsed run manifest is reused while its file is unchanged
    const registrationCache = createRegistrationCache();
    const d = {
        dataDir,
        harness,
        processId: process.pid,
        env: process.env,
        hostFacts,
        run,
        pythonManager,
        noAsk,
        registrationCache,
        emit: (event, attrs, cwd) => emit(process.env, event, recordAttrs(attrs, cwd, harness)),
        // The harness's own usage, as the harness (service.name opencode or pi): neither exports telemetry itself.
        report: (event, attrs) => emit(process.env, event, attrs, fetch, harness),
        ...deps,
    };
    // The stop gate's options: the same cache, data dir and (tests only) trust probes as the tool hooks.
    const gateOpts = () => ({
        ...d.runVet,
        cache: registrationCache,
        dataDir: d.dataDir,
        inProcess: true,
    });
    const call = async (input) => {
        try {
            const out = await handle(input, d);
            const o = out.stdout ? JSON.parse(out.stdout) : {};
            return {
                ...o.hookSpecificOutput,
                systemMessage: o.systemMessage,
            };
        }
        catch {
            // A crash lets the call through, except a tool call in a run, which is denied (as in the command hook).
            const o = JSON.parse(crashResult(input, d.env, harness).stdout ?? "{}");
            return { ...o.hookSpecificOutput };
        }
    };
    return {
        // { decision: 'deny'|'ask'|undefined, reason, context, notice } for a tool call; `notice` is for the user. `tool` is the harness's tool name,
        // lower-cased; `input` its arguments (a shell call carries `command`).
        // `agentId`: a subagent's own id, whose reminders are its own while `sessionId` is the session it belongs to.
        async preTool({ sessionId, agentId, cwd, tool, input, }) {
            const o = await call({
                hook_event_name: "PreToolUse",
                session_id: sessionId,
                agent_id: agentId,
                cwd,
                tool_name: tool,
                tool_input: input,
            });
            const specific = o;
            return {
                decision: specific.permissionDecision,
                reason: specific.permissionDecisionReason,
                context: specific.additionalContext,
                notice: o.systemMessage,
            };
        },
        prompt: ({ sessionId, agentId, cwd, prompt, }) => call({
            hook_event_name: "UserPromptSubmit",
            session_id: sessionId,
            agent_id: agentId,
            cwd,
            prompt,
        }),
        // The session's start: one `guard.session` record with the installed plugin versions.
        sessionStart: ({ sessionId, cwd, source, }) => call({
            hook_event_name: "SessionStart",
            session_id: sessionId,
            cwd,
            source,
        }),
        sessionEnd: ({ sessionId, }) => call({
            hook_event_name: "SessionEnd",
            session_id: sessionId,
        }),
        // The answer to an ask the harness showed itself (pi's confirm): allow, deny, or unavailable with no UI.
        askResult: ({ sessionId, cwd, tool, command, result, waitMs, via, }) => Promise.resolve(d.emit?.("guard.ask_result", {
            result,
            wait_ms: waitMs,
            via,
            tool,
            cmd_class: command ? cmdClass(null, command) : "tool",
            session_id: sessionId,
        }, cwd)).catch(() => {
            // ignored
        }),
        // Lint findings for an edit, or null.
        postTool({ cwd, tool, input, }) {
            try {
                const res = lintFile({ cwd, tool_name: tool, tool_input: input }, d.spawnSync);
                return res?.additionalContext ?? null;
            }
            catch {
                return null;
            }
        },
        // The reason to keep going (the run result gate or make check), or null. `active` is true when the last stop was already blocked.
        // Async: make runs detached, so the harness's event loop keeps going meanwhile.
        async stop({ cwd, active, sessionId, agentId, }) {
            try {
                const out = await stopCheck({
                    cwd,
                    stop_hook_active: active,
                    session_id: sessionId,
                    agent_id: agentId,
                }, d.spawnSync, {
                    gate: gateOpts(),
                    report: (attrs) => {
                        void d.emit?.("guard.stop", { ...attrs, cmd_class: "stop" }, cwd);
                    },
                });
                return out?.decision === "block" ? (out.reason ?? null) : null;
            }
            catch {
                // stopCheck reads process.env: a registered run's result gate, or a failed registration, keeps the stop blocked
                return gateFailClosed(process.env, { cwd, session_id: sessionId, agent_id: agentId }, "internal error", gateOpts());
            }
        },
        // One model response: { sessionId, model, provider, tokens: { input, output, cacheRead, cacheWrite, reasoning }, costUsd }.
        // Named like Claude Code's api_request, so one query covers every harness. Never throws.
        usage({ sessionId, model, provider, tokens = {}, costUsd, }) {
            const n = (v) => Number.isFinite(Number(v)) ? Number(v) : undefined;
            return Promise.resolve(d.report?.("api_request", {
                "session.id": sessionId,
                model,
                provider,
                input_tokens: n(tokens.input),
                output_tokens: n(tokens.output),
                cache_read_tokens: n(tokens.cacheRead),
                cache_creation_tokens: n(tokens.cacheWrite),
                reasoning_tokens: n(tokens.reasoning),
                cost_usd: n(costUsd),
            })).catch(() => {
                // ignored
            });
        },
        // In-process: the harness is this process.
        awake() {
            try {
                return keepAwake({
                    dataDir,
                    start: process.pid,
                    launch: d.launch ?? launchDetached,
                });
            }
            catch {
                return null;
            }
        },
    };
}
