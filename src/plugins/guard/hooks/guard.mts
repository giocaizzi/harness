// Command hook for Claude Code, Copilot CLI, Antigravity, and VS Code Copilot: one hooks.json, one script, every OS.
// Both harnesses send Claude's payload (snake_case, `hook_event_name`); Copilot maps the PascalCase events
// and reads `hookSpecificOutput.permissionDecision`. A hook is a fresh process, so per-session facts
// (loaded skills, rules already reminded) live in a JSON file under $CLAUDE_PLUGIN_DATA.

import { execFile } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { statfs } from "node:fs/promises";
import { cpus, homedir, loadavg, platform } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type { win32 } from "node:path";
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
  protectedPathHit,
  prBatchFacts,
  pureRead,
  pushFacts,
  pushScanFacts,
  refFacts,
  regenFacts,
  remoteDeleteFacts,
  stackFacts,
  stackTargets,
  tagFacts,
  tagTargets,
  unattendedSet,
  withPreview,
  worktreeFacts,
} from "../core/engine.mjs";
import { cpuPercentFrom, hostCaps } from "../core/host.mjs";
import { emit } from "../core/otel.mjs";
import { sessionAttrs } from "../core/registration.mjs";
import { rules } from "../core/rules.mjs";
import { commandWords, units } from "../core/shell.mjs";
import type {
  GuardEnv,
  GuardRules,
  HostFacts,
  PrBatchFact,
  PushFact,
  PushScanFact,
  SafeFact,
  StackFact,
  TagFact,
} from "../core/types.mjs";
import { contractProbe } from "./contract.mjs";
import { appendDataFile, pluginDataDir, readDataFile } from "./data.mjs";
import { editedPaths } from "./lint.mjs";
import {
  OFF,
  sweepNotice,
  startSessionSweep,
  takeAgentNotes,
} from "./lifecycle.mjs";
import type { RunContext } from "./run.mjs";
import {
  denyReason,
  legacySet,
  recordUnregistered,
  runContext,
  runFacts,
} from "./run.mjs";
import {
  isEditTool,
  isReadTool,
  isShellTool,
  isTaskTool,
} from "./harnesses.mjs";
import { installedVersions, staleCheck } from "./stale.mjs";
import {
  EVENT_DEADLINE_MS,
  PRE_TOOL_DEADLINE_MS,
  readStdin,
} from "./stdin.mjs";
import {
  appendDecision,
  commandHash,
  harnessName,
  recordAttrs,
} from "./telemetry.mjs";
import {
  type HandleDeps,
  type HookInput,
  type HookOutputPayload,
  type PermissionDecision,
  type PluginVersionMap,
  isRecord,
} from "./types.mjs";

