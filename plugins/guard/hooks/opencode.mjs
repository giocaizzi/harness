// opencode plugin: the guard's rules on opencode's plugin hooks (https://opencode.ai/docs/plugins/).
// scripts/install.mjs writes a one-line stub into ~/.config/opencode/plugins/ that re-exports this file.
// A plugin cannot ask (opencode 1.19 declares `permission.ask` but never calls it), so the `config` hook adds
// `permission.bash` ask entries for the risky prefixes and opencode asks itself; any other risky form is denied.
import { nativeAsk, opencodeAsks } from "../core/engine.mjs";
import { rules } from "../core/rules.mjs";
import { createGuard } from "./bridge.mjs";
const ASKS = opencodeAsks(rules);
const ROOT_TIMEOUT_MS = 2000;
// A config key that rules on bash: `bash` or the `*` catch-all.
const bashKeys = (perm) => perm && typeof perm === "object"
    ? Object.entries(perm)
        .filter(([k]) => k === "bash" || k === "*")
        .map(([, v]) => v)
    : [perm];
const denies = (perm) => bashKeys(perm).some((v) => v === "deny" ||
    (v && typeof v === "object" && Object.values(v).includes("deny")));
// The permission config with the asks appended last to `bash` (opencode's last matching rule wins), so they
// override the user's allows. `bash` moves after `*` for the same reason.
export function withAsks(perm) {
    const p = typeof perm === "string"
        ? { "*": perm }
        : { ...perm };
    const rawBash = p.bash;
    const bash = typeof rawBash === "string"
        ? { "*": rawBash }
        : { ...rawBash };
    delete p.bash;
    const filteredBash = Object.fromEntries(Object.entries(bash).filter(([k]) => !(k in ASKS)));
    return { ...p, bash: { ...filteredBash, ...ASKS } };
}
export const GuardPlugin = ({ client, directory }, deps) => {
    let asks = false;
    const guard = createGuard({
        harness: "opencode",
        noAsk: true,
        deps: {
            nativeAsk: async (command, rule, input) => {
                const auto = (deps?.argv ?? process.argv).some((a) => a.startsWith("--auto") && a !== "--auto=false");
                if (!asks || auto || !nativeAsk(command, rule, rules))
                    return false;
                const hookInput = input;
                const targetId = hookInput?.agent_id ?? hookInput?.session_id;
                if (!targetId)
                    return false;
                const s = await client.session
                    .get({ path: { id: targetId } })
                    .catch(() => null);
                return (Boolean(s?.data) &&
                    !(s?.data?.permission ?? []).some((r) => r.permission === "bash" || r.permission === "*"));
            },
            ...deps,
        },
    });
    const notes = new Map();
    const roots = new Map();
    const rootOf = (id) => {
        const existing = roots.get(id);
        if (existing)
            return existing;
        const walk = (async () => {
            let cur = id;
            for (let depth = 0; depth < 5; depth++) {
                const res = await client.session
                    .get({ path: { id: cur } })
                    .catch(() => null);
                const parent = res?.data?.parentID;
                if (!parent)
                    break;
                cur = parent;
            }
            return cur;
        })().catch(() => id);
        const late = Symbol("late");
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => {
                resolve(late);
            }, deps?.rootTimeoutMs ?? ROOT_TIMEOUT_MS);
        });
        const promise = Promise.race([walk, timeout])
            .then((root) => {
            if (root !== late)
                return root;
            roots.delete(id);
            return id;
        })
            .finally(() => {
            if (timer)
                clearTimeout(timer);
        });
        roots.set(id, promise);
        return promise;
    };
    const who = async (id) => {
        const root = await rootOf(id);
        return root && root !== id
            ? { sessionId: root, agentId: id }
            : { sessionId: id };
    };
    const blocked = new Set();
    const reported = new Set();
    const text = (t) => (typeof t === "string" ? t : "");
    return Promise.resolve({
        config: (cfg) => {
            const agents = Object.values(cfg.agent ?? {}).filter((a) => Boolean(a.permission));
            if (denies(cfg.permission) || agents.some((a) => denies(a.permission))) {
                return Promise.resolve();
            }
            cfg.permission = withAsks(cfg.permission ?? {});
            for (const a of agents) {
                a.permission = withAsks(a.permission);
            }
            asks = true;
            return Promise.resolve();
        },
        "tool.execute.before": async (input, output) => {
            const identity = await who(input.sessionID);
            const d = await guard.preTool({
                ...identity,
                cwd: directory,
                tool: input.tool.toLowerCase(),
                input: output.args ?? {},
            });
            if (d.decision === "deny" || d.decision === "ask") {
                throw new Error(d.reason);
            }
            if (d.context)
                notes.set(input.callID, d.context);
            if (d.notice) {
                Promise.resolve()
                    .then(() => client.tui.showToast({
                    body: { message: d.notice, variant: "info" },
                }))
                    .catch(() => {
                    // toast failed
                });
            }
        },
        "tool.execute.after": (input, output) => {
            const noteCtx = notes.get(input.callID);
            const postCtx = guard.postTool({
                cwd: directory,
                tool: input.tool.toLowerCase(),
                input: input.args ?? {},
            });
            const extra = [noteCtx, postCtx].filter((x) => Boolean(x));
            notes.delete(input.callID);
            if (extra.length) {
                output.output = [text(output.output), ...extra]
                    .filter(Boolean)
                    .join("\n\n");
            }
            return Promise.resolve();
        },
        "chat.message": async (input, output) => {
            const prompt = (output.parts ?? [])
                .filter((p) => p.type === "text" && typeof p.text === "string")
                .map((p) => p.text ?? "")
                .join("\n");
            if (prompt) {
                const identity = await who(input.sessionID);
                await guard.prompt({ ...identity, cwd: directory, prompt });
            }
        },
        event: async ({ event }) => {
            const sessionId = event.properties?.sessionID ?? event.properties?.info?.id;
            const info = event.properties?.info;
            if (event.type === "message.updated" &&
                info?.role === "assistant" &&
                info.time?.completed &&
                info.tokens &&
                !reported.has(info.id)) {
                reported.add(info.id);
                const t = info.tokens;
                await guard.usage({
                    sessionId: info.sessionID,
                    model: info.modelID ?? info.model?.id,
                    provider: info.providerID ?? info.model?.providerID,
                    tokens: {
                        input: t.input,
                        output: t.output,
                        cacheRead: t.cache?.read,
                        cacheWrite: t.cache?.write,
                        reasoning: t.reasoning,
                    },
                    costUsd: info.cost,
                });
            }
            if (event.type === "session.created") {
                guard.awake();
                if (!info?.parentID) {
                    await guard.sessionStart({
                        sessionId: info?.id ?? sessionId,
                        cwd: directory,
                        source: "startup",
                    });
                }
            }
            else if (event.type === "session.deleted") {
                await guard.sessionEnd({ sessionId });
            }
            else if (event.type === "session.idle" && sessionId) {
                const res = await Promise.resolve()
                    .then(() => client.session.get({ path: { id: sessionId } }))
                    .catch(() => null);
                if (res?.data?.parentID)
                    return;
                const reason = await guard.stop({
                    cwd: directory,
                    active: blocked.has(sessionId),
                });
                if (!reason) {
                    blocked.delete(sessionId);
                    return;
                }
                blocked.add(sessionId);
                await client.session
                    .prompt({
                    path: { id: sessionId },
                    body: { parts: [{ type: "text", text: reason }] },
                })
                    .catch(() => {
                    // prompt failed
                });
            }
        },
    });
};
