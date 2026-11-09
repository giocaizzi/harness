// Attributes every guard record carries: which harness, which guard version, which repo. Never the command text:
// a command is reported as a short hash of its normalised form, enough to count repeats without its content.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emit, otelEnabled, repoSlug, traceContext } from "../core/otel.mjs";
import { canonicalHarnessName, detectHarnessName } from "./harnesses.mjs";
import { isRecord } from "./types.mjs";
export { repoSlug };
// `--harness=<name>` (the Codex hooks file passes `--harness=codex`) wins; else the data dir variable each harness
// sets: Claude Code sets CLAUDE_PLUGIN_DATA, Copilot CLI COPILOT_PLUGIN_DATA, VS Code only CLAUDE_PLUGIN_ROOT.
export function harnessName(argv = process.argv, env = process.env) {
    return detectHarnessName(argv, env);
}
let version;
// The installed guard's version, from its own plugin.json; read once per process.
export function guardVersion() {
    if (version !== undefined)
        return version;
    try {
        const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json"), "utf8");
        const parsed = JSON.parse(raw);
        version =
            isRecord(parsed) && typeof parsed.version === "string"
                ? parsed.version
                : null;
    }
    catch {
        version = null;
    }
    return version;
}
const repos = new Map();
// `owner/name` of the repo at `cwd`, from its origin remote (else its first remote): the last two path segments of the
// URL, `.git` dropped, never the host, user or a token in it. Null outside git, without a remote, or for a URL that
// does not end in owner/name. One lookup per directory and process.
export function repoName(cwd, run = execFileSync) {
    const key = cwd ?? ".";
    if (!repos.has(key)) {
        const git = (...args) => String(run("git", args, {
            cwd: key,
            encoding: "utf8",
            timeout: 2000,
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
        })).trim();
        let name = null;
        try {
            let url = "";
            try {
                url = git("remote", "get-url", "origin");
            }
            catch {
                const first = git("remote").split(/\r?\n/)[0] ?? "";
                url = first ? git("remote", "get-url", first) : "";
            }
            name = repoSlug(url);
        }
        catch {
            // not a repo, or git missing
        }
        repos.set(key, name);
    }
    return repos.get(key) ?? null;
}
const legacyHarnessName = (harness) => {
    const normalized = harness?.trim().toLowerCase();
    switch (normalized) {
        case "claude":
        case "copilot":
        case "vscode":
        case "codex":
            return normalized;
        default:
            return null;
    }
};
const harnessAttrs = (harness) => {
    const legacy = legacyHarnessName(harness);
    return {
        harness: canonicalHarnessName(harness),
        ...(legacy ? { harness_legacy: legacy } : {}),
    };
};
const enrichedAttrs = (attrs, cwd, harness) => ({
    ...attrs,
    ...harnessAttrs(harness),
    guard_version: guardVersion(),
    repo: repoName(cwd),
});
// Every record carries the canonical harness identity, the guard version and the repo (`owner/name` of the hook
// input's `cwd`), read only when something will be sent. Changed internal aliases are retained temporarily.
export const recordAttrs = (attrs, cwd, harness, env = process.env) => otelEnabled(env) ? enrichedAttrs(attrs, cwd, harness) : attrs;
const presentString = (value) => {
    const normalized = value?.trim();
    if (!normalized)
        return undefined;
    return normalized;
};
const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const nonNegativeFiniteNumber = (value) => {
    const finite = finiteNumber(value);
    return finite !== undefined && finite >= 0 ? finite : undefined;
};
const defaultUsageEnrichment = { guardVersion, repoName };
/** Build the shared attributes for a synthetic `api_request` usage log. */
export function usageAttributes({ cacheCreationTokens, cacheReadTokens, costSource, costUsd, cwd, env = process.env, harness, inputTokens, model, outputTokens, provider, reasoningTokens, sessionId, }, enrichment = defaultUsageEnrichment) {
    const session = presentString(sessionId);
    const modelName = presentString(model);
    const providerName = presentString(provider);
    const input = nonNegativeFiniteNumber(inputTokens);
    const output = nonNegativeFiniteNumber(outputTokens);
    const cacheRead = nonNegativeFiniteNumber(cacheReadTokens);
    const cacheCreation = nonNegativeFiniteNumber(cacheCreationTokens);
    const reasoning = nonNegativeFiniteNumber(reasoningTokens);
    const cost = nonNegativeFiniteNumber(costUsd);
    const common = {
        usage_schema: "guard.usage.v1",
        ...(session ? { "session.id": session } : {}),
        ...(modelName ? { model: modelName } : {}),
        ...(providerName ? { provider: providerName } : {}),
        ...(input !== undefined ? { input_tokens: input } : {}),
        ...(output !== undefined ? { output_tokens: output } : {}),
        ...(cacheRead !== undefined ? { cache_read_tokens: cacheRead } : {}),
        ...(cacheCreation !== undefined
            ? { cache_creation_tokens: cacheCreation }
            : {}),
        ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}),
        ...(cost !== undefined ? { cost_usd: cost } : {}),
        ...(cost !== undefined && costSource ? { cost_source: costSource } : {}),
        ...harnessAttrs(harness ?? undefined),
    };
    if (!otelEnabled(env))
        return common;
    const observedCwd = presentString(cwd);
    return {
        ...common,
        guard_version: enrichment.guardVersion(),
        ...(observedCwd ? { repo: enrichment.repoName(observedCwd) } : {}),
    };
}
// A line of tool output made safe to send: long token-like runs and `key=value` / `key: value` pairs whose key names
// a secret are masked, then it is cut to 200 characters.
export const scrub = (line) => (line ?? "")
    .replace(/((?:token|secret|password|passwd|pass|key|auth|bearer|credential)[\w-]*\s*[=:]\s*)\S+/gi, "$1***")
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_\-+/=]{24,}\b/g, "***")
    .slice(0, 200);
