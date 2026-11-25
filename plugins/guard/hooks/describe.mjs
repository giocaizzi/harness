// `node hooks/guard.mjs --describe`: one JSON line naming how every harness runs this copy of guard, built from the
// installed hooks files at run time so an orchestrator never embeds a copy of them.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT } from "../core/registration.mjs";
import { guardVersion } from "./contract.mjs";
// The descriptor's own schema version: additions are minor, a changed meaning bumps it.
export const DESCRIPTOR = 1;
// The run variables a launcher sets for a registered run.
export const RUN_ENV = [
    "AGENT_RUN_ID",
    "AGENT_RUN_TICKET",
    "AGENT_RUN_MODE",
    "AGENT_RUN_FILE",
    "AGENT_RUN_MANIFEST",
    "AGENT_RUN_MANIFEST_SHA256",
    "AGENT_RUN_EVENTS_FILE",
    "AGENT_RUN_PROTECTED_PATHS",
];
const PLUGIN_ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";
// The Antigravity hooks `scripts/install.mjs` writes under "giocaizzi-guard", for a guard installed at `root`.
export function antigravityHooks(root) {
    const guardScript = join(root, "hooks", "guard.mjs");
    const stopScript = join(root, "hooks", "stop.mjs");
    return {
        PreToolUse: [
            {
                matcher: "run_command|read_file|view_file|edit_file|write_file|invoke_subagent",
                hooks: [
                    {
                        type: "command",
                        command: `node ${JSON.stringify(guardScript)} PreToolUse --harness=antigravity`,
                    },
                ],
            },
        ],
        Stop: [
            {
                type: "command",
                command: `node ${JSON.stringify(stopScript)} Stop --harness=antigravity`,
            },
        ],
    };
}
// `node "<path>" plain args...` to an argv, `${CLAUDE_PLUGIN_ROOT}` replaced by the absolute root. Throws on any
// other form: a hooks file this reader cannot parse must fail loudly, never ship a wrong argv.
export function commandToArgv(command, root) {
    const m = /^node "((?:[^"\\]|\\.)*)"((?: [\w.=:@/-]+)*)$/.exec(command);
    if (m === null)
        throw new Error(`unparseable hook command: ${command}`);
    const quoted = JSON.parse(`"${m[1] ?? ""}"`);
    const script = quoted.startsWith(PLUGIN_ROOT_VAR)
        ? join(root, quoted.slice(PLUGIN_ROOT_VAR.length))
        : quoted;
    return ["node", script, ...(m[2] ?? "").split(" ").filter(Boolean)];
}
function entry(raw, matcher, root) {
    if (typeof raw.command !== "string") {
        throw new Error("hook without a command string");
    }
    const out = { argv: commandToArgv(raw.command, root) };
    if (typeof matcher === "string")
        out.matcher = matcher;
    if (typeof raw.timeout === "number")
        out.timeout = raw.timeout;
    return out;
}
// Flatten a Claude-format `hooks` object ({Event: [{matcher?, hooks: [{type, command, timeout?}]}]}), or the flat
// Antigravity Stop form ({Event: [{type, command}]}), to one entry per command.
export function flattenHooks(hooks, root) {
    const out = {};
    for (const [event, groups] of Object.entries((hooks ?? {}))) {
        if (!Array.isArray(groups))
            throw new Error(`hooks.${event} is not a list`);
        out[event] = groups.flatMap((g) => Array.isArray(g.hooks)
            ? g.hooks.map((h) => entry(h, g.matcher, root))
            : [entry(g, undefined, root)]);
    }
    return out;
}
// `read` returns a file under the plugin root, given relative to it, as text.
export function buildDescriptor(root, read, version) {
    const hooksOf = (file) => JSON.parse(read(file)).hooks;
    const claude = flattenHooks(hooksOf(join("hooks", "hooks.json")), root);
    return {
        descriptor: DESCRIPTOR,
        guard: version,
        contract: CONTRACT,
        root,
        harnesses: {
            "claude-code": { kind: "command", hooks: claude },
            "copilot-cli": { kind: "command", hooks: claude },
            "vscode-copilot": { kind: "command", hooks: claude },
            "codex-cli": {
                kind: "command",
                hooks: flattenHooks(hooksOf(join(".generated", "codex", "hooks.json")), root),
            },
            antigravity: {
                kind: "command",
                hooks: flattenHooks(antigravityHooks(root), root),
            },
            opencode: { kind: "module", module: join(root, "hooks", "opencode.mjs") },
            pi: { kind: "module", module: join(root, "hooks", "pi.mjs") },
        },
        env: { run: [...RUN_ENV] },
    };
}
// The descriptor of the installed copy this module belongs to.
export function describeInstalled(pluginRoot = fileURLToPath(new URL("..", import.meta.url))) {
    const root = resolve(pluginRoot);
    return buildDescriptor(root, (relative) => readFileSync(join(root, relative), "utf8"), guardVersion(root));
}
