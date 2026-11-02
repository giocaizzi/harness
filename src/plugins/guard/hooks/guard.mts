// Command hook for Claude Code, Copilot CLI, Antigravity, and VS Code Copilot: one hooks.json, one script, every OS.
// Both harnesses send Claude's payload (snake_case, `hook_event_name`); Copilot maps the PascalCase events
// and reads `hookSpecificOutput.permissionDecision`. A hook is a fresh process, so per-session facts
// (loaded skills, rules already reminded) live in a JSON file under $CLAUDE_PLUGIN_DATA.

import { execFile } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { statfs } from "node:fs/promises";
import { cpus, homedir, loadavg, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  analysis,
  branchFacts,
  cdDirs,
  cmdClass,
  codexRules,
  deniedBy,
  deniedDir,
  evaluateCommand,
  evaluateEdit,
  evaluateRouting,
  hostJudged,
  isHeavy,
  isRisky,
  nativeAsk,
  previewCommand,
  pureRead,
  refFacts,
  regenFacts,
  stackFacts,
  stackTargets,
  tagFacts,
  tagTargets,
  unattendedSet,
  withPreview,
  worktreeFacts,
} from "../core/engine.mjs";
import { cpuPercentFrom } from "../core/host.mjs";
import { emit } from "../core/otel.mjs";
import { rules } from "../core/rules.mjs";
import { commandWords, units } from "../core/shell.mjs";
import type {
  GuardEnv,
  HostFacts,
  SafeFact,
  StackFact,
  TagFact,
} from "../core/types.mjs";
import { pluginDataDir } from "./data.mjs";
import {
  isEditTool,
  isReadTool,
  isShellTool,
  isTaskTool,
} from "./harnesses.mjs";
import { installedVersions, staleCheck } from "./stale.mjs";
import {
  appendDecision,
  commandHash,
  emitAntigravityUsage,
  harnessName,
  recordAttrs,
} from "./telemetry.mjs";
import type {
  HandleDeps,
  HookInput,
  HookOutputPayload,
  PermissionDecision,
  PluginVersionMap,
} from "./types.mjs";

interface TaskEntry {
  args?: readonly (string | { value?: unknown })[];
  command?: string;
  id?: string;
  label?: string;
}

interface TasksJson {
  tasks?: readonly TaskEntry[];
}

const quoteArg = (a: string): string =>
  /^[\w./@%+=:,~-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;

const taskLine = (task?: TaskEntry | null): string | null => {
  if (!task || typeof task.command !== "string") return null;
  const argStrings = task.args
    ? task.args.map((a) => {
        if (typeof a === "string") return quoteArg(a);
        if (typeof a.value === "string") return quoteArg(a.value);
        return quoteArg("");
      })
    : [];
  return [task.command, ...argStrings].join(" ");
};

export interface TaskInput {
  id?: string;
  task?: TaskEntry;
  workspaceFolder?: string;
}

// The command a task tool runs, or null when it cannot be read.
export function taskCommand(
  tool: string,
  t: TaskInput = {},
  cwd = ".",
): string | null {
  if (tool === "create_and_run_task") return taskLine(t.task);
  try {
    const filePath = join(t.workspaceFolder ?? cwd, ".vscode", "tasks.json");
    const text = readFileSync(filePath, "utf8");
    const cleaned = text
      .replace(/^\s*\/\/.*$|\/\*[\s\S]*?\*\//gm, "")
      .replace(/,(\s*[}\]])/g, "$1");
    const json = JSON.parse(cleaned) as TasksJson;
    const id = t.id ?? "";
    const label = id.indexOf(": ") > 0 ? id.slice(id.indexOf(": ") + 2) : id;
    return taskLine(
      json.tasks?.find((x) => x.label === label || x.label === id),
    );
  } catch {
    return null;
  }
}

// Shell commands that only print a file.
const READERS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "bat",
  "sed",
  "get-content",
  "gc",
  "type",
]);

// Where installed or checked-out skills live: a plugin cache or install (Claude Code, Codex, Copilot CLI), user skill
// dirs (Claude Code, opencode, Antigravity, `.agents`), pi's packages, and a checkout's `plugins/<name>/skills`.
const SKILL_ROOT =
  /(?:[\\/]\.(?:claude|codex|copilot|pi|gemini)[\\/]|[\\/]\.config[\\/]opencode[\\/]|[\\/]\.agents[\\/]skills[\\/]|(?:^|[\\/])plugins[\\/](?:cache[\\/][\w.-]+[\\/])?[\w-]+[\\/](?:[\w.-]+[\\/])?skills[\\/])/;

const bareSkill = (s: string): string => s.split(":").pop() ?? s;

// The skills whose SKILL.md is among `paths`, under a skill root.
const skillsRead = (paths: readonly string[]): string[] =>
  paths.flatMap((p) => {
    if (!SKILL_ROOT.test(p)) return [];
    const match = /(?:^|[\\/])skills[\\/]([\w-]+)[\\/]SKILL\.md$/.exec(p);
    return match?.[1] ? [match[1]] : [];
  });