interface TaskEntry {
  args?: readonly (string | { value?: unknown })[];
  command?: string;
  id?: string;
  label?: string;
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

function asTaskEntry(value: unknown): TaskEntry | undefined {
  if (!isRecord(value)) return undefined;
  return {
    args: Array.isArray(value.args) ? value.args : undefined,
    command: typeof value.command === "string" ? value.command : undefined,
    id: typeof value.id === "string" ? value.id : undefined,
    label: typeof value.label === "string" ? value.label : undefined,
  };
}

export function asTaskInput(value: unknown): TaskInput {
  if (!isRecord(value)) return {};
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    task: asTaskEntry(value.task),
    workspaceFolder:
      typeof value.workspaceFolder === "string"
        ? value.workspaceFolder
        : undefined,
  };
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
    const json: unknown = JSON.parse(cleaned);
    const tasks =
      isRecord(json) && Array.isArray(json.tasks)
        ? (json.tasks as TaskEntry[])
        : undefined;
    const id = t.id ?? "";
    const label = id.indexOf(": ") > 0 ? id.slice(id.indexOf(": ") + 2) : id;
    return taskLine(
      tasks?.find((x) => isRecord(x) && (x.label === label || x.label === id)),
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

const FACTS_MAX_BYTES = 4 * 1024 * 1024;
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
      // missing, or not a regular file of bounded size: no facts yet
      const text = readDataFile(file, FACTS_MAX_BYTES) ?? "";
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
      appendDataFile(file, lines.join("\n") + "\n");
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

// Risky for the crash fallback: also a lease push, which is risky only through facts the crashed engine did not judge.
export const crashRisky = (command: string, rules: GuardRules) =>
  isRisky(command, rules) || command.includes("--force-w");

// The answer when guard itself crashed: a PreToolUse in a run is denied (a crash must not let a tool call through), in
// every mode; the manifest variable counts as set when defined, even blank, as the loader reads it. Anything else is
// allowed.
export function crashResult(
  input: { hook_event_name?: string },
  env: Readonly<Record<string, string | undefined>>,
  harness?: string,
): HandleResult {
  return input.hook_event_name === "PreToolUse" &&
    (legacySet(env) ||
      (env.GUARD_RUN_ID ?? "").trim() !== "" ||
      env.GUARD_RUN_MANIFEST !== undefined)
    ? preToolUse(
        "deny",
        "The command guard failed in a registered run, so this tool call was not run.",
        harness,
      )
    : {};
}

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

// The lifecycle functions (hooks/lifecycle.mjs) a test replaces with fakes through `deps.lifecycle`.
export interface LifecycleHooks {
  startSessionSweep: typeof startSessionSweep;
  sweepNotice: typeof sweepNotice;
  takeAgentNotes: typeof takeAgentNotes;
}
export type GuardDeps = HandleDeps & { lifecycle?: Partial<LifecycleHooks> };
const lifecycleOf = (deps: GuardDeps): LifecycleHooks => ({
  startSessionSweep,
  sweepNotice,
  takeAgentNotes,
  ...deps.lifecycle,
});

// One deadline per command for every fact it gathers, kept under the 30 s PreToolUse timeout in hooks.json: the push
// scan runs first with up to SCAN_MS, and the other lookups get what is left.
const TOTAL_MS = 24_000;
const SCAN_MS = 15_000;
// An off switch the hook's env sets, else the process's (a test run exports GUARD_PUSH_SCAN and GUARD_LIFECYCLE off).
const flag = (
  deps: { env?: Record<string, string | undefined> },
  name: string,
) => deps.env?.[name] ?? process.env[name] ?? "";
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

export interface ProtectFactsResult {
  cwd: string;
  root: string;
}

// Where the session is: the repo root (the nearest directory with a .git) and the cwd, `/` separators.
export function protectFacts(cwd?: string): ProtectFactsResult {
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
  return { root: slash(root), cwd: slash(at) };
}

const slashes = (p: string): string => p.replace(/\\/g, "/");

const isReadableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

async function onShell(
  input: HookInput,
  state: StoredSessionState,
  deps: HandleDeps,
  ctx: RunContext,
): Promise<HandleResult> {
  const rawCommand = isRecord(input.tool_input)
    ? input.tool_input.command
    : undefined;
  const command = typeof rawCommand === "string" ? rawCommand : "";
  if (!command) return {};
  const set = unattendedSet(command);
  const fromEnv = ON.test(deps.env?.GUARD_UNATTENDED ?? "");
  const unattended = fromEnv || (set ?? state.unattended) === true;

  try {
    const caps = hostCaps(deps.env, rules.host);
    const host =
      !caps.off && isHeavy(command, rules)
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
    const privateConfig = deps.env?.GITLEAKS_PRIVATE_CONFIG;
    if (privateConfig && isReadableFile(privateConfig))
      envObj.GITLEAKS_PRIVATE_CONFIG = privateConfig;

    interface ShellFacts {
      branches?: Record<string, SafeFact | undefined>;
      env: GuardEnv;
      python?: string | null;
      prBatch?: Record<string, PrBatchFact | undefined>;
      pushScan?: Record<string, PushScanFact | undefined>;
      pushes?: Record<string, PushFact | undefined>;
      refs?: Record<string, SafeFact | undefined>;
      remoteDeletes?: Record<string, SafeFact | undefined>;
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

    const total = deps.factsMs ?? TOTAL_MS;
    const deadline = Date.now() + total;
    const left = () => Math.max(0, deadline - Date.now());

    // Every push is scanned for secrets first; a scan that cannot finish in its budget asks (unavailable).
    if (
      !OFF.test(flag(deps, "GUARD_PUSH_SCAN")) &&
      rules.pushScan &&
      new RegExp(rules.pushScan.match, "i").test(command)
    ) {
      facts.pushScan = await within(
        pushScanFacts(command, rules, inCwd, facts.env),
        Math.min(SCAN_MS, total),
        { "": { findings: [], private: [], status: "unavailable" } },
      );
    }

    // A bare lease push is no risky match by itself: its facts are gathered for it, and none (timeout) asks. Started
    // with the risky lookups so both share one budget, keeping the hook under its timeout.
    const pushing = command.includes("--force-w")
      ? within(pushFacts(command, rules, inCwd, facts.env), left(), null)
      : null;

    if (isRisky(command, rules)) {
      const gathered = await within(
        Promise.all([
          worktreeFacts(command, facts.env, rules, inCwd),
          branchFacts(command, rules, inCwd, facts.env),
          regenFacts(command, facts.env, rules, inCwd),
          refFacts(command, rules, inCwd, facts.env),
          remoteDeleteFacts(command, rules, inCwd, facts.env),
        ]),
        left(),
        null,
      );
      if (gathered) {
        [
          facts.worktrees,
          facts.branches,
          facts.regenerable,
          facts.refs,
          facts.remoteDeletes,
        ] = gathered;
      } else {
        unfinished = true;
      }
    }

    if (pushing) facts.pushes = (await pushing) ?? {};

    // A new PR that overlaps another open PR of the author: reads fail open.
    if (rules.prBatch && new RegExp(rules.prBatch.match, "i").test(command)) {
      facts.prBatch = await within(
        prBatchFacts(command, rules, inCwd, facts.env, (path, cwd) =>
          readText(resolve(input.cwd ?? ".", cwd ?? ".", path)),
        ),
        left(),
        {},
      );
    }

    if (
      !/^(0|false|off)$/i.test(deps.env?.GUARD_STACK_HINT ?? "") &&
      !state.reminded.includes("stack") &&
      stackTargets(command, rules, facts.env).length
    ) {
      const budget = Math.min(deps.factsMs ?? STACK_MS, left());
      const stackDeadline = Date.now() + budget;
      const stackRun = (
        argv: readonly string[],
        cwd?: string | null,
      ): Promise<string | null> => {
        const rest = stackDeadline - Date.now();
        return rest <= 0 ? Promise.resolve(null) : inCwd(argv, cwd, rest);
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
          left(),
          null,
        )) ?? {};
    }

    if (deniedBy(command, rules)?.when) {
      const dir = deniedDir(command, rules, facts.env);
      facts.python = (deps.pythonManager ?? pythonManager)(
        dir ? resolve(input.cwd ?? ".", dir) : input.cwd,
      );
    }

    const permissionMode = input.permission_mode;
    const held =
      permissionMode === "auto"
        ? ["read", "edit"].filter((r) => !state.reminded.includes(r))
        : [];
    const reminded = new Set([...state.reminded, ...held]);
    const judged = !caps.off && hostJudged(command, rules, reminded);

    const d = evaluateCommand({
      command,
      loadedSkills: new Set(state.loaded),
      state: { reminded },
      host,
      readTool: deps.readTool ?? true,
      ...facts,
      run:
        ctx.state === "registered"
          ? runFacts(ctx, protectFacts(input.cwd))
          : null,
      rules: {
        ...rules,
        host: {
          ...rules.host,
          loadCap: caps.loadCap,
          cpuPercentCap: caps.cpuPercentCap,
          freeFloorGb: caps.freeFloorGb,
        },
      },
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
          tool_use_id: input.tool_use_id,
          cmd_hash: commandHash(command),
          ...(d.rule === "host" ? hostAttrs(host) : {}),
          ...d.attrs,
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
          tool_use_id: input.tool_use_id,
          cmd_hash: commandHash(command),
        },
        input.cwd,
      );
    };

    if (d.prBatch) {
      fire(
        deps,
        "guard.decision",
        {
          rule: "pr-batch",
          action: "allow",
          reason: d.prBatch,
          cmd_class: "hint",
          tool: input.tool_name ?? "",
          session_id: input.session_id,
          tool_use_id: input.tool_use_id,
          cmd_hash: commandHash(command),
        },
        input.cwd,
      );
    }

    if (d.remind) {
      fire(
        deps,
        "guard.reminder",
        {
          rule: d.rule,
          cmd_class: cmdClass(d.rule, command),
          tool: input.tool_name ?? "",
          session_id: input.session_id,
          tool_use_id: input.tool_use_id,
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
    // A crash must not let an unattended run's write through: every command is denied there, not only risky ones.
    const strict = ctx.state === "registered" && ctx.mode === "unattended";
    if (strict || crashRisky(command, rules)) {
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
          tool_use_id: input.tool_use_id,
          cmd_hash: commandHash(command),
        },
        input.cwd,
      );
    }
    return strict || crashRisky(command, rules)
      ? preToolUse(
          "deny",
          `The command guard failed, so this ${strict ? "" : "risky "}command was not run: ${errorObj ? errorObj.message : String(err)}`,
          deps.harness,
        )
      : {};
  }
}

// The files an edit tool call writes, moves or deletes: editedPaths, the `Path` spelling, and the `*** Delete File:`
// and `*** Move to:` lines of an apply_patch text (the whole tool_input, `command` or `input`).
// Each with its lexical reading (`resolve`: `d/../x` is `x`) and its raw one (made absolute, nothing normalised: the
// kernel follows `d` before the `..`).
function touchedFiles(input: HookInput): { lex: string; raw: string }[] {
  const t = input.tool_input;
  const obj = isRecord(t) ? t : {};
  const text =
    typeof t === "string"
      ? t
      : typeof obj.command === "string"
        ? obj.command
        : typeof obj.input === "string"
          ? obj.input
          : "";
  const lines = [
    ...text.matchAll(/^\*\*\* (?:Delete File|Move to): (.+)$/gm),
  ].map((m) => m[1]?.trim() ?? "");
  const base = input.cwd ?? ".";
  const absBase = isAbsolute(base) ? base : resolve(base);
  const seen = new Map<string, { lex: string; raw: string }>();
  for (const p of [
    ...editedPaths(input),
    ...(typeof obj.Path === "string" ? [obj.Path] : []),
    ...lines,
  ].filter(Boolean)) {
    const lex = resolve(base, p);
    const raw = isAbsolute(p) ? p : `${absBase}${sep}${p}`;
    seen.set(`${lex}\0${raw}`, { lex, raw });
  }
  return [...seen.values()];
}

const MAX_LINK_HOPS = 40;

// `path` with the real path of its nearest existing ancestor, as `/` segments. The path is walked as given, never
// normalised first, and each component is followed in turn, as the kernel does: a symlink is replaced by its target
// before the next `..` applies (`n -> d/../x` with `d -> a/b` is `a/x`; `d/../x` is `a/x` too), and a dangling one,
// in the last component or any other, is followed too (a write tool creates its target); null past MAX_LINK_HOPS
// links (a loop): the caller treats the path as protected. With `lexical` on win32, where a `..` in a relative link
// target may apply to the link's own directory as text, the target is normalised before it is followed.
export interface LinkEnv {
  platform: NodeJS.Platform;
  path: Pick<
    typeof win32,
    "dirname" | "isAbsolute" | "join" | "parse" | "resolve" | "sep"
  >;
  isLink: (path: string) => boolean;
  readLink: (path: string) => string;
}

const linkEnv: LinkEnv = {
  platform: process.platform,
  path: { dirname, isAbsolute, join, parse, resolve, sep },
  isLink: (p) => lstatSync(p).isSymbolicLink(),
  readLink: readlinkSync,
};

export function realish(
  path: string,
  lexical = false,
  env: LinkEnv = linkEnv,
): string | null {
  const { dirname, isAbsolute, join, parse, resolve, sep } = env.path;
  const top = parse(path).root;
  let cur = top;
  let missing = false;
  let hops = 0;
  const split = (p: string) =>
    p.split(env.platform === "win32" ? /[\\/]/ : sep).filter(Boolean);
  const queue = split(path.slice(top.length));
  while (queue.length) {
    const comp = queue.shift() ?? "";
    if (comp === ".") continue;
    if (comp === "..") {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, comp);
    let link: string | undefined;
    if (!missing) {
      try {
        if (env.isLink(next)) link = env.readLink(next);
        else cur = next;
      } catch {
        missing = true;
      }
    }
    if (link !== undefined) {
      if (++hops > MAX_LINK_HOPS) return null;
      const target =
        lexical && env.platform === "win32" ? resolve(cur, link) : link;
      if (isAbsolute(target)) cur = parse(target).root;
      queue.unshift(
        ...split(isAbsolute(target) ? target.slice(cur.length) : target),
      );
    } else if (missing) cur = next;
  }
  return slashes(cur);
}

// Every reading of an edit tool's target that counts, and any that hits denies: the lexical one (`d/../x` is `x`), and the
// real path of the raw spelling and of the lexical one (the kernel follows a link before a `..`; win32 may apply a `..`
// in a link target as text).
export function readingsOf(
  f: { lex: string; raw: string },
  env: LinkEnv = linkEnv,
): (string | null)[] {
  const out = [
    slashes(f.lex),
    realish(f.raw, false, env),
    realish(f.lex, false, env),
  ];
  if (env.platform === "win32")
    out.push(realish(f.raw, true, env), realish(f.lex, true, env));
  return [...new Set(out)];
}

// `path` relative to `dir` (both `/` separated, letter case ignored), or null when it is not inside.
const relativeInside = (path: string, dir: string): string | null => {
  const a = path.split("/").filter(Boolean);
  const b = dir.split("/").filter(Boolean);
  return b.length <= a.length &&
    b.every((x, i) => x.toLowerCase() === (a[i] ?? "").toLowerCase())
    ? a.slice(b.length).join("/")
    : null;
};

function onEdit(
  input: HookInput,
  state: StoredSessionState,
  deps: HandleDeps,
  ctx: RunContext,
): HandleResult {
  const facts =
    ctx.state === "registered" ? runFacts(ctx, protectFacts(input.cwd)) : null;
  // In an unattended registered run an edit tool never touches a protected path.
  if (facts) {
    const denyEdit = (reason: string): HandleResult => {
      appendDecision(deps.env, { decision: "deny", rule: "protected-path" });
      fire(
        deps,
        "guard.decision",
        {
          rule: "protected-path",
          action: "deny",
          cmd_class: "protected-path",
          tool: input.tool_name ?? "",
          session_id: input.session_id,
          tool_use_id: input.tool_use_id,
        },
        input.cwd,
      );
      return preToolUse("deny", reason, deps.harness);
    };
    const files = touchedFiles(input).map((f) => ({
      name: f.lex,
      raw: f.raw,
      readings: readingsOf(f),
    }));
    const loop = files.find((f) => f.readings.includes(null));
    if (loop !== undefined)
      return denyEdit(
        `${rules.run.protectedWhy} \`${loop.name}\` goes through too many symbolic links to be checked; leave it alone.`,
      );
    const protect = {
      globs: [...rules.run.protectedPaths, ...(facts.protect?.extra ?? [])],
      registered: facts.protect?.registered ?? [],
      exempt: facts.protect?.exempt ?? [],
    };
    const root = facts.protect?.root ?? protectFacts(input.cwd).root;
    const bases = [...new Set([slashes(root), realish(root) ?? slashes(root)])];
    for (const f of files) {
      for (const file of f.readings) {
        for (const base of bases) {
          const rel = relativeInside(file ?? "", base);
          if (rel === null) continue;
          if (protectedPathHit(rel, protect, rules.run.protectedLimits))
            return denyEdit(
              `${rules.run.protectedWhy} \`${rel}\` is a protected path in this run; leave it to the owner and say on the ticket what should change.`,
            );
        }
      }
    }
  }
  const t = isRecord(input.tool_input) ? input.tool_input : {};
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
      tool_use_id: input.tool_use_id,
    },
    input.cwd,
  );
  return note(d.context ?? "");
}

