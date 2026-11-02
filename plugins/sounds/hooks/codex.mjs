#!/usr/bin/env node
// Codex Stop hook: sounds' turn and context alerts. Codex's Stop payload names the turn and its rollout
// (`transcript_path`); the rollout holds the turn's start (`task_started`), errors and token counts against the
// model's context window. The finished turn plays its default clip (macOS only) and the notices go back as
// `systemMessage`, which Codex shows as a warning. Named only by .generated/codex/hooks.json (from
// hooks/codex-only.json); never fails the hook.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CLIPS, settle } from "./alerts.mjs";
import { afplay } from "./play.mjs";
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isAlertLevel = (value) => value === 0 || value === 80 || value === 90 || value === 100;
const parseAlertLevels = (raw) => {
    try {
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed))
            return {};
        const levels = {};
        if (isAlertLevel(parsed.ctx))
            levels.ctx = parsed.ctx;
        if (isAlertLevel(parsed.five_hour))
            levels.five_hour = parsed.five_hour;
        if (isAlertLevel(parsed.seven_day))
            levels.seven_day = parsed.seven_day;
        if (isAlertLevel(parsed.spend_limit)) {
            levels.spend_limit = parsed.spend_limit;
        }
        return levels;
    }
    catch {
        return {};
    }
};
/** Extract turn start time, error state, and context percentage from rollout JSONL lines. */
export function turnFacts(lines, turnId) {
    let startedMs = null;
    let error = false;
    let pct = null;
    for (const line of lines) {
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (!isRecord(entry) || entry.type !== "event_msg")
            continue;
        const payload = isRecord(entry.payload) ? entry.payload : null;
        if (!payload)
            continue;
        if (payload.type === "task_started" &&
            payload.turn_id === turnId &&
            typeof payload.started_at === "number") {
            startedMs = payload.started_at * 1000;
            error = false;
        }
        else if (payload.type === "error") {
            error = true;
        }
        else if (payload.type === "token_count" && isRecord(payload.info)) {
            const windowSize = payload.info.model_context_window;
            const usage = isRecord(payload.info.last_token_usage)
                ? payload.info.last_token_usage.total_tokens
                : undefined;
            if (typeof windowSize === "number" &&
                windowSize > 0 &&
                typeof usage === "number") {
                pct = Math.round((usage / windowSize) * 100);
            }
        }
    }
    return { startedMs, error, pct };
}
/** Settle a Codex Stop hook turn, persist context alert levels, play clips, and return any system notice. */
export function stop(payload, { now = Date.now(), dataDir, read = (filePath) => readFileSync(filePath, "utf8"), play = afplay, }) {
    const facts = turnFacts(read(payload.transcript_path).split("\n"), payload.turn_id);
    const statePath = join(dataDir, `sounds-codex-${payload.session_id.replace(/[^\w-]/g, "")}.json`);
    let before = {};
    try {
        before = parseAlertLevels(read(statePath));
    }
    catch {
        // first turn of the session
    }
    const result = settle({
        durationMs: facts.startedMs === null ? 0 : now - facts.startedMs,
        error: facts.error,
        pct: facts.pct,
        before,
    });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(result.now));
    for (const clip of result.clips)
        play(clip);
    return result.notices.length > 0
        ? { systemMessage: result.notices.join(" · ") }
        : {};
}
const isCodexHookPayload = (value) => isRecord(value) &&
    typeof value.session_id === "string" &&
    typeof value.transcript_path === "string" &&
    typeof value.turn_id === "string";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    let input = "";
    process.stdin.on("data", (chunk) => {
        input += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    process.stdin.on("end", () => {
        let out = {};
        try {
            const parsed = JSON.parse(input);
            if (isRecord(parsed) && parsed.hook_event_name === "PermissionRequest") {
                const clip = CLIPS.soundNeedsInput;
                if (clip !== null)
                    afplay(clip); // no decision: Codex prompts
            }
            else if (isCodexHookPayload(parsed)) {
                const dataDir = [process.env.PLUGIN_DATA, process.env.CLAUDE_PLUGIN_DATA].find((value) => value !== undefined && value.length > 0) ?? join(tmpdir(), "giocaizzi-sounds");
                out = stop(parsed, { dataDir });
            }
        }
        catch {
            // fail open: a missing rollout or bad payload plays nothing
        }
        process.stdout.write(JSON.stringify(out));
    });
}