// The arguments of every reader in a shell command (`cat f`, `sed -n 1,200p f`; not `sed -i`), payloads included.
const readerArgs = (command: string): string[] =>
  units(analysis(command)).flatMap(({ cmd }) => {
    const [name, ...args] = commandWords(cmd.words).map((w) => w.val);
    const exe = (name ?? "").replace(/^.*[\\/]/, "").toLowerCase();
    const reader =
      READERS.has(exe) &&
      !args.some((a) => /^(?:-i|-[a-zA-Z]*i\b|--in-place)/.test(a));
    return reader ? args : [];
  });

const WEEK_MS = 7 * 24 * 3600 * 1000;

export function knownSkills(
  here: string = dirname(fileURLToPath(import.meta.url)),
): Set<string> {
  const names = new Set<string>();
  const ls = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const plugins = resolve(here, "..", "..");
  if (existsSync(join(plugins, "guard", "core"))) {
    for (const p of ls(plugins)) {
      for (const s of ls(join(plugins, p, "skills"))) {
        names.add(s);
      }
    }
    return names;
  }
  const cache = resolve(here, "..", "..", "..");
  for (const p of ls(cache)) {
    for (const v of ls(join(cache, p))) {
      for (const s of ls(join(cache, p, v, "skills"))) {
        names.add(s);
      }
    }
  }
  return names;
}

const SESSION_HINTS = new Set(["read", "edit"]);
const MAX_PROCESSES = 4;

export interface StoredSessionState {
  announced?: boolean;
  lastTranscriptStep?: number;
  loaded: string[];
  plugins: PluginVersionMap;
  reminded: string[];
  startCwd?: string;
  unattended?: boolean;
}

export interface SessionStoreInstance {
  load(): StoredSessionState;
  save(state: StoredSessionState): void;
  sweep(): void;
}

interface RawSessionFact {
  agent?: string;
  announced?: boolean;
  cwd?: string;
  lastTranscriptStep?: number;
  loaded?: string;
  plugin?: string;
  process?: number | string;
  reminded?: string;
  unattended?: boolean;
  version?: string;
}

export function sessionStore(
  dir: string = pluginDataDir(),
  sessionId?: string,
  agentId?: string,
  processId?: number | string | null,
): SessionStoreInstance {
  const file = sessionId
    ? join(dir, "sessions", `${sessionId.replace(/[^\w-]/g, "_")}.jsonl`)
    : null;
  const agent = agentId;
  let seen: {
    announced?: boolean;
    cwd?: string;
    lastTranscriptStep?: number;
    loaded: string[];
    plugins: PluginVersionMap;
    processes: Set<string>;
    reminded: string[];
    unattended?: boolean;
  } = { reminded: [], loaded: [], plugins: {}, processes: new Set() };

  return {
    load(): StoredSessionState {
      seen = {
        announced: undefined,
        cwd: undefined,
        lastTranscriptStep: undefined,
        loaded: [],
        plugins: {},
        processes: new Set(),
        reminded: [],
        unattended: undefined,
      };
      if (!file) {
        return { reminded: [], loaded: [], plugins: {} };
      }
      const proc = processId != null ? String(processId) : "";
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        // no facts yet
      }
      for (const line of text.split("\n")) {
        let fact: RawSessionFact;
        try {
          fact = JSON.parse(line) as RawSessionFact;
        } catch {
          continue;
        }
        if (typeof fact.loaded === "string") seen.loaded.push(fact.loaded);
        if (
          typeof fact.reminded === "string" &&
          (fact.agent === agent ||
            SESSION_HINTS.has(fact.reminded) ||
            fact.reminded.startsWith("stale:"))
        ) {
          seen.reminded.push(fact.reminded);
        }
        if (typeof fact.unattended === "boolean") {
          seen.unattended = fact.unattended;
        }
        if (typeof fact.lastTranscriptStep === "number") {
          seen.lastTranscriptStep = fact.lastTranscriptStep;
        }
        if (
          typeof fact.cwd === "string" &&
          (fact.process != null ? String(fact.process) : "") === proc
        ) {
          seen.cwd ??= fact.cwd;
        }
        if (
          fact.announced === true &&
          (fact.process != null ? String(fact.process) : "") === proc
        ) {
          seen.announced = true;
        }
        if (
          typeof fact.plugin === "string" &&
          typeof fact.version === "string"
        ) {
          seen.processes.add(fact.process != null ? String(fact.process) : "");
          if ((fact.process != null ? String(fact.process) : "") === proc) {
            seen.plugins[fact.plugin] ??= fact.version;
          }
        }
      }
      return {
        reminded: [...new Set(seen.reminded)],
        loaded: [...new Set(seen.loaded)],
        unattended: seen.unattended,
        plugins: { ...seen.plugins },
        startCwd: seen.cwd,
        announced: seen.announced,
        lastTranscriptStep: seen.lastTranscriptStep,
      };
    },

    save(state: StoredSessionState): void {
      if (!file) return;
      const lines: string[] = [
        ...(state.announced && !seen.announced
          ? [JSON.stringify({ announced: true, process: processId })]
          : []),
        ...[...new Set(state.loaded)]
          .filter((s) => !seen.loaded.includes(s))
          .map((s) => JSON.stringify({ loaded: s })),
        ...[...new Set(state.reminded)]
          .filter((r) => !seen.reminded.includes(r))
          .map((r) => JSON.stringify({ reminded: r, agent })),
        ...(typeof state.unattended === "boolean" &&
        state.unattended !== seen.unattended
          ? [JSON.stringify({ unattended: state.unattended })]
          : []),
        ...(typeof state.lastTranscriptStep === "number" &&
        state.lastTranscriptStep !== seen.lastTranscriptStep
          ? [JSON.stringify({ lastTranscriptStep: state.lastTranscriptStep })]
          : []),
        ...(seen.processes.has(processId != null ? String(processId) : "") ||
        seen.processes.size < MAX_PROCESSES
          ? [
              ...(typeof state.startCwd === "string" && !seen.cwd
                ? [JSON.stringify({ cwd: state.startCwd, process: processId })]
                : []),
              ...Object.entries(state.plugins)
                .filter(([p]) => !(p in seen.plugins))
                .map(([plugin, version]) =>
                  JSON.stringify({ plugin, version, process: processId }),
                ),
            ]
          : []),
      ];
      if (!lines.length) return;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, lines.join("\n") + "\n");
    },

    sweep(): void {
      const sessions = join(dir, "sessions");
      try {
        for (const f of readdirSync(sessions)) {
          const mtime = statSync(join(sessions, f)).mtimeMs;
          if (Date.now() - mtime > WEEK_MS) {
            rmSync(join(sessions, f), { force: true });
          }
        }
      } catch {
        // no sessions dir yet
      }
    },
  };
}

