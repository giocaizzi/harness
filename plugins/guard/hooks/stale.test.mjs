import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handle, pythonManager } from "./guard.mjs";
import { installedVersions, newer, staleCheck } from "./stale.mjs";
const plugin = (dir, version) => {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x", version }));
    return dir;
};
// Claude Code: <config>/plugins/cache/<marketplace>/<plugin>/<version>, installed_plugins.json in <config>/plugins.
function claude(installed, dirs) {
    const plugins = join(mkdtempSync(join(tmpdir(), "stale-")), "plugins");
    for (const [p, vs] of Object.entries(dirs)) {
        for (const v of vs) {
            plugin(join(plugins, "cache", "acme", p, v), v);
        }
    }
    const registry = Object.fromEntries(Object.entries(installed).map(([p, v]) => [
        `${p}@acme`,
        [{ scope: "user", version: v }],
    ]));
    writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: registry }));
    return (p, v) => join(plugins, "cache", "acme", p, v);
}
void test("newer compares versions numerically", () => {
    assert.equal(newer("0.10.0", "0.9.9"), true);
    assert.equal(newer("1.0.0", "1.0.0"), false);
    assert.equal(newer("0.52.0", "0.53.0"), false);
});
void test("Claude Code: the registry gives the installed versions, the cache path what this session loaded", () => {
    const root = claude({ guard: "0.53.0", hud: "0.9.0" }, { guard: ["0.52.0", "0.53.0"], hud: ["0.9.0"] })("guard", "0.52.0");
    assert.deepEqual(installedVersions(root), {
        self: { name: "guard", version: "0.52.0", versioned: true },
        installed: { guard: "0.53.0", hud: "0.9.0" },
    });
    const r = staleCheck({ root, loaded: { hud: "0.8.0" }, harness: "claude" });
    assert.equal(r.notice, "Harness plugins updated (guard 0.52.0 → 0.53.0, hud 0.8.0 → 0.9.0): run `/reload-plugins` to load them.");
    assert.equal(r.context, `${r.notice} Only the user can do this: mention it to them once.`);
    assert.deepEqual(r.remind, ["guard@0.53.0", "hud@0.9.0"]);
    // Once per newer version.
    assert.equal(staleCheck({
        root,
        loaded: r.loaded,
        reminded: r.remind,
        harness: "claude",
    }).context, null);
});
void test("a cache dir newer than the registry is not installed", () => {
    const root = claude({ guard: "0.52.0" }, { guard: ["0.52.0", "0.53.0"] })("guard", "0.52.0");
    assert.equal(staleCheck({ root }).context, null);
});
void test("Codex: no registry, the newest version dir is installed", () => {
    const plugins = join(mkdtempSync(join(tmpdir(), "stale-")), "cache", "acme");
    plugin(join(plugins, "guard", "0.52.0"), "0.52.0");
    plugin(join(plugins, "guard", "0.53.0"), "0.53.0");
    assert.match(staleCheck({ root: join(plugins, "guard", "0.52.0"), harness: "codex" })
        .context ?? "", /guard 0\.52\.0 → 0\.53\.0\): restart the session to load them/);
});
void test("updated in place (Copilot CLI, a checkout): the versions the session started with are the loaded ones", () => {
    const plugins = mkdtempSync(join(tmpdir(), "stale-"));
    const root = plugin(join(plugins, "guard"), "0.52.0");
    plugin(join(plugins, "hud"), "0.9.0");
    mkdirSync(join(plugins, "not-a-plugin"));
    const first = staleCheck({ root });
    assert.deepEqual(first.loaded, { guard: "0.52.0", hud: "0.9.0" });
    assert.equal(first.context, null);
    plugin(root, "0.53.0");
    assert.match(staleCheck({ root, loaded: first.loaded, harness: "copilot" }).context ??
        "", /^Harness plugins updated \(guard 0\.52\.0 → 0\.53\.0\)/);
});
void test("an unreadable layout reads as nothing newer", () => {
    assert.deepEqual(staleCheck({ root: join(tmpdir(), "no-such-dir", "guard") }), {
        loaded: {},
        remind: [],
        notice: null,
        context: null,
    });
    const plugins = join(mkdtempSync(join(tmpdir(), "stale-")), "plugins");
    plugin(join(plugins, "cache", "acme", "guard", "0.52.0"), "0.52.0");
    writeFileSync(join(plugins, "installed_plugins.json"), "{not json");
    assert.equal(staleCheck({ root: join(plugins, "cache", "acme", "guard", "0.52.0") })
        .context, null);
});
void test("the hook says it once per session, next to a call without a decision", async () => {
    const pluginRoot = claude({ guard: "0.53.0" }, { guard: ["0.52.0", "0.53.0"] })("guard", "0.52.0");
    const dataDir = mkdtempSync(join(tmpdir(), "guard-test-"));
    const h = (input, agent_id) => handle({ session_id: "s1", cwd: "/", agent_id, ...input }, {
        dataDir,
        env: {},
        harness: "claude",
        pluginRoot,
        hostFacts: async () => {
            await Promise.resolve();
            return { load1: 1, freeGb: 100 };
        },
        run: async () => {
            await Promise.resolve();
            return null;
        },
        pythonManager,
    });
    const ctx = (out) => out.stdout
        ? (JSON.parse(out.stdout).hookSpecificOutput ?? {})
        : {};
    const denyRes = await h({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh pr create -t x -b y" },
    });
    assert.doesNotMatch(ctx(denyRes).permissionDecisionReason ?? "", /plugins updated/);
    const told = await h({
        hook_event_name: "PreToolUse",
        tool_name: "Skill",
        tool_input: { skill: "ship" },
    });
    assert.match(ctx(told).additionalContext ?? "", /guard 0\.52\.0 → 0\.53\.0/);
    assert.equal(JSON.parse(told.stdout ?? "{}").systemMessage, "Harness plugins updated (guard 0.52.0 → 0.53.0): run `/reload-plugins` to load them.", "the user sees it");
    const landRes = await h({
        hook_event_name: "PreToolUse",
        tool_name: "Skill",
        tool_input: { skill: "land" },
    });
    assert.equal(ctx(landRes).additionalContext, undefined);
    const subRes = await h({
        hook_event_name: "PreToolUse",
        tool_name: "Skill",
        tool_input: { skill: "wt" },
    }, "sub1");
    assert.equal(ctx(subRes).additionalContext, undefined, "a subagent of the session is not told again");
});
void test("Claude Code: the install of this session scope counts, not another project", () => {
    const plugins = join(mkdtempSync(join(tmpdir(), "stale-")), "plugins");
    for (const v of ["0.52.0", "0.53.0"]) {
        plugin(join(plugins, "cache", "acme", "guard", v), v);
    }
    const registry = {
        "guard@acme": [
            { scope: "user", version: "0.52.0" },
            { scope: "project", projectPath: "/work/other", version: "0.53.0" },
        ],
    };
    writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: registry }));
    const root = join(plugins, "cache", "acme", "guard", "0.52.0");
    assert.equal(staleCheck({ root, cwd: "/work/mine" }).context, null, "another project");
    assert.equal(staleCheck({ root }).context, null, "no cwd: the user install");
    assert.match(staleCheck({ root, cwd: "/work/other/sub" }).context ?? "", /guard 0\.52\.0 → 0\.53\.0/, "inside that project");
});
void test("a resumed or restarted session is a new process: it records what it loaded, and is not told to reload", async () => {
    const plugins = mkdtempSync(join(tmpdir(), "stale-"));
    const pluginRoot = plugin(join(plugins, "guard"), "1.0.0");
    const dataDir = mkdtempSync(join(tmpdir(), "guard-test-"));
    const h = (processId) => handle({
        session_id: "s1",
        cwd: "/",
        hook_event_name: "PreToolUse",
        tool_name: "Skill",
        tool_input: { skill: "ship" },
    }, {
        dataDir,
        env: {},
        harness: "copilot",
        pluginRoot,
        processId,
        hostFacts: async () => {
            await Promise.resolve();
            return { load1: 1, freeGb: 100 };
        },
        run: async () => {
            await Promise.resolve();
            return null;
        },
        pythonManager,
    });
    const getNote = (out) => out.stdout
        ? JSON.parse(out.stdout).hookSpecificOutput
            ?.additionalContext
        : undefined;
    assert.equal(getNote(await h(100)), undefined);
    plugin(pluginRoot, "1.1.0");
    assert.equal(getNote(await h(200)), undefined, "process 200 loaded 1.1.0");
    assert.match(getNote(await h(100)) ?? "", /guard 1\.0\.0 → 1\.1\.0/, "process 100 still runs 1.0.0");
});
void test("a stale step that throws leaves the decision standing", async () => {
    const pluginRoot = claude({ guard: "0.53.0" }, { guard: ["0.52.0", "0.53.0"] })("guard", "0.52.0");
    const harness = {
        toString: () => {
            throw new Error("boom");
        },
    };
    const out = await handle({
        session_id: "s1",
        cwd: "/",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh pr create -t x -b y" },
    }, {
        dataDir: mkdtempSync(join(tmpdir(), "guard-test-")),
        env: {},
        harness: harness,
        pluginRoot,
        hostFacts: async () => {
            await Promise.resolve();
            return { load1: 1, freeGb: 100 };
        },
        run: async () => {
            await Promise.resolve();
            return null;
        },
        pythonManager,
    });
    const parsed = JSON.parse(out.stdout ?? "{}");
    assert.equal(parsed.hookSpecificOutput?.permissionDecision, "deny");
});
void test("a hook parent that changes on every call stops the recording, so the session file stays small (#254)", async () => {
    const plugins = mkdtempSync(join(tmpdir(), "stale-"));
    const pluginRoot = plugin(join(plugins, "guard"), "1.0.0");
    for (const p of ["hud", "sounds", "dev-tools"]) {
        plugin(join(plugins, p), "1.0.0");
    }
    const dataDir = mkdtempSync(join(tmpdir(), "guard-test-"));
    for (let pid = 1; pid <= 50; pid++) {
        await handle({
            session_id: "s1",
            cwd: "/",
            hook_event_name: "PreToolUse",
            tool_name: "Skill",
            tool_input: { skill: "ship" },
        }, {
            dataDir,
            env: {},
            pluginRoot,
            processId: pid,
            hostFacts: async () => {
                await Promise.resolve();
                return { load1: 1, freeGb: 100 };
            },
            run: async () => {
                await Promise.resolve();
                return null;
            },
            pythonManager,
        });
    }
    const lines = readFileSync(join(dataDir, "sessions", "s1.jsonl"), "utf8")
        .trim()
        .split("\n");
    assert.equal(lines.filter((l) => l.includes('"plugin"')).length, 4 * 4, "four processes of four plugins, then nothing");
});
void test("the scope lookup compares real paths, ignoring case where the volume does, from the starting dir (#255)", async () => {
    const base = mkdtempSync(join(tmpdir(), "stale-"));
    const plugins = join(base, "plugins");
    for (const v of ["0.52.0", "0.53.0"]) {
        plugin(join(plugins, "cache", "acme", "guard", v), v);
    }
    const project = join(base, "Proj");
    mkdirSync(join(project, "sub"), { recursive: true });
    symlinkSync(project, join(base, "link"), "junction");
    const registry = (projectPath) => {
        writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({
            version: 2,
            plugins: {
                "guard@acme": [
                    { scope: "user", version: "0.52.0" },
                    { scope: "project", projectPath, version: "0.53.0" },
                ],
            },
        }));
    };
    const root = join(plugins, "cache", "acme", "guard", "0.52.0");
    registry(join(base, "link"));
    assert.match(staleCheck({ root, cwd: join(project, "sub") }).context ?? "", /0\.53\.0/, "a symlinked project path");
    const insensitive = existsSync(join(base, "proj"));
    registry(join(base, "PROJ"));
    assert.equal(Boolean(staleCheck({ root, cwd: join(project, "sub") }).context), insensitive, "case follows the volume");
    registry(project);
    const dataDir = mkdtempSync(join(tmpdir(), "guard-test-"));
    const h = (cwd) => handle({
        session_id: "s1",
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "Skill",
        tool_input: { skill: "ship" },
    }, {
        dataDir,
        env: {},
        pluginRoot: root,
        processId: 1,
        hostFacts: async () => {
            await Promise.resolve();
            return { load1: 1, freeGb: 100 };
        },
        run: async () => {
            await Promise.resolve();
            return null;
        },
        pythonManager,
    });
    const ctx = (out) => out.stdout
        ? JSON.parse(out.stdout).hookSpecificOutput
            ?.additionalContext
        : undefined;
    assert.equal(ctx(await h(base)), undefined);
    assert.equal(ctx(await h(join(project, "sub"))), undefined);
});
