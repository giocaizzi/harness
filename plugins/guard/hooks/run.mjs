// Run contract v3: which run a hook call belongs to, from the hook process's environment. A registered run
// (AGENT_RUN_MANIFEST and AGENT_RUN_ID, loaded and pinned by hooks/registration.mjs), a run whose registration fails
// (rule run-registration), or no run. Nothing here throws.
import { RULE } from "../core/registration.mjs";
import { loadRegistration } from "./registration.mjs";
// The run this hook call belongs to. `opts` as for loadRegistration (dataDir and sessionId pin the manifest).
export function runContext(env, opts = {}) {
    try {
        const loaded = loadRegistration(env, opts);
        if (loaded.state === "deny") {
            return {
                state: "deny",
                rule: RULE,
                why: loaded.why,
                ...(loaded.pin ? { pin: true } : {}),
            };
        }
        if (loaded.state === "none") {
            return { state: "none" };
        }
        // loadRegistration checked AGENT_RUN_ID, AGENT_RUN_MODE and AGENT_RUN_TICKET as given.
        const ticket = env.AGENT_RUN_TICKET;
        const runFile = (env.AGENT_RUN_FILE ?? "").trim();
        return {
            state: "registered",
            registration: loaded.registration,
            path: loaded.path,
            sha256: loaded.sha256,
            ...(loaded.checker === undefined ? {} : { checker: loaded.checker }),
            runId: env.AGENT_RUN_ID ?? "",
            mode: env.AGENT_RUN_MODE === "attended" ? "attended" : "unattended",
            ...(ticket
                ? { ticket, ticketNumber: ticket.slice(ticket.lastIndexOf("#") + 1) }
                : {}),
            ...(runFile ? { runFile } : {}),
            extra: (env.AGENT_RUN_PROTECTED_PATHS ?? "")
                .split(/\r?\n/)
                .map((g) => g.trim())
                .filter(Boolean),
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            state: "deny",
            rule: RULE,
            why: `cannot be checked (${msg.slice(0, 100)})`,
        };
    }
}
// The shell and edit rules' facts for a registered run, or null for an attended one (result gate only).
// `at` is where the session is: the repo root and the cwd (`/` separators).
export function runFacts(run, at) {
    if (run.mode === "attended")
        return null;
    const reg = run.registration;
    const labels = reg.labels ?? {};
    const named = labels.approval !== undefined ||
        labels.takeover !== undefined ||
        (labels.protected?.length ?? 0) > 0;
    return {
        ...(named ? { labels } : {}),
        ...(reg.requires.includes("labels") && !named ? { unsure: true } : {}),
        protect: {
            ...at,
            registered: reg.protected_paths?.globs ?? [],
            exempt: reg.protected_paths?.exempt ?? [],
            extra: run.extra,
        },
    };
}
// The deny reason for a tool call, or the block reason for a stop, in a run whose registration failed.
export function denyReason(deny, at) {
    return at === "tool"
        ? `Run registration failed: ${deny.why}. Guard denies every tool call guard sees in this run until the runner fixes its registration; stop and report it.`
        : `Run registration failed: ${deny.why}. Every tool call guard sees in this run is denied until the runner fixes its registration; stop and report it.`;
}