// Load average on Unix, cpu percent on Windows (sampled), free disk everywhere.
export async function hostFacts(cwd?: string): Promise<HostFacts> {
  try {
    const fs = await statfs(cwd ?? ".");
    const freeGb = Math.round((fs.bavail * fs.bsize) / 1073741824);
    if (platform() !== "win32") {
      const avg = loadavg()[0] ?? 0;
      return { load1: Math.round(avg * 100) / 100, freeGb };
    }
    const before = cpus();
    await new Promise((r) => setTimeout(r, 300));
    return { cpuPercent: cpuPercentFrom(before, cpus()), freeGb };
  } catch {
    return {};
  }
}

// The Python manager of the project around cwd, from the nearest directory (up to the repo root) with a marker.
export function pythonManager(cwd?: string): string | null {
  try {
    for (let dir = resolve(cwd ?? "."); ; dir = dirname(dir)) {
      const has = (f: string): boolean => existsSync(join(dir, f));
      const requirements = (): boolean =>
        existsSync(dir) &&
        readdirSync(dir).some((f) => /^requirements.*\.txt$/i.test(f));
      if (has("uv.lock")) return "uv";
      if (has("poetry.lock")) return "poetry";
      if (has("Pipfile.lock") || has("Pipfile")) return "pipenv";
      if (has("pyproject.toml")) {
        const toml = readFileSync(join(dir, "pyproject.toml"), "utf8");
        if (/^\[tool\.poetry\]/m.test(toml)) return "poetry";
        return !/^\[project\]/m.test(toml) && requirements() ? "pip" : "uv";
      }
      if (requirements()) return "pip";
      if (has(".git") || dirname(dir) === dir) return null;
    }
  } catch {
    return null;
  }
}

// Blast-radius previews and worktree git checks: argv only (no shell), short timeout, null on failure.
export const run = (
  argv: readonly string[],
  cwd?: string,
  ms = 5000,
): Promise<string | null> =>
  new Promise((res) => {
    const exe = argv[0];
    if (!exe) {
      res(null);
      return;
    }
    execFile(exe, argv.slice(1), { cwd, timeout: ms }, (err, stdout) => {
      res(err ? null : stdout);
    });
  });

const hostAttrs = (host: HostFacts): Record<string, unknown> => ({
  load1: host.load1,
  cpu_percent: host.cpuPercent,
  free_gb: host.freeGb,
});

export interface HandleResult {
  code?: number;
  stderr?: string;
  stdout?: string;
}

const preToolUse = (
  decision: PermissionDecision,
  reason?: string,
  harness?: string,
): HandleResult => {
  if (harness === "antigravity") {
    return {
      stdout: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
    };
  }
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  };
};

const note = (context: string, notice?: string): HandleResult => ({
  stdout: JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: context,
    },
    ...(notice ? { systemMessage: notice } : {}),
  }),
});

const fire = (
  deps: {
    emit?: (
      event: string,
      attrs: Record<string, unknown>,
      cwd?: string,
    ) => Promise<void> | void;
  },
  event: string,
  attrs: Record<string, unknown>,
  cwd?: string,
): void => {
  try {
    Promise.resolve(deps.emit?.(event, attrs, cwd)).catch(() => {
      /* ignore */
    });
  } catch {
    // a failed record changes nothing
  }
};

const within = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((res) => {
    const timer = setTimeout(() => {
      res(fallback);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        res(v);
      },
      () => {
        clearTimeout(timer);
        res(fallback);
      },
    );
  });

const FACTS_MS = 20_000;
const ALLOW_SAMPLE = 10;
const PREVIEW_MS = 3_000;
const STACK_MS = 5_000;
const ON = /^(1|true|on)$/i;
const PLAIN_DIR = /^[\w.@%+=:,\\/~-]+$/;

