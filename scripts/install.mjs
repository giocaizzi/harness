#!/usr/bin/env node
// Install what a harness cannot take from the marketplace, from this checkout, on every OS (plain copies, no
// symlinks). Re-run after `git pull`; files a previous run installed and this one no longer ships are removed.
//   node scripts/install.mjs codex        agents (.generated/codex/*.toml) -> $CODEX_HOME/agents (default ~/.codex), guard prompt rules -> rules/
//   node scripts/install.mjs opencode     skills, agents and the guard and sounds plugins -> $XDG_CONFIG_HOME/opencode (default ~/.config),
//                                         hud's TUI plugin -> its tui.json
//   node scripts/install.mjs antigravity  skills, agents (.generated/antigravity/*.md) -> $GEMINI_CONFIG_DIR (default ~/.gemini/config), guard hooks -> hooks.json
// Claude Code, Copilot CLI and VS Code install from the marketplace, Codex its plugins too, pi with
// `pi install git:github.com/giocaizzi/harness`: see docs/install.md.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { codexRules } from '../plugins/guard/core/engine.mjs'
import { rules } from '../plugins/guard/core/rules.mjs'
import { CODEX_RULES } from '../plugins/guard/hooks/guard.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS = join(REPO, 'plugins')
const plugins = () => readdirSync(PLUGINS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(PLUGINS, d.name))
const ls = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])

// [source, target-relative path] pairs, or [null, path, content] for a generated file.
export function plan(harness) {
  if (harness === 'codex')
    return [
      ...plugins().flatMap((p) => ls(join(p, '.generated', 'codex')).filter((f) => f.name.endsWith('.toml')).map((f) => [join(p, '.generated', 'codex', f.name), join('agents', f.name)])),
      // The guard's prompt rules: Codex asks for these risky commands itself (hooks cannot ask).
      [null, join('rules', CODEX_RULES), codexRules(rules)],
    ]
  if (harness === 'opencode') {
    const stub = (plugin) => `// Installed by giocaizzi/harness scripts/install.mjs; re-run it after a pull.\nexport * from ${JSON.stringify(pathToFileURL(join(PLUGINS, plugin, 'hooks', 'opencode.mjs')).href)}\n`
    return [
      ...plugins().flatMap((p) => ls(join(p, 'skills')).filter((d) => d.isDirectory()).map((d) => [join(p, 'skills', d.name), join('skills', d.name)])),
      ...plugins().flatMap((p) => ls(join(p, '.generated', 'opencode')).filter((f) => f.name.endsWith('.md')).map((f) => [join(p, '.generated', 'opencode', f.name), join('agents', f.name)])),
      ...['guard', 'sounds'].map((plugin) => [null, join('plugins', `giocaizzi-${plugin}.js`), stub(plugin)]),
    ]
  }
  if (harness === 'antigravity') {
    const guardScript = join(PLUGINS, 'guard', 'hooks', 'guard.mjs')
    const stopScript = join(PLUGINS, 'guard', 'hooks', 'stop.mjs')
    const agyHooks = JSON.stringify({
      'giocaizzi-guard': {
        PreToolUse: [
          {
            matcher: 'run_command|read_file|view_file|edit_file|write_file|invoke_subagent',
            hooks: [
              {
                type: 'command',
                command: `node ${JSON.stringify(guardScript)} PreToolUse --harness=antigravity`,
              },
            ],
          },
        ],
        Stop: [
          {
            type: 'command',
            command: `node ${JSON.stringify(stopScript)} Stop --harness=antigravity`,
          },
        ],
      },
    }, null, 2) + '\n'

    return [
      ...plugins().flatMap((p) => ls(join(p, 'skills')).filter((d) => d.isDirectory()).map((d) => [join(p, 'skills', d.name), join('skills', d.name)])),
      ...plugins().flatMap((p) => ls(join(p, '.generated', 'antigravity')).filter((f) => f.name.endsWith('.md')).flatMap((f) => {
        const name = f.name.slice(0, -3)
        return [
          [join(p, '.generated', 'antigravity', f.name), join('agents', name, 'agent.md')],
          [join(p, '.generated', 'antigravity', f.name), join('agents', f.name)],
        ]
      })),
      [null, 'hooks.json', agyHooks],
    ]
  }
  throw new Error(`unknown harness ${harness}: codex, opencode or antigravity`)
}

// opencode lists TUI plugins in tui.json, which may hold the user's own settings, so hud's entry is merged in: added,
// or pointed at this checkout, the rest left alone. A tui.json that is not plain JSON (comments), or not an object
// with a `plugin` list, is not touched.
export const TUI_PLUGIN = pathToFileURL(join(PLUGINS, 'hud', 'hooks', 'opencode-tui.mjs')).href
export function addTuiPlugin(dir) {
  const file = join(dir, 'tui.json')
  let config = {}
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return false
    }
  }
  // Valid JSON of another shape (`null`, an array, a `plugin` that is no list) takes the same by-hand path.
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.plugin !== undefined && !Array.isArray(config.plugin))) return false
  const ours = (p) => String(Array.isArray(p) ? p[0] : p).endsWith('/plugins/hud/hooks/opencode-tui.mjs')
  config.plugin = [...(config.plugin ?? []).filter((p) => !ours(p)), TUI_PLUGIN]
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
  return true
}

export function targetDir(harness, env = process.env) {
  if (harness === 'codex') return env.CODEX_HOME || join(homedir(), '.codex')
  if (harness === 'antigravity') return env.GEMINI_CONFIG_DIR || join(homedir(), '.gemini', 'config')
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

export function install(harness, dir = targetDir(harness)) {
  const record = join(dir, '.giocaizzi-harness.json')
  let before = []
  try {
    before = JSON.parse(readFileSync(record, 'utf8'))
  } catch {
    // first install
  }
  const items = plan(harness)
  const now = items.map(([, rel]) => rel)
  for (const rel of before) if (!now.includes(rel) && !rel.split(/[\\/]/).includes('..')) rmSync(join(dir, rel), { recursive: true, force: true })
  for (const [src, rel, content] of items) {
    const dest = join(dir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    rmSync(dest, { recursive: true, force: true })
    if (src) cpSync(src, dest, { recursive: true })
    else writeFileSync(dest, content)
  }
  writeFileSync(record, JSON.stringify(now, null, 2) + '\n')
  if (harness === 'opencode' && !addTuiPlugin(dir)) console.error(`${join(dir, 'tui.json')} is not a plain JSON object with a "plugin" list: add ${TUI_PLUGIN} to it by hand`)
  return now.map((rel) => relative(process.cwd(), join(dir, rel)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const harnesses = process.argv.slice(2)
  if (!harnesses.length) {
    console.error('usage: node scripts/install.mjs codex|opencode|antigravity [...]')
    process.exit(2)
  }
  for (const h of harnesses) console.log(`${h}: ${install(h).length} item(s) in ${targetDir(h)}`)
}
