// `node hooks/guard.mjs --contract`: the run contract this guard speaks, so a launcher can refuse to start on an
// older one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, CONTRACT } from "../core/registration.mjs";
// guard's version from its own .claude-plugin/plugin.json, "unknown" when it cannot be read.
export function guardVersion(pluginRoot = fileURLToPath(new URL("..", import.meta.url))) {
    try {
        const manifest = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
        const version = manifest?.version;
        return typeof version === "string" &&
            /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
            ? version
            : "unknown";
    }
    catch {
        return "unknown";
    }
}
export function contractProbe(version = guardVersion()) {
    return {
        contract: CONTRACT,
        capabilities: [...CAPABILITIES],
        guard: version,
    };
}
