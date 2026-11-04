// `node hooks/guard.mjs --contract`: the run contract this guard speaks, so a launcher can refuse to start on an
// older one.
import { CAPABILITIES, CONTRACT } from "../core/registration.mjs";
// guard's version from its own .claude-plugin/plugin.json, "unknown" when it cannot be read.
export function guardVersion(pluginRoot) {
    throw new Error("not implemented");
}
export function contractProbe(version = guardVersion()) {
    return {
        contract: CONTRACT,
        capabilities: [...CAPABILITIES],
        guard: version,
    };
}