export function existingDirs(
  command: string,
  env: GuardEnv,
  cwd?: string,
): Set<string> {
  const dirs = new Set<string>();
  for (const d of cdDirs(command, env)) {
    if (!PLAIN_DIR.test(d)) continue;
    try {
      if (statSync(resolve(cwd ?? ".", d)).isDirectory()) {
        dirs.add(d);
      }
    } catch {
      // missing: the cd may fail
    }
  }
  return dirs;
}

export interface FactoryLabelsResult {
  approval: string;
  extra?: string[];
  takeover?: string;
  unsure?: boolean;
}

export function factoryLabels(cwd?: string): FactoryLabelsResult {
  const defaults: FactoryLabelsResult = {
    approval: rules.factory.approval,
    takeover: rules.factory.takeover,
  };
  for (let dir = resolve(cwd ?? "."); ; dir = dirname(dir)) {
    let text: string | undefined;
    try {
      text = readFileSync(join(dir, ".factory", "config.yaml"), "utf8").replace(
        /\r/g,
        "",
      );
    } catch (e: unknown) {
      const code =
        typeof e === "object" && e !== null && "code" in e
          ? (e as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return { ...defaults, unsure: true, extra: [] };
      }
    }
    if (text !== undefined) {
      if (!/^labels\b/m.test(text)) return defaults;
      const block = /^labels:[ \t]*\n((?:[ \t]+.*(?:\n|$)|[ \t]*\n)*)/m.exec(
        text,
      )?.[1];
      const named: Record<string, string | null> = {};
      const keys = ["approval", "takeover"] as const;
      for (const key of keys) {
        if (block === undefined) {
          named[key] = null;
        } else if (!new RegExp(`^[ \\t]+${key}[ \\t]*:`, "m").test(block)) {
          named[key] = defaults[key] ?? null;
        } else {
          const m = new RegExp(
            `^[ \\t]+${key}:[ \\t]*(?:"([^"]+)"|'([^']+)'|([^\\s#]+))`,
            "m",
          ).exec(block);
          named[key] = m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
        }
      }
      if (keys.every((key) => named[key] !== null)) {
        const app = named.approval;
        const take = named.takeover;
        if (typeof app === "string") {
          return {
            approval: app,
            ...(typeof take === "string" ? { takeover: take } : {}),
          };
        }
      }
      const extra = [
        ...text.matchAll(
          /\b(?:approval|takeover)[ \t]*:[ \t]*["']?([^\s"',}\]#]+)/g,
        ),
      ].map((m) => m[1] ?? "");
      return { ...defaults, unsure: true, extra };
    }
    if (dirname(dir) === dir) return defaults;
  }
}

export interface ProtectFactsResult {
  cwd: string;
  extra: string[];
  root: string;
}

export function protectFacts(
  env?: Record<string, string | undefined>,
  cwd?: string,
): ProtectFactsResult {
  const extra = (env?.FACTORY_PROTECTED_PATHS ?? "")
    .split(/\r?\n/)
    .map((g) => g.trim())
    .filter(Boolean);
  const at = resolve(cwd ?? ".");
  let root = at;
  for (let dir = at; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      root = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  const slash = (p: string): string => p.replace(/\\/g, "/");
  return { extra, root: slash(root), cwd: slash(at) };
}

interface ShellToolInput {
  command?: unknown;
}

async function onShell(
  input: HookInput,
  state: StoredSessionState,
  deps: HandleDeps,
): Promise<HandleResult> {
  const rawCommand = (input.tool_input as ShellToolInput | undefined)?.command;
  const command = typeof rawCommand === "string" ? rawCommand : "";
  if (!command) return {};
  const set = unattendedSet(command);
  const fromEnv = ON.test(deps.env?.GUARD_UNATTENDED ?? "");
  const unattended = fromEnv || (set ?? state.unattended) === true;

  try {
    const host = isHeavy(command, rules)
      ? await (deps.hostFacts ?? hostFacts)(input.cwd)
      : {};
    let unfinished = false;
    const envObj: GuardEnv = {
      TMPDIR: deps.env?.TMPDIR,
      TEMP: deps.env?.TEMP,
      TMP: deps.env?.TMP,
      HOME: deps.env?.HOME ?? deps.env?.USERPROFILE,
    };
    envObj.dirs = existingDirs(command, envObj, input.cwd);

    interface ShellFacts {
      branches?: Record<string, SafeFact | undefined>;
      env: GuardEnv;
      python?: string | null;
      refs?: Record<string, SafeFact | undefined>;
      regenerable?: Record<string, boolean | undefined>;
      stack?: StackFact | null;
      tags?: Record<string, TagFact | undefined>;
      worktrees?: Record<string, SafeFact | undefined>;
    }
    const facts: ShellFacts = { env: envObj };

    const inCwd = (
      argv: readonly string[],
      cwd?: string | null,
      ms?: number,
    ): Promise<string | null> =>
      (deps.run ?? run)(
        argv,
        cwd == null ? input.cwd : resolve(input.cwd ?? ".", cwd),
        ms,
      );

    if (isRisky(command, rules)) {
      const gathered = await within(
        Promise.all([
          worktreeFacts(command, facts.env, rules, inCwd),
          branchFacts(command, rules, inCwd, facts.env),
          regenFacts(command, facts.env, rules, inCwd),
          refFacts(command, rules, inCwd, facts.env),
        ]),
        deps.factsMs ?? FACTS_MS,
        null,
      );
      if (gathered) {
        [facts.worktrees, facts.branches, facts.regenerable, facts.refs] =
          gathered;
      } else {
        unfinished = true;
      }
    }

    if (
      !/^(0|false|off)$/i.test(deps.env?.GUARD_STACK_HINT ?? "") &&
      !state.reminded.includes("stack") &&
      stackTargets(command, rules, facts.env).length
    ) {
      const budget = deps.factsMs ?? STACK_MS;
      const deadline = Date.now() + budget;
      const stackRun = (
        argv: readonly string[],
        cwd?: string | null,
      ): Promise<string | null> => {
        const left = deadline - Date.now();
        return left <= 0 ? Promise.resolve(null) : inCwd(argv, cwd, left);
      };
      facts.stack = await within(
        stackFacts(command, rules, stackRun, facts.env),
        budget,
        {},
      );
    }

    if (
      tagTargets(command, rules, facts.env).some((t) => !t.name.startsWith("<"))
    ) {
      facts.tags =
        (await within(
          tagFacts(
            command,
            rules,
            (argv) => (deps.run ?? run)(argv, input.cwd),
            facts.env,
          ),
          deps.factsMs ?? FACTS_MS,
          null,
        )) ?? {};
    }

    if (deniedBy(command, rules)?.when) {
      const dir = deniedDir(command, rules, facts.env);
      facts.python = (deps.pythonManager ?? pythonManager)(
        dir ? resolve(input.cwd ?? ".", dir) : input.cwd,
      );
    }

    const permissionMode = (input as { permission_mode?: string })
      .permission_mode;
    const held =
      permissionMode === "auto"
        ? ["read", "edit"].filter((r) => !state.reminded.includes(r))
        : [];
    const reminded = new Set([...state.reminded, ...held]);
    const judged = hostJudged(command, rules, reminded);

    const d = evaluateCommand({
      command,
      loadedSkills: new Set(state.loaded),
      state: { reminded },
      host,
      readTool: deps.readTool ?? true,
      ...facts,
      factory: deps.env?.FACTORY_RUN_ID
        ? {
            ...factoryLabels(input.cwd),
            protect: protectFacts(deps.env, input.cwd),
          }
        : null,
      rules,
    });
    state.reminded = [...reminded].filter((r) => !held.includes(r));

    if (unfinished && d.action !== "allow") {
      d.reason = `${d.reason ?? ""}\nChecks unfinished: the worktree, branch and build-output lookups ran out of time, so a safe case could not be shown.`;
    }

    const report = (action: string, via?: string): void => {
      appendDecision(deps.env, {
        decision: action,
        rule: d.rule,
        cmd_hash: commandHash(command),
      });
      fire(
        deps,
        "guard.decision",
        {
          rule: d.rule,
          action,
          via,
          cmd_class: cmdClass(d.rule, command),
          tool: input.tool_name ?? "",
          session_id: input.session_id,
          tool_use_id: (input as { tool_use_id?: string }).tool_use_id,
          cmd_hash: commandHash(command),
          ...(d.rule === "host" ? hostAttrs(host) : {}),
        },
        input.cwd,
      );
    };

    const allowed = (via?: string): void => {
      if (!judged && (deps.random ?? Math.random)() * ALLOW_SAMPLE >= 1) return;
      const sampled = judged
        ? {
            rule: "host",
            sample_rate: 1,
            cmd_class: "host",
            ...hostAttrs(host),
          }
        : {
            rule: d.rule,
            sample_rate: ALLOW_SAMPLE,
            cmd_class: cmdClass(null, command),
          };
      fire(
        deps,
        "guard.decision",
        {
          action: "allow",
          via,
          ...sampled,
          tool: input.tool_name ?? "",
          session_id: input.session_id,
          tool_use_id: (input as { tool_use_id?: string }).tool_use_id,
          cmd_hash: commandHash(command),
        },
        input.cwd,
      );
    };

    if (d.remind) {
      fire(
        deps,
        "guard.reminder",
        {
          rule: d.rule,
          cmd_class: cmdClass(d.rule, command),
          tool: input.tool_name ?? "",
          session_id: input.session_id,
          tool_use_id: (input as { tool_use_id?: string }).tool_use_id,
        },
        input.cwd,
      );
    }

    if (d.action === "deny") {
      report("deny", d.split ? "split" : undefined);
      return preToolUse("deny", d.reason, deps.harness);
    }

    if (d.action === "ask" && unattended) {
      report("deny", "unattended");
      const source = fromEnv
        ? ""
        : " It was switched on by a command in this session; `export GUARD_UNATTENDED=0` turns it off.";
      return preToolUse(
        "deny",
        `${d.reason ?? ""}\nUnattended run (GUARD_UNATTENDED): nobody can confirm this, so the command was not run. Pick another approach, or leave it for the user.${source}`,
        deps.harness,
      );
    }

    if (d.action === "ask" && deps.noAsk) {
      if (await deps.nativeAsk?.(command, d.rule ?? "", input)) {
        report("ask", "native-ask");
        return {};
      }
      report("deny", "no-ask");
      return preToolUse(
        "deny",
        `${d.reason ?? ""}\nThis harness cannot ask for confirmation for this form, so the command was not run: ask the user to run it.`,
        deps.harness,
      );
    }

    if (d.action === "ask") {
      report("ask");
      const argv = d.rule
        ? previewCommand(d.rule, command, rules, facts.env)
        : null;
      return preToolUse(
        "ask",
        argv
          ? withPreview(
              d.reason ?? "",
              (await within(
                Promise.resolve((deps.run ?? run)(argv, input.cwd)),
                deps.previewMs ?? PREVIEW_MS,
                "",
              )) ?? "",
            )
          : d.reason,
        deps.harness,
      );
    }

    if (set !== null) state.unattended = set;

    if (!deps.noAsk && pureRead(command) && inWorkTree(input.cwd, deps.env)) {
      allowed("read");
      if (deps.harness === "antigravity") {
        return {
          stdout: JSON.stringify({
            decision: "allow",
            reason: "guard: a plain read of non-secret files",
          }),
        };
      }
      return {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: "guard: a plain read of non-secret files",
            ...(d.context ? { additionalContext: d.context } : {}),
          },
        }),
      };
    }

    allowed();
    return d.context
      ? deps.harness === "antigravity"
        ? {}
        : note(d.context)
      : {};
  } catch (err: unknown) {
    const errorObj = err instanceof Error ? err : null;
    if (isRisky(command, rules)) {
      appendDecision(deps.env, {
        decision: "deny",
        rule: "guard-error",
        cmd_hash: commandHash(command),
      });
      fire(
        deps,
        "guard.decision",
        {
          rule: "guard-error",
          action: "deny",
          cmd_class: "guard-error",
          tool: input.tool_name ?? "",
          session_id: input.session_id,
          tool_use_id: (input as { tool_use_id?: string }).tool_use_id,
          cmd_hash: commandHash(command),
        },
        input.cwd,
      );
    }
    return isRisky(command, rules)
      ? preToolUse(
          "deny",
          `The command guard failed, so this risky command was not run: ${errorObj ? errorObj.message : String(err)}`,
          deps.harness,
        )
      : {};
  }
}