function onSpawn(
  input: HookInput,
  state: StoredSessionState,
  deps: HandleDeps,
): HandleResult {
  const t = isRecord(input.tool_input) ? input.tool_input : {};
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
      tool_use_id: input.tool_use_id,
    },
    input.cwd,
  );
  return note(d.context ?? "");
}

function onStale(
  input: HookInput,
  state: StoredSessionState,
  deps: GuardDeps,
  out: HandleResult,
  session?: string,
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
  if (decided || deps.harness === "antigravity") return out;
  const contexts: string[] = [];
  const notices: string[] = [];
  const remind = (rule: string): void => {
    fire(
      deps,
      "guard.reminder",
      {
        rule,
        cmd_class: "hint",
        tool: input.tool_name ?? "",
        session_id: input.session_id,
        tool_use_id: (input as { tool_use_id?: string }).tool_use_id,
      },
      input.cwd,
    );
  };
  if (s.context) {
    state.reminded.push(...s.remind.map((r) => `stale:${r}`));
    remind("stale-plugins");
    contexts.push(s.context);
    if (s.notice) notices.push(s.notice);
  }
  // Branch lifecycle: the previous sweep's summary once per session, and the notes other hooks queued for the agent.
  if (!OFF.test(flag(deps, "GUARD_LIFECYCLE"))) {
    if (!state.reminded.includes("repo-sweep")) {
      state.reminded.push("repo-sweep");
      const notice = lifecycleOf(deps).sweepNotice(
        state.startCwd ?? ".",
        deps.env ?? {},
      );
      if (notice) {
        remind("repo-sweep");
        contexts.push(
          `${notice}\nMention it once; do not sweep further unless the user asks.`,
        );
        notices.push(notice);
      }
    }
    if (session) {
      const dataDir = deps.dataDir ?? pluginDataDir(deps.env ?? process.env);
      for (const text of lifecycleOf(deps).takeAgentNotes(dataDir, session)) {
        remind("branch-lifecycle");
        contexts.push(text);
      }
    }
  }
  if (!contexts.length) return out;
  const context = out.stdout
    ? (JSON.parse(out.stdout) as HookOutputPayload).hookSpecificOutput
        ?.additionalContext
    : null;
  return note(
    context ? `${context}\n${contexts.join("\n")}` : contexts.join("\n"),
    notices.length ? notices.join("\n") : undefined,
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
  transcript_path?: string;
  workspacePaths?: readonly string[];
}

export function handleSessionEnd(store: SessionStoreInstance): HandleResult {
  store.sweep();
  return {};
}

export function handleSessionStart(
  input: ExtendedHookInput,
  deps: GuardDeps,
  session: string | undefined,
  state: StoredSessionState,
): HandleResult {
  if (!state.announced) {
    try {
      const { self, installed } = installedVersions(deps.pluginRoot, input.cwd);
      if (self.versioned && self.version) installed[self.name] = self.version;
      const start = runContext(deps.env ?? {}, {
        dataDir: deps.dataDir,
        sessionId: session,
        cache: deps.registrationCache,
        vet: deps.runVet,
      });
      const registered = start.state === "registered" ? start : null;
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
          ...sessionAttrs(registered),
        },
        input.cwd,
      );
      state.announced = true;
      // The daily repo sweep (github-pull-requests, Branch lifecycle): detached, never throws, off with GUARD_LIFECYCLE=off.
      if (
        !OFF.test(flag(deps, "GUARD_LIFECYCLE")) &&
        deps.pluginRoot &&
        typeof input.cwd === "string"
      ) {
        try {
          lifecycleOf(deps).startSessionSweep({
            cwd: input.cwd,
            env: deps.env ?? {},
            pluginRoot: deps.pluginRoot,
            registered: registered !== null,
          });
        } catch {
          // the sweep is a nicety
        }
      }
    } catch {
      // a missing record changes nothing
    }
  }
  return {};
}

