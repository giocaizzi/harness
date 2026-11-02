#!/usr/bin/env node
/**
 * Validate repo invariants for the dual-harness plugin layout.
 *
 * Schema checks for the Claude plugin manifest, SKILL.md frontmatter and the
 * marketplace manifest are delegated to the native `claude plugin validate`
 * command. This file only enforces things the native validator cannot see:
 * the Copilot-side manifest, marketplace <-> disk cross-refs, README sync,
 * generated-agent sync, and a couple of repo-specific rules.
 *
 * Checks:
 *   1. Native `claude plugin validate` passes for every plugin and the marketplace.
 *   2. The Copilot manifest (.github/plugin/plugin.json) matches the Claude
 *      manifest's version and sets `agents: ["./.generated/copilot/"]`.
 *   3. The Claude plugin.json does not declare `skills` or `agents` fields
 *      (repo policy: both must be auto-discovered), and no plugin has a `bin/` (claude.ai and Cowork skip it).
 *   4. marketplace.json lists every plugins/<dir> with matching versions and source paths.
 *   5. The root README links to every plugin, and each plugin's README lists all its skills and agents.
 *   6. Generated files are in sync with agents/*.md, their .yaml overrides, the manifests and the cross-plugin copies (delegates to build_agents.mjs --check).
 *   7. Every file a plugin's hooks/hooks.json names (command scripts, mod modules) exists.
 *   8. VS Code reads each plugin as Claude format: no `.plugin/plugin.json` or root
 *      `plugin.json` (they win VS Code's format detection), skill `name` is kebab-case
 *      and equals its directory (VS Code skips others silently), frontmatter is strict YAML
 *      (Copilot CLI and VS Code reject it otherwise), hook events are ones
 *      VS Code maps, and hook commands use no `${CLAUDE_PLUGIN_DATA}` token (VS Code
 *      expands only `${CLAUDE_PLUGIN_ROOT}`).
 *   9. pi reads the repo-root package.json: its `pi` key loads every plugin's skills and the guard extension.
 *  10. Parity: every skill and agent reaches Claude Code, Copilot CLI, Codex, opencode, pi and Antigravity through
 *      the repo's own packaging, each agent at one tier (delegates to scripts/parity.mjs).
 *  11. Skills are self-contained: no skill file (.md or script) points at this repo's docs/ (a `../docs`
 *      path, or a relative `docs/<path>` that is a file here), since an installed skill ships without them.
 *  12. TypeScript compilation succeeds and every emitted runtime file matches its tracked output.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, } from "node:fs";
import os from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_ROOT = join(REPO_ROOT, "plugins");
const MARKETPLACE = join(REPO_ROOT, ".claude-plugin", "marketplace.json");
const README = join(REPO_ROOT, "README.md");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");
class Reporter {
    errors = [];
    fail(msg) {
        this.errors.push(msg);
    }
    section(title) {
        console.log(`\n> ${title}`);
    }
    ok(msg) {
        console.log(`  OK ${msg}`);
    }
}
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function repr(val) {
    if (val === undefined || val === null) {
        return "None";
    }
    if (typeof val === "string") {
        return `'${val}'`;
    }
    if (typeof val === "number" || typeof val === "boolean") {
        return String(val);
    }
    if (Array.isArray(val)) {
        return `[${val.map((item) => repr(item)).join(", ")}]`;
    }
    return JSON.stringify(val);
}
function relPosix(from, to) {
    return relative(from, to).replaceAll("\\", "/");
}
function loadJson(filePath) {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);
    if (!isRecord(parsed)) {
        throw new Error(`${filePath}: expected a JSON object`);
    }
    return parsed;
}
function which(cmd) {
    const pathEnv = process.env.PATH ?? "";
    const pathExt = process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
        : [""];
    const sep = process.platform === "win32" ? ";" : ":";
    for (const dir of pathEnv.split(sep)) {
        if (!dir)
            continue;
        for (const ext of pathExt) {
            const full = join(dir, cmd + ext);
            try {
                if (existsSync(full) && statSync(full).isFile()) {
                    return full;
                }
            }
            catch {
                // ignore
            }
        }
    }
    return null;
}
function discoverPlugins() {
    if (!existsSync(PLUGINS_ROOT)) {
        return [];
    }
    return readdirSync(PLUGINS_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => join(PLUGINS_ROOT, entry.name))
        .sort();
}
function findFilesRecursive(dir, predicate) {
    if (!existsSync(dir)) {
        return [];
    }
    const results = [];
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findFilesRecursive(fullPath, predicate));
        }
        else if (entry.isFile() && predicate(fullPath)) {
            results.push(fullPath);
        }
    }
    return results;
}
function runClaudeValidate(target) {
    const result = spawnSync("claude", ["plugin", "validate", target], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
    });
    if (result.error) {
        return [false, result.error.message];
    }
    const stdout = result.stdout;
    const stderr = result.stderr;
    return [result.status === 0, (stdout + stderr).trim()];
}
function check_native_validator(r) {
    r.section("Native `claude plugin validate`");
    if (!which("claude")) {
        r.fail("claude CLI not found on PATH - install Claude Code to run native plugin validation");
        return;
    }
    for (const pluginDir of discoverPlugins()) {
        const [ok, output] = runClaudeValidate(pluginDir);
        const label = relPosix(REPO_ROOT, pluginDir);
        if (!ok) {
            r.fail(`${label}: native validator failed\n${output}`);
        }
        else {
            r.ok(label);
        }
    }
    const [ok, output] = runClaudeValidate(MARKETPLACE);
    const label = relPosix(REPO_ROOT, MARKETPLACE);
    if (!ok) {
        r.fail(`${label}: native validator failed\n${output}`);
    }
    else {
        r.ok(label);
    }
}
function check_repo_specific_manifests(r) {
    r.section("Repo-specific manifest rules (Copilot + auto-discovery)");
    for (const pluginDir of discoverPlugins()) {
        const pluginName = basename(pluginDir);
        const binDir = join(pluginDir, "bin");
        if (existsSync(binDir)) {
            r.fail(`${relPosix(REPO_ROOT, pluginDir)}/bin exists: claude.ai and Cowork do not install a plugin with a bin/; name scripts by \${CLAUDE_PLUGIN_ROOT} in the skill`);
        }
        const manifest = join(pluginDir, ".claude-plugin", "plugin.json");
        const rel = relPosix(REPO_ROOT, manifest);
        if (!existsSync(manifest)) {
            continue;
        }
        let data;
        try {
            data = loadJson(manifest);
        }
        catch {
            continue;
        }
        if ("skills" in data) {
            r.fail(`${rel}: contains \`skills\` field - Claude Code rejects this; remove it (auto-discovery works for both harnesses)`);
        }
        if ("agents" in data) {
            r.fail(`${rel}: contains \`agents\` field - Claude Code reads this manifest; it must auto-discover the agents/ dir. The \`agents\` override belongs in .github/plugin/plugin.json (Copilot).`);
        }
        const copilotManifest = join(pluginDir, ".github", "plugin", "plugin.json");
        const crel = relPosix(REPO_ROOT, copilotManifest);
        if (!existsSync(copilotManifest)) {
            r.fail(`${crel}: missing - Copilot CLI needs this manifest (run \`make build\`)`);
            continue;
        }
        let cdata;
        try {
            cdata = loadJson(copilotManifest);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            r.fail(`${crel}: invalid JSON: ${msg}`);
            continue;
        }
        if (cdata.version !== data.version) {
            r.fail(`${crel}: version drift vs .claude-plugin/plugin.json (${repr(cdata.version)} vs ${repr(data.version)}) - run \`make build\``);
        }
        const cAgents = cdata.agents;
        const hasCopilotAgents = Array.isArray(cAgents) &&
            cAgents.length === 1 &&
            cAgents[0] === "./.generated/copilot/";
        if (!hasCopilotAgents) {
            r.fail(`${crel}: must contain \`"agents": ["./.generated/copilot/"]\` so Copilot CLI scans .generated/copilot/ (got ${repr(cdata.agents)})`);
        }
        const antigravityManifest = join(pluginDir, ".antigravity-plugin", "plugin.json");
        const arel = relPosix(REPO_ROOT, antigravityManifest);
        if (!existsSync(antigravityManifest)) {
            r.fail(`${arel}: missing - Antigravity needs this manifest (run \`make build\`)`);
            continue;
        }
        let adata;
        try {
            adata = loadJson(antigravityManifest);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            r.fail(`${arel}: invalid JSON: ${msg}`);
            continue;
        }
        if (adata.version !== data.version) {
            r.fail(`${arel}: version drift vs .claude-plugin/plugin.json (${repr(adata.version)} vs ${repr(data.version)}) - run \`make build\``);
        }
        r.ok(`${pluginName} (Claude + Copilot + Antigravity manifests)`);
    }
}
function check_marketplace(r) {
    r.section("Marketplace <-> plugins sync");
    if (!existsSync(MARKETPLACE)) {
        r.fail(`${relPosix(REPO_ROOT, MARKETPLACE)}: missing`);
        return;
    }
    let market;
    try {
        market = loadJson(MARKETPLACE);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        r.fail(`${relPosix(REPO_ROOT, MARKETPLACE)}: invalid JSON: ${msg}`);
        return;
    }
    const rawPlugins = Array.isArray(market.plugins) ? market.plugins : [];
    const listed = new Map();
    for (const p of rawPlugins) {
        if (isRecord(p) && typeof p.name === "string") {
            listed.set(p.name, p);
        }
    }
    const onDiskPlugins = discoverPlugins().map((p) => basename(p));
    const onDisk = new Set(onDiskPlugins);
    for (const name of onDisk) {
        if (!listed.has(name)) {
            r.fail(`plugin ${repr(name)} exists on disk but is not in marketplace.json`);
        }
    }
    for (const name of listed.keys()) {
        if (!onDisk.has(name)) {
            r.fail(`marketplace.json lists ${repr(name)} but plugins/${name}/ does not exist`);
        }
    }
    for (const name of onDisk) {
        const entry = listed.get(name);
        if (!entry)
            continue;
        const manifestPath = join(PLUGINS_ROOT, name, ".claude-plugin", "plugin.json");
        if (!existsSync(manifestPath)) {
            continue;
        }
        const manifest = loadJson(manifestPath);
        if (entry.version !== manifest.version) {
            r.fail(`version drift for ${repr(name)}: marketplace.json=${repr(entry.version)} vs plugin.json=${repr(manifest.version)}`);
        }
        const expectedSource = `./plugins/${name}`;
        const actualSource = entry.source;
        if (actualSource !== expectedSource && actualSource !== `plugins/${name}`) {
            r.fail(`${repr(name)}: marketplace source ${repr(actualSource)} should be ${repr(expectedSource)}`);
        }
        r.ok(`${name} @ ${String(manifest.version)}`);
    }
}
function check_repo_version_sync(r) {
    r.section("Repo version sync");
    if (!existsSync(PACKAGE_JSON)) {
        r.fail(`${relPosix(REPO_ROOT, PACKAGE_JSON)}: missing`);
        return;
    }
    let pkg;
    try {
        pkg = loadJson(PACKAGE_JSON);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        r.fail(`${relPosix(REPO_ROOT, PACKAGE_JSON)}: invalid JSON: ${msg}`);
        return;
    }
    let market;
    try {
        market = loadJson(MARKETPLACE);
    }
    catch {
        return;
    }
    const pkgVersion = pkg.version;
    const metadata = isRecord(market.metadata) ? market.metadata : {};
    const marketplaceVersion = metadata.version;
    if (pkgVersion !== marketplaceVersion) {
        r.fail("repo version drift: " +
            `package.json=${repr(pkgVersion)} vs ` +
            `.claude-plugin/marketplace.json metadata.version=${repr(marketplaceVersion)}`);
        return;
    }
    r.ok(`package.json matches marketplace metadata (${String(pkgVersion)})`);
}
function check_readme(r) {
    r.section("Root README <-> plugins sync");
    if (!existsSync(README)) {
        r.fail("README.md: missing");
        return;
    }
    const text = readFileSync(README, "utf-8");
    for (const pluginDir of discoverPlugins()) {
        const name = basename(pluginDir);
        if (!text.includes(`\`${name}\``)) {
            r.fail(`README.md missing plugin entry for \`${name}\``);
            continue;
        }
        if (!text.includes(`plugins/${name}/README.md`)) {
            r.fail(`README.md must link to plugins/${name}/README.md`);
            continue;
        }
        r.ok(`root -> ${name}`);
    }
    r.section("Per-plugin README <-> skills/agents sync");
    for (const pluginDir of discoverPlugins()) {
        const pluginName = basename(pluginDir);
        const readme = join(pluginDir, "README.md");
        const rel = relPosix(REPO_ROOT, readme);
        if (!existsSync(readme)) {
            r.fail(`${rel}: missing - every plugin must ship a README.md`);
            continue;
        }
        const ptext = readFileSync(readme, "utf-8");
        const skillsDir = join(pluginDir, "skills");
        if (existsSync(skillsDir)) {
            const skills = readdirSync(skillsDir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort();
            for (const skill of skills) {
                if (!ptext.includes(`\`${skill}\``)) {
                    r.fail(`${rel}: missing row for skill \`${skill}\``);
                }
                else {
                    r.ok(`${pluginName}/README.md -> skill ${skill}`);
                }
            }
        }
        const agentsDir = join(pluginDir, "agents");
        if (existsSync(agentsDir)) {
            const agentFiles = readdirSync(agentsDir, { withFileTypes: true })
                .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
                .map((entry) => entry.name)
                .sort();
            for (const agentFile of agentFiles) {
                const agent = agentFile.slice(0, -3);
                if (!ptext.includes(`\`${agent}\``)) {
                    r.fail(`${rel}: missing row for agent \`${agent}\``);
                }
                else {
                    r.ok(`${pluginName}/README.md -> agent ${agent}`);
                }
            }
        }
    }
}
function check_hooks(r) {
    r.section("Plugin hooks <-> files");
    for (const pluginDir of discoverPlugins()) {
        const hooksJson = join(pluginDir, "hooks", "hooks.json");
        if (!existsSync(hooksJson)) {
            continue;
        }
        const rel = relPosix(REPO_ROOT, hooksJson);
        let data;
        try {
            data = loadJson(hooksJson);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            r.fail(`${rel}: invalid JSON: ${msg}`);
            continue;
        }
        const paths = [];
        if (Array.isArray(data.modules)) {
            for (const m of data.modules) {
                if (typeof m === "string") {
                    paths.push(join(dirname(hooksJson), m));
                }
            }
        }
        const hooksObj = isRecord(data.hooks) ? data.hooks : {};
        for (const groups of Object.values(hooksObj)) {
            if (Array.isArray(groups)) {
                for (const group of groups) {
                    if (isRecord(group) && Array.isArray(group.hooks)) {
                        for (const hook of group.hooks) {
                            if (isRecord(hook) && typeof hook.command === "string") {
                                const matches = hook.command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+)/g);
                                for (const match of matches) {
                                    if (match[1]) {
                                        paths.push(join(pluginDir, match[1]));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        const missing = paths
            .filter((p) => !existsSync(p))
            .map((p) => relPosix(REPO_ROOT, p));
        if (missing.length > 0) {
            r.fail(`${rel}: references missing files: ${missing.join(", ")}`);
        }
        else {
            r.ok(`${basename(pluginDir)}: ${String(paths.length)} hook file(s)`);
        }
    }
}
const VSCODE_HOOK_EVENTS = new Set([
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "sessionStart",
    "sessionEnd",
    "userPromptSubmitted",
    "preToolUse",
    "postToolUse",
    "agentStop",
    "subagentStop",
    "errorOccurred",
    "ErrorOccurred",
]);
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function check_vscode(r) {
    r.section("VS Code agent-plugin compatibility");
    for (const pluginDir of discoverPlugins()) {
        const errors = [];
        for (const shadow of [".plugin/plugin.json", "plugin.json"]) {
            if (existsSync(join(pluginDir, shadow))) {
                errors.push(`${shadow} exists: VS Code would read it instead of .claude-plugin/plugin.json`);
            }
        }
        const skillsDir = join(pluginDir, "skills");
        if (existsSync(skillsDir)) {
            const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort();
            for (const skillDir of skillDirs) {
                const skillMd = join(skillsDir, skillDir, "SKILL.md");
                if (!existsSync(skillMd))
                    continue;
                const text = readFileSync(skillMd, "utf-8");
                const parts = text.split("---", 3);
                const front = parts[1];
                if (front !== undefined) {
                    try {
                        YAML.parse(front);
                    }
                    catch (exc) {
                        const firstLine = exc instanceof Error
                            ? (exc.message.split(/\r?\n/)[0] ?? "")
                            : String(exc);
                        errors.push(`skills/${skillDir}: frontmatter is not valid YAML (${firstLine}); quote the value`);
                    }
                }
                const nameMatch = /^name:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(text);
                const name = nameMatch?.[1];
                if (name !== skillDir || !KEBAB.test(name)) {
                    errors.push(`skills/${skillDir}: name ${repr(name)} must be kebab-case and equal the directory`);
                }
            }
        }
        const hooksJson = join(pluginDir, "hooks", "hooks.json");
        if (existsSync(hooksJson)) {
            let hooks = {};
            try {
                const data = loadJson(hooksJson);
                if (isRecord(data.hooks)) {
                    hooks = data.hooks;
                }
            }
            catch {
                // check_hooks reports it
            }
            for (const e of Object.keys(hooks)) {
                if (!VSCODE_HOOK_EVENTS.has(e)) {
                    errors.push(`hooks.json: event ${repr(e)} is not one VS Code maps`);
                }
            }
            const rawHooksText = readFileSync(hooksJson, "utf-8");
            if (rawHooksText.includes("${CLAUDE_PLUGIN_DATA}")) {
                errors.push("hooks.json: ${CLAUDE_PLUGIN_DATA} is not expanded by VS Code; read the env var in the script with a fallback");
            }
        }
        for (const e of errors) {
            r.fail(`${relPosix(REPO_ROOT, pluginDir)}: ${e}`);
        }
        if (errors.length === 0) {
            r.ok(basename(pluginDir));
        }
    }
}
function check_build_sync(r) {
    r.section("Generated files <-> agents/*.md, manifests and cross-plugin copies");
    const buildScript = join(REPO_ROOT, "scripts", "build_agents.mjs");
    const result = spawnSync(process.execPath, [buildScript, "--check"], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
    });
    if (result.status !== 0) {
        const combined = result.stdout + result.stderr;
        for (const line of combined.split(/\r?\n/)) {
            if (line.trim().length > 0) {
                r.fail(line);
            }
        }
    }
    else {
        r.ok("all agents in sync");
    }
}
function check_workspace_mcp(r) {
    r.section("Workspace MCP source -> Codex, pi, and Antigravity");
    const result = spawnSync("chezmoi-agents", ["mcp", "sync", "-check"], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
    });
    if (result.error) {
        if (result.error.code === "ENOENT") {
            r.ok("chezmoi-agents not found, skipped");
            return;
        }
        r.fail(`chezmoi-agents invocation failed: ${result.error.message}`);
        return;
    }
    if (result.status !== 0) {
        const combined = result.stdout + result.stderr;
        for (const line of combined.split(/\r?\n/)) {
            if (line.trim().length > 0) {
                r.fail(line);
            }
        }
    }
    else {
        r.ok("workspace source converts without private environment values or local files");
    }
}
function check_pi_package(r) {
    r.section("pi package (root package.json)");
    const path = join(REPO_ROOT, "package.json");
    if (!existsSync(path)) {
        r.fail("package.json: missing (pi installs the repo from it)");
        return;
    }
    let pkg;
    try {
        pkg = loadJson(path);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        r.fail(`package.json: invalid JSON: ${msg}`);
        return;
    }
    const pi = isRecord(pkg.pi) ? pkg.pi : {};
    const skills = pi.skills;
    const hasPiSkills = Array.isArray(skills) &&
        skills.length === 1 &&
        skills[0] === "./plugins/*/skills";
    if (!hasPiSkills) {
        r.fail('package.json: pi.skills must be ["./plugins/*/skills"] so every plugin\'s skills load');
    }
    const extensions = Array.isArray(pi.extensions) ? pi.extensions : [];
    for (const ext of extensions) {
        if (typeof ext === "string" && !existsSync(join(REPO_ROOT, ext))) {
            r.fail(`package.json: pi extension ${ext} does not exist`);
        }
    }
    if (!extensions.includes("./plugins/guard/hooks/pi.mjs")) {
        r.fail("package.json: pi.extensions must load ./plugins/guard/hooks/pi.mjs");
    }
    else {
        r.ok("pi package loads all skills and the guard extension");
    }
}
const DOCS_POINTER = /(?<![\w/:.-])((?:\.\.\/)*)docs\/([\w./-]*)/g;
const SKILL_TEXT = new Set([".md", ".mjs", ".sh", ".ps1", ".py"]);
function check_skills_self_contained(r) {
    r.section("Skills are self-contained (no pointer to this repo's docs/)");
    let found = 0;
    const paths = [];
    for (const pluginDir of discoverPlugins()) {
        const skillsDir = join(pluginDir, "skills");
        if (existsSync(skillsDir)) {
            paths.push(...findFilesRecursive(skillsDir, (p) => SKILL_TEXT.has(extname(p))));
        }
    }
    paths.sort();
    for (const filePath of paths) {
        const lines = readFileSync(filePath, "utf-8").split(/\r?\n/);
        for (let n = 1; n <= lines.length; n++) {
            const line = lines[n - 1] ?? "";
            for (const m of line.matchAll(DOCS_POINTER)) {
                const prefix = m[1] ?? "";
                const rawName = m[2] ?? "";
                const name = rawName.replace(/[./]+$/, "");
                const docPath = join(REPO_ROOT, "docs", name);
                let isFile = false;
                try {
                    isFile =
                        name.length > 0 &&
                            existsSync(docPath) &&
                            statSync(docPath).isFile();
                }
                catch {
                    isFile = false;
                }
                if (prefix.length > 0 || isFile) {
                    found++;
                    const rel = relPosix(REPO_ROOT, filePath);
                    r.fail(`${rel}:${String(n)}: points at docs/${name}; move what the skill needs into its references/, or link https://github.com/giocaizzi/harness/blob/main/docs/{name}`);
                }
            }
        }
    }
    if (found === 0) {
        r.ok("no skill file points at docs/");
    }
}
function check_parity(r) {
    r.section("Parity: every skill and agent reaches every harness");
    const parityScript = join(REPO_ROOT, "scripts", "parity.mjs");
    const result = spawnSync(process.execPath, [parityScript], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
    });
    if (result.status !== 0) {
        const combined = result.stdout + result.stderr;
        for (const line of combined.split(/\r?\n/)) {
            if (line.trim().length > 0) {
                r.fail(line);
            }
        }
    }
    else {
        r.ok(result.stdout.trim());
    }
}
function check_typescript_sync(r) {
    r.section("TypeScript sources <-> emitted runtime files");
    const compiler = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
    if (!existsSync(compiler) || !statSync(compiler).isFile()) {
        r.fail("TypeScript compiler or Node.js missing - run `npm ci` before validation");
        return;
    }
    const temporary = mkdtempSync(join(os.tmpdir(), "harness-typescript-"));
    try {
        const result = spawnSync(process.execPath, [compiler, "--project", "tsconfig.build.json", "--outDir", temporary], {
            cwd: REPO_ROOT,
            encoding: "utf-8",
        });
        if (result.status !== 0) {
            r.fail(`TypeScript compilation failed:\n${result.stdout}${result.stderr}`);
            return;
        }
        const emitted = findFilesRecursive(temporary, (p) => p.endsWith(".mjs")).sort();
        for (const filePath of emitted) {
            const rel = relPosix(temporary, filePath);
            const runtime = join(REPO_ROOT, rel);
            if (!existsSync(runtime) || !statSync(runtime).isFile()) {
                r.fail(`${rel}: missing TypeScript output - run \`make build\``);
            }
            else {
                const emittedBuf = readFileSync(filePath);
                const runtimeBuf = readFileSync(runtime);
                if (!emittedBuf.equals(runtimeBuf)) {
                    r.fail(`${rel}: stale TypeScript output - run \`make build\``);
                }
                else {
                    r.ok(rel);
                }
            }
        }
        if (emitted.length === 0) {
            r.fail("TypeScript compilation emitted no runtime files");
        }
    }
    finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}
function main() {
    const r = new Reporter();
    check_typescript_sync(r);
    check_native_validator(r);
    check_repo_specific_manifests(r);
    check_marketplace(r);
    check_repo_version_sync(r);
    check_build_sync(r);
    check_workspace_mcp(r);
    check_hooks(r);
    check_vscode(r);
    check_pi_package(r);
    check_parity(r);
    check_skills_self_contained(r);
    check_readme(r);
    console.log();
    if (r.errors.length > 0) {
        console.error(`ERROR ${String(r.errors.length)} error(s):`);
        for (const e of r.errors) {
            console.error(`  - ${e}`);
        }
        process.exit(1);
    }
    console.log("OK All checks passed.");
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main();
}
