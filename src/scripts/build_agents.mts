#!/usr/bin/env node
// Generate the per-harness plugin artifacts.
//
// Agents are authored in place, as the Claude Code file, with an optional sidecar for the other harnesses:
//   plugins/<plugin>/agents/<name>.md      Claude Code agent: frontmatter + system prompt (authored)
//   plugins/<plugin>/agents/<name>.yaml    optional `copilot:`, `codex:`, `opencode:`, `antigravity:` override mappings (authored)
//
// Claude Code and VS Code read agents/*.md as-is. From each one the script writes:
//   plugins/<plugin>/.generated/copilot/<name>.agent.md   Copilot CLI agent: name, description + copilot overrides
//   plugins/<plugin>/.generated/codex/<name>.toml         Codex custom agent, installed by scripts/install.mjs
//   plugins/<plugin>/.generated/opencode/<name>.md        opencode subagent, installed by scripts/install.mjs
//   plugins/<plugin>/.generated/antigravity/<name>.md     Antigravity agent, installed by scripts/install.mjs
//
// The other harnesses get only `name`/`description` from the Claude file: its `tools`, `effort` and `model` are
// Claude values (a `model` names a Claude tier), so they inherit the session's unless their override sets one.
//
// For every plugin in plugins/<plugin>/ with .claude-plugin/plugin.json the script writes:
//   plugins/<plugin>/.github/plugin/plugin.json       Copilot manifest: the Claude one plus
//                                                     `agents: ["./.generated/copilot/"]`.
//   plugins/<plugin>/.codex-plugin/plugin.json        Codex manifest; with hooks, it points Codex at
//   plugins/<plugin>/.generated/codex/hooks.json      hooks.json without the Claude `modules` key (Codex rejects
//                                                     the file otherwise), the guard run with `--no-ask` (Codex
//                                                     has no ask), every script with `--harness=codex` (its
//                                                     telemetry label), SessionEnd at Codex's 3 s cap, plus the Codex-only hooks of
//                                                     hooks/codex-only.json.
//
// Files one plugin's hooks run from another (plugins install separately, so a hook cannot import across them):
//   plugins/guard/.generated/factory/check-result.mjs  factory's result checker, for guard's result gate on stop.
//
// Everything generated lives in a dot-folder, so every visible file under plugins/<plugin>/ is authored.
// Copilot files stay out of agents/: Claude loads any *.md there, including *.agent.md.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_ROOT = join(REPO_ROOT, "plugins");
const GENERATED = ".generated";
const HARNESS_KEYS = ["copilot", "codex", "opencode", "antigravity"] as const;
const HARNESS_KEY_SET = new Set<string>(HARNESS_KEYS);

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// --------------------------------------------------------------------------- agents

function loadYaml(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  const content = readFileSync(filePath, "utf-8");
  const data: unknown = YAML.parse(content);
  if (!data) {
    return {};
  }
  if (!isRecord(data)) {
    throw new Error(`${filePath}: expected a YAML mapping, got ${typeof data}`);
  }
  return data;
}

function parse(filePath: string): [Record<string, unknown>, string] {
  const content = readFileSync(filePath, "utf-8");
  const match = FRONTMATTER_RE.exec(content);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error(`${filePath}: expected YAML frontmatter between --- lines`);
  }
  const fm: unknown = YAML.parse(match[1]);
  if (!fm) {
    return [{}, match[2]];
  }
  if (!isRecord(fm)) {
    throw new Error(`${filePath}: frontmatter must be a YAML mapping`);
  }
  return [fm, match[2]];
}

function render(frontmatter: Record<string, unknown>, body: string): string {
  const fm = YAML.stringify(frontmatter, {
    indentSeq: false,
    lineWidth: 10000,
  }).trim();
  return `---\n${fm}\n---\n\n${body.trim()}\n`;
}

function renderToml(data: Record<string, unknown>): string {
  function tomlValue(v: unknown): string {
    if (typeof v === "boolean") {
      return v ? "true" : "false";
    }
    if (typeof v === "number") {
      return String(v);
    }
    if (typeof v === "string") {
      return JSON.stringify(v);
    }
    throw new Error(`unsupported TOML value: ${String(v)}`);
  }

  let out = "";
  for (const [k, v] of Object.entries(data)) {
    out += `${k} = ${tomlValue(v)}\n`;
  }
  return out;
}

function dumpJson(data: unknown): string {
  return (
    JSON.stringify(data, null, 2).replace(
      /[^\x00-\x7F]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ) + "\n"
  );
}