interface EditToolInput {
  Path?: unknown;
  filePath?: unknown;
  file_path?: unknown;
  path?: unknown;
}

function onEdit(
  input: HookInput,
  state: StoredSessionState,
  deps: HandleDeps,
): HandleResult {
  const t = (input.tool_input as EditToolInput | undefined) ?? {};
  const reminded = new Set(state.reminded);
  const filePath = t.file_path ?? t.path ?? t.filePath ?? t.Path;
  const d = evaluateEdit({
    path: typeof filePath === "string" ? filePath : undefined,
    loadedSkills: new Set(state.loaded),
    state: { reminded },
    rules,
  });
  state.reminded = [...reminded];
  if (!d.remind) return {};
  fire(
    deps,
    "guard.reminder",
    {
      rule: d.rule,
      cmd_class: "hint",
      tool: input.tool_name ?? "",
      session_id: input.session_id,
      tool_use_id: (input as { tool_use_id?: string }).tool_use_id,
    },
    input.cwd,
  );
  return note(d.context ?? "");
}

interface SpawnToolInput {
  Model?: unknown;
  TypeName?: unknown;
  agentName?: unknown;
  agent_type?: unknown;
  effort?: unknown;
  model?: unknown;
  subagent_type?: unknown;
}

function onSpawn(
  input: HookInput,
  state: StoredSessionState,
  deps: HandleDeps,
): HandleResult {
  const t = (input.tool_input as SpawnToolInput | undefined) ?? {};
  const reminded = new Set(state.reminded);
  const typeVal = t.subagent_type ?? t.agent_type ?? t.agentName ?? t.TypeName;
  const modelVal = t.model ?? t.Model;
  const d = evaluateRouting({
    type: typeof typeVal === "string" ? typeVal : undefined,
    model: typeof modelVal === "string" ? modelVal : undefined,
    effort: typeof t.effort === "string" ? t.effort : undefined,
    tool: (input.tool_name ?? "").toLowerCase(),
    state: { reminded },
    rules,
  });
  state.reminded = [...reminded];
  if (!d.remind) return {};
  fire(
    deps,
    "guard.reminder",
    {
      rule: d.rule,
      cmd_class: "routing",
      tool: input.tool_name ?? "",
      session_id: input.session_id,
      tool_use_id: (input as { tool_use_id?: string }).tool_use_id,
    },
    input.cwd,
  );
  return note(d.context ?? "");
}

