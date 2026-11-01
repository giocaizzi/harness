import { ICON } from "./weather.mjs";
export const EVENTS = [
    "session.created",
    "session.updated",
    "session.deleted",
    "message.updated",
    "session.status",
];
export function createChildren() {
    const kids = new Map();
    return {
        on(e) {
            const type = e?.type;
            const p = e?.properties ?? {};
            const info = p.info ?? {};
            const targetId = type === "message.updated"
                ? (info.sessionID ?? "")
                : (info.id ?? p.sessionID ?? "");
            const kid = kids.get(targetId);
            if ((type === "session.created" || type === "session.updated") &&
                info.parentID &&
                info.id) {
                kids.set(info.id, {
                    busy: true,
                    ...kid,
                    parent: info.parentID,
                    agent: info.agent ?? kid?.agent,
                });
                return true;
            }
            if (!kid)
                return false;
            if (type === "session.deleted") {
                return info.id ? kids.delete(info.id) : false;
            }
            if (type === "message.updated" && info.role === "assistant") {
                Object.assign(kid, {
                    model: info.modelID ?? kid.model,
                    variant: info.variant ?? kid.variant,
                });
            }
            else if (type === "session.status") {
                kid.busy = p.status?.type !== "idle";
            }
            else {
                return false;
            }
            return true;
        },
        parts(session) {
            return [...kids.values()]
                .filter((k) => k.parent === session && k.busy)
                .map((k) => `[${ICON.agents ?? ""} ${[k.agent, k.model, k.variant].filter((x) => Boolean(x)).join(" · ")}]`)
                .join(" ");
        },
    };
}