function sync(filePath: string, content: string, check: boolean): boolean {
  const rel = relative(REPO_ROOT, filePath);
  if (check) {
    if (!existsSync(filePath) || readFileSync(filePath, "utf-8") !== content) {
      console.error(`  OUT OF SYNC: ${rel}`);
      return false;
    }
    return true;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  console.log(`  written: ${rel}`);
  return true;
}

function buildAgent(agentPath: string, check: boolean): boolean {
  const name = basename(agentPath, ".md");
  const rel = relative(REPO_ROOT, agentPath);
  const [claude, body] = parse(agentPath);
  const yamlPath = agentPath.slice(0, -3) + ".yaml";
  const overrides = loadYaml(yamlPath);

  if (claude.name !== name) {
    const claudeNameRepr =
      typeof claude.name === "string"
        ? `'${claude.name}'`
        : String(claude.name);
    console.error(
      `ERROR: ${rel}: \`name\` (${claudeNameRepr}) must match the file name`,
    );
    return false;
  }
  if (!("description" in claude) || typeof claude.description !== "string") {
    console.error(`ERROR: ${rel}: missing required \`description\``);
    return false;
  }
  const unknownKeys = Object.keys(overrides).filter(
    (k) => !HARNESS_KEY_SET.has(k),
  );
  if (unknownKeys.length > 0) {
    unknownKeys.sort();
    const sortedRepr = `[${unknownKeys.map((k) => `'${k}'`).join(", ")}]`;
    console.error(
      `ERROR: ${relative(REPO_ROOT, yamlPath)}: unknown keys ${sortedRepr}; expected ${HARNESS_KEYS.join(", ")}`,
    );
    return false;
  }

  const copilotOverrides = isRecord(overrides.copilot) ? overrides.copilot : {};
  const codexOverrides = isRecord(overrides.codex) ? overrides.codex : {};
  const opencodeOverrides = isRecord(overrides.opencode)
    ? overrides.opencode
    : {};
  const antigravityOverrides = isRecord(overrides.antigravity)
    ? overrides.antigravity
    : {};

  const base: Record<string, unknown> = {
    name,
    description: claude.description,
  };
  const copilotFm = { ...base, ...copilotOverrides };
  const codex: Record<string, unknown> = {
    ...base,
    ...codexOverrides,
    developer_instructions: `${body.trim()}\n`,
  };
  const opencodeFm = {
    description: claude.description,
    mode: "subagent",
    ...opencodeOverrides,
  };
  const antigravityFm = { ...base, ...antigravityOverrides };

  const out = join(dirname(dirname(agentPath)), GENERATED);
  const targets: [string, string][] = [
    [join(out, "copilot", `${name}.agent.md`), render(copilotFm, body)],
    [join(out, "codex", `${name}.toml`), renderToml(codex)],
    [join(out, "opencode", `${name}.md`), render(opencodeFm, body)],
    [join(out, "antigravity", `${name}.md`), render(antigravityFm, body)],
  ];

  let ok = true;
  for (const [targetPath, content] of targets) {
    if (!sync(targetPath, content, check)) {
      ok = false;
    }
  }
  return ok;
}

// --------------------------------------------------------------------------- manifests

interface HookItem {
  timeout?: number;
  command?: string;
  [key: string]: unknown;
}

interface HookGroup {
  hooks?: HookItem[];
  [key: string]: unknown;
}

interface HooksFileContent {
  hooks?: Record<string, HookGroup[]>;
  modules?: unknown;
  [key: string]: unknown;
}

function buildCodex(pluginDir: string, check: boolean): boolean {
  const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
  let data = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
    string,
    unknown
  >;
  const hooksFile = join(pluginDir, "hooks", "hooks.json");
  let ok = true;

  if (existsSync(hooksFile)) {
    const hooks = JSON.parse(
      readFileSync(hooksFile, "utf-8"),
    ) as HooksFileContent;
    const codexHooks: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(hooks)) {
      if (k !== "modules") {
        codexHooks[k] = structuredClone(v);
      }
    }
    if (!isRecord(codexHooks.hooks)) {
      codexHooks.hooks = {};
    }
    const hooksMap = codexHooks.hooks as Record<string, HookGroup[]>;
    for (const [event, groups] of Object.entries(hooksMap)) {
      if (Array.isArray(groups)) {
        for (const group of groups) {
          if (Array.isArray(group.hooks)) {
            for (const hook of group.hooks) {
              // Codex clamps a SessionEnd hook to 3 s (and warns on every run); ask for what it gives.
              if (event === "SessionEnd" && (hook.timeout ?? 0) > 3) {
                hook.timeout = 3;
              }
              if (typeof hook.command === "string") {
                if (hook.command.includes("/hooks/guard.mjs")) {
                  hook.command += " --no-ask";
                }
                // The scripts cannot tell Codex from Claude Code by environment (both set CLAUDE_PLUGIN_*).
                if (hook.command.startsWith("node ")) {
                  hook.command += " --harness=codex";
                }
              }
            }
          }
        }
      }
    }
    const codexOnly = join(pluginDir, "hooks", "codex-only.json");
    if (existsSync(codexOnly)) {
      const codexOnlyData = JSON.parse(readFileSync(codexOnly, "utf-8")) as {
        hooks?: Record<string, HookGroup[]>;
      };
      if (codexOnlyData.hooks) {
        for (const [event, groups] of Object.entries(codexOnlyData.hooks)) {
          (hooksMap[event] ??= []).push(...groups);
        }
      }
    }
    ok =
      sync(
        join(pluginDir, GENERATED, "codex", "hooks.json"),
        dumpJson(codexHooks),
        check,
      ) && ok;
    data = { ...data, hooks: `./${GENERATED}/codex/hooks.json` };
  }

  return (
    sync(
      join(pluginDir, ".codex-plugin", "plugin.json"),
      dumpJson(data),
      check,
    ) && ok
  );
}