// The make target that failed (`make: *** [test] Error 1`; the innermost recipe, which make reports first), or null.
export function failedTarget(output) {
    const all = [
        ...(output ?? "").matchAll(/make(?:\[\d+\])?: \*\*\* \[(?:[^\]]*:\s*)?([^\]\s]+)\] Error/g),
    ];
    return all.length ? (all[0]?.[1] ?? null) : null;
}
// 12 hex chars of the sha256 of the command with runs of whitespace collapsed.
export const commandHash = (command) => createHash("sha256")
    .update((command ?? "").trim().replace(/\s+/g, " "))
    .digest("hex")
    .slice(0, 12);
// One JSON line per decision to $GUARD_RUN_EVENTS_FILE, when a run's runner sets it: the runner's guard deny-rate
// breaker reads it. Only the hash of the command, never its text; a failed write is dropped and the decision stands.
// A well-formed GUARD_TRACEPARENT adds `trace_id` and `span_id`, the same ids as the OTLP record's.
export function appendDecision(env, { decision, rule, cmd_hash }, now = new Date(), append = appendFileSync) {
    const file = env?.GUARD_RUN_EVENTS_FILE;
    if (!file?.trim())
        return;
    try {
        const trace = traceContext(env);
        const item = {
            ts: now.toISOString(),
            decision,
            rule,
            cmd_hash,
            ...(trace ? { trace_id: trace.traceId, span_id: trace.spanId } : {}),
        };
        append(file, `${JSON.stringify(item)}\n`);
    }
    catch {
        // unwritable path: telemetry never blocks a decision
    }
}
/** Resolve an explicit Antigravity transcript or an existing transcript in its recovered artifact layout. */
export function resolveAntigravityTranscriptPath({ conversationId, homeDir = homedir(), transcriptPath, transcript_path: legacyTranscriptPath, }, fileExists = existsSync) {
    const explicit = presentString(transcriptPath) ?? presentString(legacyTranscriptPath);
    if (explicit)
        return explicit;
    const id = presentString(conversationId);
    if (!id ||
        id === "." ||
        id === ".." ||
        id.includes("/") ||
        id.includes("\\") ||
        id.includes("\0")) {
        return undefined;
    }
    const logs = join(homeDir, ".gemini", "antigravity-cli", "brain", id, ".system_generated", "logs");
    const transcript = join(logs, "transcript.jsonl");
    if (fileExists(transcript))
        return transcript;
    const fullTranscript = join(logs, "transcript_full.jsonl");
    return fileExists(fullTranscript) ? fullTranscript : undefined;
}
/**
 * Scan Antigravity's transcript.jsonl for new PLANNER_RESPONSE turns and emit api_request to OTel.
 * Returns the highest step_index seen, or lastStep if unchanged or unreadable.
 */
export async function emitAntigravityUsage(transcriptPath, conversationId, modelName, lastStep, cwd, env = process.env, emitFn) {
    if (!transcriptPath || !conversationId)
        return lastStep;
    let content = "";
    try {
        content = readFileSync(transcriptPath, "utf8");
    }
    catch {
        return lastStep;
    }
    if (!content)
        return lastStep;
    const emitRecord = emitFn ?? ((event, attrs) => emit(env, event, attrs, fetch, "antigravity"));
    let maxStep = lastStep ?? -1;
    const lines = content.split("\n");
    const promises = [];
    for (const line of lines) {
        if (!line.trim())
            continue;
        try {
            const step = JSON.parse(line);
            if (isRecord(step)) {
                const idx = typeof step.step_index === "number" ? step.step_index : undefined;
                if (typeof idx === "number" && idx > (lastStep ?? -1)) {
                    if (idx > maxStep)
                        maxStep = idx;
                    if (step.type === "PLANNER_RESPONSE") {
                        const inTok = nonNegativeFiniteNumber(typeof step.input_tokens === "number"
                            ? step.input_tokens
                            : undefined);
                        const outTok = nonNegativeFiniteNumber(typeof step.output_tokens === "number"
                            ? step.output_tokens
                            : undefined);
                        const cacheReadTok = nonNegativeFiniteNumber(typeof step.cache_read_tokens === "number"
                            ? step.cache_read_tokens
                            : undefined);
                        const model = presentString(modelName);
                        promises.push(emitRecord("api_request", usageAttributes({
                            harness: "antigravity",
                            cwd,
                            sessionId: conversationId,
                            model,
                            provider: "google",
                            inputTokens: inTok,
                            outputTokens: outTok,
                            cacheReadTokens: cacheReadTok,
                            env,
                        })).catch(() => undefined));
                    }
                }
            }
        }
        catch {
            // skip unparseable lines
        }
    }
    if (promises.length > 0) {
        await Promise.all(promises);
    }
    return maxStep;
}
