// Stale plugins: a session keeps the plugin versions it loaded, so after an update it misses every fix until it
// reloads. The guard compares what this session runs with what is installed now and says so once per newer version.
// Never throws: anything unreadable reads as "nothing newer".

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { PluginVersionMap } from "./types.mjs";

export const PLUGIN_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SEMVER = /^\d+\.\d+\.\d+$/;

const parts = (v: string): number[] => v.split(/[.+-]/).slice(0, 3).map(Number);

export function newer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    if (xi !== yi) return xi > yi;
  }
  return false;
}

const maxVersion = (vs: readonly string[]): string | null =>
  vs
    .filter((v) => SEMVER.test(v))
    .reduce<string | null>((m, v) => (m && !newer(v, m) ? m : v), null);

const attempt = <T,>(f: () => T): T | null => {
  try {
    return f();
  } catch {
    return null;
  }
};

interface PluginManifest {
  version?: string;
}

const manifestVersion = (dir: string): string | null =>
  attempt(() => {
    const raw = readFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      "utf8",
    );
    return (JSON.parse(raw) as PluginManifest).version ?? null;
  });

// A path as the file system names it: symlinks resolved, and lower-cased on a case-insensitive volume (macOS and
// Windows by default), where `Repo` and `repo` are one directory. Unreadable: as given.
const real = (p: string): string =>
  attempt(() => realpathSync.native(p)) ?? resolve(p);

function canonical(p: string): string {
  const r = real(p);
  const flipped = r.replace(/[a-z]/gi, (c) =>
    c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
  );
  const same =
    flipped !== r && attempt(() => statSync(flipped).ino === statSync(r).ino);
  return same ? r.toLowerCase() : r;
}

interface RegistryEntry {
  projectPath?: string;
  version?: string;
}

// The registry entries of a plugin that apply to a session started in `cwd`: a project or local install whose project
// holds `cwd` wins over a user one; another project's install does not apply here.
function scopedVersion(
  entries: readonly (RegistryEntry | undefined)[],
  cwd?: string,
): string | null {
  const here = cwd ? canonical(cwd) : null;
  const holds = (dir: string): boolean => {
    const d = canonical(dir);
    return (
      here === d || Boolean(here?.startsWith(d.endsWith(sep) ? d : d + sep))
    );
  };
  const project = entries.filter((e): e is RegistryEntry =>
    Boolean(e?.projectPath && here && holds(e.projectPath)),
  );
  const applicable = project.length
    ? project
    : entries.filter((e): e is RegistryEntry => Boolean(e && !e.projectPath));
  const versions = applicable
    .map((e) => e.version)
    .filter((v): v is string => typeof v === "string");
  return maxVersion(versions);
}

export interface SelfPluginInfo {
  name: string;
  version: string | null;
  versioned: boolean;
}

export interface InstalledVersionsResult {
  installed: PluginVersionMap;
  self: SelfPluginInfo;
}

interface InstalledPluginsRegistry {
  plugins?: Record<string, RegistryEntry[]>;
}

// The plugin versions installed now for a session in `cwd`, by plugin name, for the marketplace this plugin came from.
export function installedVersions(
  root: string = PLUGIN_ROOT,
  cwd?: string,
): InstalledVersionsResult {
  const out: PluginVersionMap = {};
  const name = basename(root);
  const versioned = SEMVER.test(name);
  const plugins = versioned ? dirname(dirname(root)) : dirname(root);
  const self: SelfPluginInfo = {
    name: versioned ? basename(dirname(root)) : name,
    version: manifestVersion(root),
    versioned,
  };
  const marketplace = basename(plugins);
  const registry = versioned
    ? attempt(() => {
        const raw = readFileSync(
          join(plugins, "..", "..", "installed_plugins.json"),
          "utf8",
        );
        return JSON.parse(raw) as InstalledPluginsRegistry;
      })
    : null;

  const pluginDirs = attempt(() => readdirSync(plugins)) ?? [];
  for (const p of pluginDirs) {
    const listed = registry?.plugins?.[`${p}@${marketplace}`];
    let v: string | null = null;
    if (Array.isArray(listed)) {
      v = scopedVersion(listed, cwd);
    } else if (versioned) {
      const subdirs = attempt(() => readdirSync(join(plugins, p))) ?? [];
      v = maxVersion(subdirs);
    } else if (existsSync(join(plugins, p, ".claude-plugin"))) {
      v = manifestVersion(join(plugins, p));
    }
    if (v) out[p] = v;
  }
  return { self, installed: out };
}

// How the user reloads plugins in a running session. Only the user can: `/reload-plugins` and the others are built-in
// commands no tool reaches. Codex, opencode and VS Code have none, so the session restarts (Codex: `codex resume --last`).
const RELOAD: Record<string, string> = {
  claude: "run `/reload-plugins`",
  copilot: "run `/restart`",
  pi: "run `/reload`",
  default: "restart the session",
};

export interface StaleCheckParams {
  cwd?: string;
  harness?: string;
  loaded?: PluginVersionMap;
  reminded?: readonly string[];
  root?: string;
}

export interface StaleCheckOutcome {
  context: string | null;
  loaded: PluginVersionMap;
  notice: string | null;
  remind: string[];
}

// `loaded`: the versions this session started with ({ name: version }, from the session's first check). Returns
// { loaded, remind: [`name@version`], notice, context } with `loaded` grown by any plugin first seen now: `notice` for
// the user, `context` for the agent, which cannot reload itself.
export function staleCheck({
  root = PLUGIN_ROOT,
  cwd,
  loaded = {},
  reminded = [],
  harness,
}: StaleCheckParams = {}): StaleCheckOutcome {
  const r = attempt(() => installedVersions(root, cwd));
  if (!r) return { loaded, remind: [], notice: null, context: null };
  const { self, installed } = r;
  const now: PluginVersionMap = { ...installed, ...loaded };
  if (self.versioned && self.version) now[self.name] = self.version;
  const changes = Object.keys(installed).filter((p) => {
    const current = now[p];
    const target = installed[p];
    return (
      current &&
      target &&
      newer(target, current) &&
      !reminded.includes(`${p}@${target}`)
    );
  });
  if (!changes.length) {
    return { loaded: now, remind: [], notice: null, context: null };
  }
  const list = changes
    .map((p) => `${p} ${now[p] ?? ""} → ${installed[p] ?? ""}`)
    .join(", ");
  const reloadCmd =
    (harness ? RELOAD[harness] : undefined) ?? RELOAD.default ?? "";
  const notice = `Harness plugins updated (${list}): ${reloadCmd} to load them.`;
  return {
    loaded: now,
    remind: changes.map((p) => `${p}@${installed[p] ?? ""}`),
    notice,
    context: `${notice} Only the user can do this: mention it to them once.`,
  };
}