function buildCopilotManifest(pluginDir: string, check: boolean): boolean {
  const claudeManifest = join(pluginDir, ".claude-plugin", "plugin.json");
  const copilotManifest = join(pluginDir, ".github", "plugin", "plugin.json");
  if (!existsSync(claudeManifest)) {
    console.error(
      `ERROR: ${relative(REPO_ROOT, claudeManifest)}: missing (cannot derive Copilot manifest)`,
    );
    return false;
  }

  const data = JSON.parse(readFileSync(claudeManifest, "utf-8")) as Record<
    string,
    unknown
  >;
  const copilotData = { ...data, agents: [`./${GENERATED}/copilot/`] };
  return sync(copilotManifest, dumpJson(copilotData), check);
}

function buildAntigravityManifest(pluginDir: string, check: boolean): boolean {
  const claudeManifest = join(pluginDir, ".claude-plugin", "plugin.json");
  const antigravityManifest = join(
    pluginDir,
    ".antigravity-plugin",
    "plugin.json",
  );
  if (!existsSync(claudeManifest)) {
    console.error(
      `ERROR: ${relative(REPO_ROOT, claudeManifest)}: missing (cannot derive Antigravity manifest)`,
    );
    return false;
  }

  const data = JSON.parse(readFileSync(claudeManifest, "utf-8")) as Record<
    string,
    unknown
  >;
  const antigravityData = {
    $schema: "https://antigravity.google/schemas/v1/plugin.json",
    ...data,
  };
  return sync(antigravityManifest, dumpJson(antigravityData), check);
}

// --------------------------------------------------------------------------- cross-plugin copies

// (source, copy), relative to plugins/.
const COPIES = [
  [
    "factory/skills/ticket-run/scripts/check-result.mjs",
    "guard/.generated/factory/check-result.mjs",
  ],
] as const;

function buildCopies(check: boolean): boolean {
  let ok = true;
  for (const [source, copy] of COPIES) {
    const header = `// GENERATED by scripts/build_agents.mjs from plugins/${source}; never edit.\n`;
    const content = header + readFileSync(join(PLUGINS_ROOT, source), "utf-8");
    ok = sync(join(PLUGINS_ROOT, copy), content, check) && ok;
  }
  return ok;
}

// --------------------------------------------------------------------------- main

export function main(): void {
  const check = process.argv.includes("--check");

  const pluginEntries = readdirSync(PLUGINS_ROOT, { withFileTypes: true });
  const plugins = pluginEntries
    .filter(
      (d) =>
        d.isDirectory() &&
        !d.name.startsWith(".") &&
        existsSync(join(PLUGINS_ROOT, d.name, ".claude-plugin", "plugin.json")),
    )
    .map((d) => join(PLUGINS_ROOT, d.name))
    .sort();

  const agents: string[] = [];
  for (const plugin of plugins) {
    const agentsDir = join(plugin, "agents");
    if (existsSync(agentsDir)) {
      const agentFiles = readdirSync(agentsDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".md"))
        .map((d) => join(agentsDir, d.name));
      agents.push(...agentFiles);
    }
  }
  agents.sort();

  const verb = check ? "Checking" : "Building";
  const agentNames =
    agents.map((p) => basename(p, ".md")).join(", ") || "(none)";
  console.log(`${verb} ${String(agents.length)} agent(s): ${agentNames}`);
  let okAgents = true;
  for (const p of agents) {
    if (!buildAgent(p, check)) {
      okAgents = false;
    }
  }

  const pluginNames = plugins.map((p) => basename(p)).join(", ") || "(none)";
  console.log(
    `${verb} ${String(plugins.length)} Copilot manifest(s): ${pluginNames}`,
  );
  let okManifests = true;
  for (const p of plugins) {
    if (!buildCopilotManifest(p, check)) {
      okManifests = false;
    }
  }

  console.log(`${verb} ${String(plugins.length)} Codex manifest(s)`);
  for (const p of plugins) {
    if (!buildCodex(p, check)) {
      okManifests = false;
    }
  }

  console.log(`${verb} ${String(plugins.length)} Antigravity manifest(s)`);
  for (const p of plugins) {
    if (!buildAntigravityManifest(p, check)) {
      okManifests = false;
    }
  }

  console.log(`${verb} ${String(COPIES.length)} cross-plugin copy(ies)`);
  if (!buildCopies(check)) {
    okManifests = false;
  }

  if (!(okAgents && okManifests)) {
    if (check) {
      console.error("\nRun `make build` to regenerate.");
    }
    process.exit(1);
  }

  if (check) {
    console.log("All generated files are up to date.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