function onStale(
  input: HookInput,
  state: StoredSessionState,
  deps: HandleDeps,
  out: HandleResult,
): HandleResult {
  const decided =
    out.stdout &&
    (JSON.parse(out.stdout) as HookOutputPayload).hookSpecificOutput
      ?.permissionDecision;
  const reminded = state.reminded
    .filter((r) => r.startsWith("stale:"))
    .map((r) => r.slice(6));
  state.startCwd ??= typeof input.cwd === "string" ? input.cwd : undefined;
  const s = staleCheck({
    root: deps.pluginRoot,
    cwd: state.startCwd,
    loaded: state.plugins,
    reminded,
    harness: deps.harness,
  });
  state.plugins = s.loaded;
  if (!s.context || decided || deps.harness === "antigravity") return out;
  state.reminded.push(...s.remind.map((r) => `stale:${r}`));
  fire(
    deps,
    "guard.reminder",
    {
      rule: "stale-plugins",
      cmd_class: "hint",
      tool: input.tool_name ?? "",
      session_id: input.session_id,
      tool_use_id: (input as { tool_use_id?: string }).tool_use_id,
    },
    input.cwd,
  );
  const context = out.stdout
    ? (JSON.parse(out.stdout) as HookOutputPayload).hookSpecificOutput
        ?.additionalContext
    : null;
  return note(
    context ? `${context}\n${s.context}` : s.context,
    s.notice ?? undefined,
  );
}

