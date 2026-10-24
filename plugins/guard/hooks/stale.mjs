// Stale plugins: a session keeps the plugin versions it loaded, so after an update it misses every fix until it
// reloads. The guard compares what this session runs with what is installed now and says so once per newer version.
// Never throws: anything unreadable reads as "nothing newer".
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SEMVER = /^\d+\.\d+\.\d+$/
const parts = (v) => String(v).split(/[.+-]/).slice(0, 3).map(Number)
export function newer(a, b) {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}
const maxVersion = (vs) => vs.filter((v) => SEMVER.test(v)).reduce((m, v) => (m && !newer(v, m) ? m : v), null)
const attempt = (f) => {
  try {
    return f()
  } catch {
    return null
  }
}
const manifestVersion = (dir) => attempt(() => JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).version) ?? null

// The plugin versions installed now, by plugin name, for the marketplace this plugin came from.
// - Versioned cache (`<cache>/<marketplace>/<plugin>/<version>`: Claude Code, Codex): Claude Code's
//   `installed_plugins.json` beside the cache when it has the plugin, else the newest version dir.
// - One dir per plugin, updated in place (Copilot CLI, VS Code, a checkout for opencode and pi): each sibling's manifest.
// `self` is this plugin's own name and version: in a versioned cache, exactly what the session loaded.
export function installedVersions(root = PLUGIN_ROOT) {
  const out = {}
  const name = basename(root)
  const versioned = SEMVER.test(name)
  const plugins = versioned ? dirname(dirname(root)) : dirname(root)
  const self = { name: versioned ? basename(dirname(root)) : name, version: manifestVersion(root), versioned }
  const marketplace = basename(plugins)
  const registry = versioned ? attempt(() => JSON.parse(readFileSync(join(plugins, '..', '..', 'installed_plugins.json'), 'utf8')).plugins) : null
  for (const p of attempt(() => readdirSync(plugins)) ?? []) {
    const listed = registry?.[`${p}@${marketplace}`]
    const v = Array.isArray(listed) ? maxVersion(listed.map((e) => e?.version)) : versioned ? maxVersion(attempt(() => readdirSync(join(plugins, p))) ?? []) : existsSync(join(plugins, p, '.claude-plugin')) ? manifestVersion(join(plugins, p)) : null
    if (v) out[p] = v
  }
  return { self, installed: out }
}

// How the user reloads plugins in a running session: a built-in command the agent cannot run itself. Codex,
// opencode and VS Code have none, so the session restarts (Codex: `codex resume --last`).
const RELOAD = { claude: 'ask the user to run `/reload-plugins`', copilot: 'ask the user to run `/restart`', pi: 'ask the user to run `/reload`', default: 'ask the user to restart the session' }

// `loaded`: the versions this session started with ({ name: version }, from the session's first check). Returns
// { loaded, remind: [`name@version`], context } with `loaded` grown by any plugin first seen now.
export function staleCheck({ root = PLUGIN_ROOT, loaded = {}, reminded = [], harness } = {}) {
  const r = attempt(() => installedVersions(root))
  if (!r) return { loaded, remind: [], context: null }
  const { self, installed } = r
  const now = { ...installed, ...loaded }
  if (self.versioned && self.version) now[self.name] = self.version
  const changes = Object.keys(installed).filter((p) => now[p] && newer(installed[p], now[p]) && !reminded.includes(`${p}@${installed[p]}`))
  if (!changes.length) return { loaded: now, remind: [], context: null }
  const list = changes.map((p) => `${p} ${now[p]} → ${installed[p]}`).join(', ')
  return { loaded: now, remind: changes.map((p) => `${p}@${installed[p]}`), context: `Harness plugins updated (${list}): ${RELOAD[harness] ?? RELOAD.default}.` }
}
