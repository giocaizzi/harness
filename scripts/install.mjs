#!/usr/bin/env node
// Install what a harness cannot take from the marketplace, from this checkout, on every OS (plain copies, no
// symlinks). Re-run after `git pull`; files a previous run installed and this one no longer ships are removed.
//   node scripts/install.mjs codex      agents (codex/*.toml) -> $CODEX_HOME/agents (default ~/.codex)
//   node scripts/install.mjs opencode   skills, agents and the guard and sounds plugins -> $XDG_CONFIG_HOME/opencode (default ~/.config)
// Claude Code, Copilot CLI and VS Code install from the marketplace, Codex its plugins too, pi with
// `pi install git:github.com/giocaizzi/harness`: see docs/install.md.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS = join(REPO, 'plugins')
const plugins = () => readdirSync(PLUGINS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(PLUGINS, d.name))
const ls = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])

// [source, target-relative path] pairs, or [null, path, content] for a generated file.
export function plan(harness) {
  if (harness === 'codex') return plugins().flatMap((p) => ls(join(p, 'codex')).filter((f) => f.name.endsWith('.toml')).map((f) => [join(p, 'codex', f.name), join('agents', f.name)]))
  if (harness === 'opencode') {
    const stub = (plugin) => `// Installed by giocaizzi/harness scripts/install.mjs; re-run it after a pull.\nexport * from ${JSON.stringify(pathToFileURL(join(PLUGINS, plugin, 'hooks', 'opencode.mjs')).href)}\n`
    return [
      ...plugins().flatMap((p) => ls(join(p, 'skills')).filter((d) => d.isDirectory()).map((d) => [join(p, 'skills', d.name), join('skills', d.name)])),
      ...plugins().flatMap((p) => ls(join(p, 'opencode')).filter((f) => f.name.endsWith('.md')).map((f) => [join(p, 'opencode', f.name), join('agents', f.name)])),
      ...['guard', 'sounds'].map((plugin) => [null, join('plugins', `giocaizzi-${plugin}.js`), stub(plugin)]),
    ]
  }
  throw new Error(`unknown harness ${harness}: codex or opencode`)
}

export function targetDir(harness, env = process.env) {
  if (harness === 'codex') return env.CODEX_HOME || join(homedir(), '.codex')
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
  return now.map((rel) => relative(process.cwd(), join(dir, rel)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const harnesses = process.argv.slice(2)
  if (!harnesses.length) {
    console.error('usage: node scripts/install.mjs codex|opencode [...]')
    process.exit(2)
  }
  for (const h of harnesses) console.log(`${h}: ${install(h).length} item(s) in ${targetDir(h)}`)
}