export function inWorkTree(
  cwd?: string,
  env: NodeJS.ProcessEnv = {},
  plat: NodeJS.Platform = process.platform,
): boolean {
  if (typeof cwd !== "string" || !cwd) return false;
  const home = resolve(env.HOME ?? env.USERPROFILE ?? homedir());
  const isHome = (dir: string): boolean =>
    plat === "win32" ? dir.toLowerCase() === home.toLowerCase() : dir === home;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return !isHome(dir);
    if (dir === dirname(dir) || isHome(dir)) return false;
  }
}

interface ToolCallShape {
  args?: Record<string, unknown>;
  name?: string;
}

export interface ExtendedHookInput extends HookInput {
  conversationId?: string;
  modelName?: string;
  parent_agent_id?: string;
  permission_mode?: string;
  toolCall?: ToolCallShape;
  transcriptPath?: string;
  workspacePaths?: readonly string[];
}

export async function handle(
  input: ExtendedHookInput,
  deps: HandleDeps,
): Promise<HandleResult> {
  if (input.toolCall) {
    deps = { ...deps, harness: deps.harness ?? "antigravity" };
    input.session_id ??= input.conversationId;
    input.cwd ??= input.workspacePaths?.[0];
    input.tool_name ??= input.toolCall.name;
    const args = input.toolCall.args;
    input.tool_input ??= {
      command: args?.CommandLine ?? args?.command,
      path: args?.Path ?? args?.path,
      file_path: args?.Path ?? args?.file_path,
      filePath: args?.Path ?? args?.filePath,
      ...args,
    };
    input.hook_event_name ??= "PreToolUse";
  }

  const session =
    input.agent_id && input.parent_agent_id
      ? input.parent_agent_id
      : input.session_id;
  const store = sessionStore(
    deps.dataDir,
    session,
    input.agent_id,
    deps.processId ?? process.ppid,
  );
  const state: StoredSessionState = {
    ...store.load(),
  };

  if (
    deps.harness === "antigravity" &&
    (input.transcriptPath ||
      (input as { transcript_path?: string }).transcript_path)
  ) {
    const tPath =
      input.transcriptPath ??
      (input as { transcript_path?: string }).transcript_path;
    const newStep = await emitAntigravityUsage(
      tPath,
      input.conversationId ?? input.session_id,
      input.modelName,
      state.lastTranscriptStep,
      deps.env,
    );
    if (newStep !== undefined && newStep !== state.lastTranscriptStep) {
      state.lastTranscriptStep = newStep;
    }
  }

  const loadedBefore = [...state.loaded];
  const event = input.hook_event_name;
  let out: HandleResult = {};

  if (event === "SessionEnd") {
    store.sweep();
    return out;
  }

  if (event === "SessionStart") {
    if (!state.announced) {
      try {
        const { self, installed } = installedVersions(
          deps.pluginRoot,
          input.cwd,
        );
        if (self.versioned && self.version) installed[self.name] = self.version;
        const attrs = Object.fromEntries(
          Object.entries(installed).map(([p, v]) => [
            `plugin_version_${p.replace(/[^a-z0-9]/g, "_")}`,
            v,
          ]),
        );
        fire(
          deps,
          "guard.session",
          {
            session_id: input.session_id,
            source: input.source,
            ...attrs,
          },
          input.cwd,
        );
        state.announced = true;
      } catch {
        // a missing record changes nothing
      }
    }
  } else if (event === "UserPromptSubmit") {
    const m = /^\s*(?:\/(?:skill:)?|\$)([\w:-]+)/.exec(input.prompt ?? "");
    if (m?.[1]) state.loaded.push(m[1]);
  } else if (event === "PreToolUse") {
    const tool = (input.tool_name ?? "").toLowerCase();
    const t =
      (input.tool_input as
        | (EditToolInput & {
            command?: unknown;
            name?: unknown;
            skill?: unknown;
          })
        | undefined) ?? {};

    if (isReadTool(tool)) {
      const readPath =
        typeof t.file_path === "string"
          ? t.file_path
          : typeof t.path === "string"
            ? t.path
            : typeof t.filePath === "string"
              ? t.filePath
              : "";
      state.loaded.push(...skillsRead([readPath]));
    } else if (isShellTool(tool)) {
      state.loaded.push(
        ...skillsRead(
          readerArgs(typeof t.command === "string" ? t.command : ""),
        ),
      );
    }

    if (
      tool === "skill" &&
      (typeof t.skill === "string" || typeof t.name === "string")
    ) {
      state.loaded.push(
        typeof t.skill === "string"
          ? t.skill
          : typeof t.name === "string"
            ? t.name
            : "",
      );
    } else if (isShellTool(tool)) {
      out = await onShell(input, state, deps);
    } else if (isEditTool(tool)) {
      out = onEdit(input, state, deps);
    } else if (rules.routing.tools.includes(tool)) {
      out = onSpawn(input, state, deps);
    } else if (isTaskTool(tool)) {
      const command = taskCommand(tool, t as TaskInput, input.cwd);
      if (command) {
        out = await onShell({ ...input, tool_input: { command } }, state, deps);
      } else if (tool === "run_task") {
        out = note(
          `The guard could not read the command of task "${(t as TaskInput).id ?? ""}" in .vscode/tasks.json, so it did not check it. If it deletes, force-pushes or reads secrets, confirm with the user first.`,
        );
      }
    }

    try {
      out = onStale(input, state, deps, out);
    } catch {
      // the note is a nicety: a decision already made stands
    }
  }

  state.loaded = state.loaded.map(bareSkill);
  const before = new Set(loadedBefore.map(bareSkill));
  const known = deps.knownSkills ?? knownSkills();

  for (const skill of new Set(state.loaded)) {
    const name = skill.split(":").pop() ?? skill;
    if (
      !before.has(skill) &&
      (event !== "UserPromptSubmit" || known.has(name))
    ) {
      fire(
        deps,
        "guard.skill",
        {
          skill: name,
          cmd_class: "skill",
          via: event === "UserPromptSubmit" ? "prompt" : "tool",
          session_id: input.session_id,
        },
        input.cwd,
      );
    }
  }

  state.loaded = [...new Set(state.loaded)];
  try {
    store.save(state);
  } catch {
    // unwritable data dir: the decision still stands, a reminder may repeat
  }
  return out;
}