export function handleUserPromptSubmit(
  input: ExtendedHookInput,
  state: StoredSessionState,
): HandleResult {
  const m = /^\s*(?:\/(?:skill:)?|\$)([\w:-]+)/.exec(input.prompt ?? "");
  if (m?.[1]) state.loaded.push(m[1]);
  return {};
}

export async function handlePreToolUse(
  input: ExtendedHookInput,
  deps: HandleDeps,
  session: string | undefined,
  state: StoredSessionState,
): Promise<HandleResult> {
  const tool = (input.tool_name ?? "").toLowerCase();
  const t = isRecord(input.tool_input) ? input.tool_input : {};

  if (isReadTool(tool)) {
    const readPath =
      typeof t.file_path === "string"
        ? t.file_path
        : typeof t.path === "string"
          ? t.path
          : typeof t.filePath === "string"
            ? t.filePath
            : typeof t.Path === "string"
              ? t.Path
              : "";
    state.loaded.push(...skillsRead([readPath]));
  } else if (isShellTool(tool)) {
    state.loaded.push(
      ...skillsRead(readerArgs(typeof t.command === "string" ? t.command : "")),
    );
  }

  const ctx = runContext(deps.env ?? {}, {
    dataDir: deps.dataDir,
    sessionId: session,
    cache: deps.registrationCache,
    vet: deps.runVet,
  });

  let out: HandleResult = {};

  if (ctx.state === "deny") {
    // A run whose registration failed, or that set only legacy variables: every tool call guard sees is denied.
    if (ctx.rule === "run-unregistered")
      recordUnregistered(
        deps.env ?? {},
        deps.dataDir ?? pluginDataDir(deps.env ?? process.env),
        session,
      );
    const cmd =
      isShellTool(tool) && typeof t.command === "string" ? t.command : null;
    appendDecision(deps.env, {
      decision: "deny",
      rule: ctx.rule,
      ...(cmd === null ? {} : { cmd_hash: commandHash(cmd) }),
    });
    fire(
      deps,
      "guard.decision",
      {
        rule: ctx.rule,
        action: "deny",
        cmd_class: ctx.rule,
        tool: input.tool_name ?? "",
        session_id: input.session_id,
        tool_use_id: input.tool_use_id,
      },
      input.cwd,
    );
    out = preToolUse("deny", denyReason(ctx, "tool"), deps.harness);
  } else if (
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
    out = await onShell(input, state, deps, ctx);
  } else if (isEditTool(tool)) {
    out = onEdit(input, state, deps, ctx);
  } else if (rules.routing.tools.includes(tool)) {
    out = onSpawn(input, state, deps);
  } else if (isTaskTool(tool)) {
    const taskInput = asTaskInput(input.tool_input);
    const command = taskCommand(tool, taskInput, input.cwd);
    if (command) {
      out = await onShell(
        { ...input, tool_input: { command } },
        state,
        deps,
        ctx,
      );
    } else if (tool === "run_task") {
      out = note(
        `The guard could not read the command of task "${taskInput.id ?? ""}" in .vscode/tasks.json, so it did not check it. If it deletes, force-pushes or reads secrets, confirm with the user first.`,
      );
    }
  }

  try {
    out = onStale(input, state, deps, out, session);
  } catch {
    // the note is a nicety: a decision already made stands
  }

  return out;
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

  const loadedBefore = [...state.loaded];
  const event = input.hook_event_name;

  if (event === "SessionEnd") {
    return handleSessionEnd(store);
  }

  let out: HandleResult = {};
  if (event === "SessionStart") {
    out = handleSessionStart(input, deps, session, state);
  } else if (event === "UserPromptSubmit") {
    out = handleUserPromptSubmit(input, state);
  } else if (event === "PreToolUse") {
    out = await handlePreToolUse(input, deps, session, state);
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
    const parsed: unknown = JSON.parse(ctx);
    if (
      isRecord(parsed) &&
      isRecord(parsed.payload) &&
      typeof parsed.payload.approvals_reviewer === "string"
    ) {
      return parsed.payload.approvals_reviewer;
    }
    return undefined;
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

// A PreToolUse payload that cannot be read whole is denied, never allowed: the guard did not see the tool call.
function denyUnreadable(why: string, isAgy: boolean): void {
  const reason = `guard: could not read this tool call (${why}), so it is denied. Retry it once; a tool input over 32 MiB is always denied, so split it. If it is denied again, stop and tell the user that guard cannot read tool calls.`;
  try {
    appendDecision(process.env, { decision: "deny", rule: "guard-input" });
  } catch {
    // telemetry only
  }
  process.stdout.write(
    preToolUse("deny", reason, isAgy ? "antigravity" : undefined).stdout ?? "",
    () => {
      process.exit(0);
    },
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--contract")) {
    process.stdout.write(`${JSON.stringify(contractProbe())}\n`);
    return;
  }
  const flagHarness = process.argv
    .find((a) => a.startsWith("--harness="))
    ?.slice(10);
  const isAgy = flagHarness === "antigravity";
  const isPre = process.argv[2] === "PreToolUse" || isAgy;

  const read = await readStdin(process.stdin, {
    deadlineMs: isPre ? PRE_TOOL_DEADLINE_MS : EVENT_DEADLINE_MS,
  });
  const failClosed = (why: string): void => {
    if (isPre) {
      denyUnreadable(why, isAgy);
    }
  };
  if (!read.ok) {
    failClosed(read.why);
    return;
  }
  const raw = read.text;
  if (!raw.trim()) {
    // a TTY (manual run) reads as empty too: only a closed pipe with nothing on it is an unreadable call
    if (!process.stdin.isTTY) failClosed("empty input");
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failClosed("input is not JSON");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    failClosed("input is not a JSON object");
    return;
  }
  const input = parsed as ExtendedHookInput;
  if (!input.hook_event_name && process.argv[2]) {
    input.hook_event_name = process.argv[2];
  }
  if (input.toolCall && !input.hook_event_name) {
    input.hook_event_name = "PreToolUse";
  }
  const dataDir = pluginDataDir();
  const noAsk = process.argv.includes("--no-ask");
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
          codexAsks(process.env, input.transcript_path)?.(command, rule) ??
          false
      : undefined,
    emit: (event, attrs, cwd) =>
      new Promise((r) => setImmediate(r)).then(() =>
        emit(process.env, event, recordAttrs(attrs, cwd, harness)),
      ),
  }).catch((): HandleResult => crashResult(input, process.env, harness));

  if (harness === "antigravity") {
    let agOut: AntigravityOut = { decision: "allow" };
    if (out.stdout) {
      try {
        const parsed: unknown = JSON.parse(out.stdout);
        if (isRecord(parsed)) {
          const hso = isRecord(parsed.hookSpecificOutput)
            ? parsed.hookSpecificOutput
            : undefined;
          const decision =
            (typeof parsed.decision === "string"
              ? parsed.decision
              : undefined) ??
            (typeof hso?.permissionDecision === "string"
              ? hso.permissionDecision
              : undefined);
          const reason =
            (typeof parsed.reason === "string" ? parsed.reason : undefined) ??
            (typeof hso?.permissionDecisionReason === "string"
              ? hso.permissionDecisionReason
              : undefined);
          if (decision === "deny" || decision === "ask") {
            agOut = { decision, ...(reason ? { reason } : {}) };
          } else if (decision === "allow") {
            agOut = { decision: "allow", ...(reason ? { reason } : {}) };
          }
        }
      } catch {
        agOut = { decision: "allow" };
      }
    }
    process.stdout.write(JSON.stringify(agOut));
    if (out.stderr) process.stderr.write(out.stderr);
    process.exit(0);
  }

  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  await main();
}
