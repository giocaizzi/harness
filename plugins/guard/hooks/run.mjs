// Run contract v2: which run a hook call belongs to, from the hook process's environment. A registered run
// (GUARD_RUN_MANIFEST and GUARD_RUN_ID, loaded and pinned by hooks/registration.mjs), a run whose registration fails
// (rule run-registration), a session that sets only the legacy run variables (the legacy-only tripwire, rule
// run-unregistered), or no run. Guard reads no legacy variable for any decision: the tripwire only names them to fail
// loudly, and writes its one line to FACTORY_EVENTS_FILE when that is set. Nothing here throws.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RULE, UNREGISTERED_REASON, UNREGISTERED_RULE, unregisteredLine, } from "../core/registration.mjs";
import { loadRegistration } from "./registration.mjs";
// The contract v1 run variables. Any of them set (to a non-blank value) without a registration trips the tripwire.
export const LEGACY_VARS = [
    "FACTORY_RUN_ID",
    "FACTORY_ATTENDED_RUN_ID",
    "FACTORY_TICKET",
    "FACTORY_ATTENDED_TICKET",
    "FACTORY_RUN_FILE",
    "FACTORY_PROTECTED_PATHS",
    "FACTORY_EVENTS_FILE",
    "FACTORY_RESULT_CHECKER",
];
export const legacySet = (env) => LEGACY_VARS.some((k) => (env[k] ?? "").trim() !== "");
// The run this hook call belongs to. `opts` as for loadRegistration (dataDir and sessionId pin the manifest).
export function runContext(env, opts = {}) {
    try {
        const loaded = loadRegistration(env, opts);
        if (loaded.state === "deny") {
            return { state: "deny", rule: RULE, why: loaded.why };
        }
        if (loaded.state === "none") {
            return legacySet(env)
                ? { state: "deny", rule: UNREGISTERED_RULE, why: UNREGISTERED_REASON }
                : { state: "none" };
        }
        // loadRegistration checked GUARD_RUN_ID, GUARD_RUN_MODE and GUARD_RUN_TICKET as given.
        const ticket = env.GUARD_RUN_TICKET;
        const runFile = (env.GUARD_RUN_FILE ?? "").trim();
        return {
            state: "registered",
            registration: loaded.registration,
            path: loaded.path,
            sha256: loaded.sha256,
            ...(loaded.checker === undefined ? {} : { checker: loaded.checker }),
            runId: env.GUARD_RUN_ID ?? "",
            mode: env.GUARD_RUN_MODE === "attended" ? "attended" : "unattended",
            ...(ticket
                ? { ticket, ticketNumber: ticket.slice(ticket.lastIndexOf("#") + 1) }
                : {}),
            ...(runFile ? { runFile } : {}),
            extra: (env.GUARD_RUN_PROTECTED_PATHS ?? "")
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
    if (deny.rule === UNREGISTERED_RULE) {
        return at === "tool"
            ? "Legacy run variables are set without a run registration. This guard enforces run contract v2 only, so it denies every tool call guard sees until the runner registers the run with GUARD_RUN_MANIFEST; stop and report it."
            : "Legacy run variables are set without a run registration (run contract v2 needs GUARD_RUN_MANIFEST), so every tool call guard sees in this run is denied; stop and report it.";
    }
    return at === "tool"
        ? `Run registration failed: ${deny.why}. Guard denies every tool call guard sees in this run until the runner fixes its registration; stop and report it.`
        : `Run registration failed: ${deny.why}. Every tool call guard sees in this run is denied until the runner fixes its registration; stop and report it.`;
}
// Where the tripwire line always goes: guard's own log, in its data directory.
export const unregisteredLog = (dataDir) => join(dataDir, "run-unregistered.jsonl");
// Appends the tripwire's one line ({ts, event, decision, rule, reason}: no paths, no env values) to guard's own log
// and, when set, to FACTORY_EVENTS_FILE: once per session when `sessionId` is given (a marker file next to the
// session's pin), on every call otherwise. Best effort: a failed write is dropped and the deny stands.
export function recordUnregistered(env, dataDir, sessionId, now = new Date()) {
    try {
        if (sessionId) {
            const marker = join(join(dataDir, "sessions"), `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.unregistered`);
            try {
                mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
                writeFileSync(marker, "", { flag: "wx" });
            }
            catch (e) {
                if (e.code === "EEXIST")
                    return;
            }
        }
        const line = `${unregisteredLine(now.toISOString())}\n`;
        const legacy = (env.FACTORY_EVENTS_FILE ?? "").trim();
        if (legacy) {
            try {
                appendFileSync(legacy, line);
            }
            catch {
                // unwritable path: the deny stands
            }
        }
        try {
            mkdirSync(dataDir, { recursive: true, mode: 0o700 });
            appendFileSync(unregisteredLog(dataDir), line);
        }
        catch {
            // unwritable data dir: the deny stands
        }
    }
    catch {
        // never throws
    }
}