export const CODEX_RULES = "giocaizzi-guard.rules";

export function codexReviewer(transcript: string): string | undefined {
  const ctx = transcript
    .split("\n")
    .filter((l) => l.includes('"turn_context"'))
    .pop();
  if (!ctx) return undefined;
  try {
    const payload = (
      JSON.parse(ctx) as { payload?: { approvals_reviewer?: string } }
    ).payload;
    return payload?.approvals_reviewer;
  } catch {
    return undefined;
  }
}

const TAIL_BYTES = 256 * 1024;

export function tail(path: string, bytes: number = TAIL_BYTES): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

export function codexAsks(
  env: NodeJS.ProcessEnv,
  transcriptPath?: string,
): ((command: string, rule: string) => boolean) | null {
  try {
    if (!transcriptPath) return null;
    const home = env.CODEX_HOME ?? join(homedir(), ".codex");
    if (
      readFileSync(join(home, "rules", CODEX_RULES), "utf8") !==
      codexRules(rules)
    ) {
      return null;
    }
    if (codexReviewer(tail(transcriptPath)) !== "user") return null;
    return (command: string, rule: string) => nativeAsk(command, rule, rules);
  } catch {
    return null;
  }
}

interface AntigravityOut {
  decision: string;
  reason?: string;
}

async function main(): Promise<void> {
  const raw = readFileSync(0, "utf8");
  if (!raw.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const input = parsed as ExtendedHookInput;
  if (!input.hook_event_name && process.argv[2]) {
    input.hook_event_name = process.argv[2];
  }
  if (input.toolCall && !input.hook_event_name) {
    input.hook_event_name = "PreToolUse";
  }
  const dataDir = pluginDataDir();
  const noAsk = process.argv.includes("--no-ask");
  const flagHarness = process.argv
    .find((a) => a.startsWith("--harness="))
    ?.slice(10);
  const harness =
    flagHarness ??
    (input.toolCall ? "antigravity" : noAsk ? "codex" : harnessName());

  const out: HandleResult = await handle(input, {
    dataDir,
    harness,
    env: process.env,
    hostFacts,
    run,
    pythonManager,
    noAsk,
    readTool: !noAsk,
    nativeAsk: noAsk
      ? (command, rule) =>
          codexAsks(
            process.env,
            (input as { transcript_path?: string }).transcript_path,
          )?.(command, rule) ?? false
      : undefined,
    emit: (event, attrs, cwd) =>
      new Promise((r) => setImmediate(r)).then(() =>
        emit(process.env, event, recordAttrs(attrs, cwd, harness)),
      ),
  }).catch((): HandleResult => ({}));

  if (harness === "antigravity") {
    let agOut: AntigravityOut = { decision: "allow" };
    if (out.stdout) {
      try {
        const parsed = JSON.parse(out.stdout) as {
          decision?: string;
          hookSpecificOutput?: {
            permissionDecision?: string;
            permissionDecisionReason?: string;
          };
          reason?: string;
        };
        const decision =
          parsed.decision ?? parsed.hookSpecificOutput?.permissionDecision;
        const reason =
          parsed.reason ?? parsed.hookSpecificOutput?.permissionDecisionReason;
        if (decision === "deny" || decision === "ask") {
          agOut = { decision, ...(reason ? { reason } : {}) };
        } else if (decision === "allow") {
          agOut = { decision: "allow", ...(reason ? { reason } : {}) };
        }
      } catch {
        agOut = { decision: "allow" };
      }
    }
    process.stdout.write(JSON.stringify(agOut));
    if (out.stderr) process.stderr.write(out.stderr);
    return;
  }

  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  await main();
}
