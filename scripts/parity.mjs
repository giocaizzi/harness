#!/usr/bin/env node
// Parity check: every skill and agent this repo authors must reach every supported harness through the repo's own
// packaging, not just exist on disk. Each harness's delivery is read from what it actually consumes: the marketplace
// and per-harness plugin manifests (Claude Code, Copilot CLI, Codex), scripts/install.mjs's plan (Codex agents,
// opencode) and package.json's `pi` key plus the subagent tool's loader (pi). VS Code reads the Claude format, so the
// Claude delivery covers it (validate.py checks its format rules). Usage: node scripts/parity.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { plan } from './install.mjs'
import { loadAgents } from '../plugins/dev-tools/pi/subagent.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const HARNESSES = ['claude', 'copilot', 'codex', 'opencode', 'pi']

const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const dirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [])
const files = (dir, ext) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => f.slice(0, -ext.length)) : [])
const posix = (path) => path.split(sep).join('/')

// What the repo authors: skills (plugins/*/skills/*/SKILL.md) and agents (src/agents/*), each with its plugin.
export function inventory() {
  const plugins = dirs(join(repo, 'plugins'))
  const skills = plugins.flatMap((plugin) => dirs(join(repo, 'plugins', plugin, 'skills')).filter((s) => existsSync(join(repo, 'plugins', plugin, 'skills', s, 'SKILL.md'))).map((name) => ({ plugin, name })))
  const agents = dirs(join(repo, 'src', 'agents')).map((name) => {
    const yaml = readFileSync(join(repo, 'src', 'agents', name, 'agent.yaml'), 'utf8')
    // Same default as build_agents.py: the `plugin` key, else the name up to its first `-`.
    return { plugin: /^plugin:\s*["']?([\w-]+)/m.exec(yaml)?.[1] ?? name.split('-')[0], name }
  })
  return { skills, agents }
}

// What each harness receives: harness -> { skills: Set<name>, agents: Set<name> }.
export function deliveries() {
  const listed = json(join(repo, '.claude-plugin', 'marketplace.json')).plugins.map((p) => p.name).filter((p) => existsSync(join(repo, 'plugins', p)))
  const skillsOf = (plugins) => plugins.flatMap((p) => dirs(join(repo, 'plugins', p, 'skills')).filter((s) => existsSync(join(repo, 'plugins', p, 'skills', s, 'SKILL.md'))))
  const manifest = (p, path) => (existsSync(join(repo, 'plugins', p, path)) ? json(join(repo, 'plugins', p, path)) : null)
  const out = {}

  // Claude Code: marketplace plugins, skills and agents/*.md auto-discovered.
  out.claude = { skills: skillsOf(listed), agents: listed.flatMap((p) => files(join(repo, 'plugins', p, 'agents'), '.md')) }

  // Copilot CLI: its own manifest, which must point at copilot/ for the .agent.md files.
  const copilot = listed.filter((p) => manifest(p, '.github/plugin/plugin.json'))
  out.copilot = {
    skills: skillsOf(copilot),
    agents: copilot.filter((p) => manifest(p, '.github/plugin/plugin.json').agents?.includes('./copilot/')).flatMap((p) => files(join(repo, 'plugins', p, 'copilot'), '.agent.md')),
  }

  // Codex: plugins (skills) through .codex-plugin/plugin.json; agents only as the TOML install.mjs copies.
  const codexAgents = plan('codex').filter(([src, rel]) => src && posix(rel).startsWith('agents/')).map(([, rel]) => basename(rel, '.toml'))
  out.codex = { skills: skillsOf(listed.filter((p) => manifest(p, '.codex-plugin/plugin.json'))), agents: codexAgents }

  // opencode: everything comes from install.mjs, flattened into skills/<name> and agents/<name>.md.
  const opencode = plan('opencode').filter(([src]) => src).map(([, rel]) => posix(rel))
  out.opencode = {
    skills: opencode.filter((rel) => rel.startsWith('skills/')).map((rel) => rel.slice('skills/'.length)),
    agents: opencode.filter((rel) => rel.startsWith('agents/')).map((rel) => basename(rel, '.md')),
  }

  // pi: package.json `pi.skills` globs, and the agents the subagent extension loads (only if it is loaded).
  const pi = json(join(repo, 'package.json')).pi ?? {}
  const glob = (pattern) => new RegExp(`^${posix(pattern).replace(/^\.\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`)
  const piSkillDirs = (pi.skills ?? []).map(glob)
  const piPlugins = dirs(join(repo, 'plugins')).filter((p) => piSkillDirs.some((re) => re.test(`plugins/${p}/skills`)))
  const subagent = (pi.extensions ?? []).some((e) => posix(relative(repo, resolve(repo, e))) === 'plugins/dev-tools/pi/subagent.mjs')
  out.pi = { skills: skillsOf(piPlugins), agents: subagent ? loadAgents(join(repo, 'plugins')).map((a) => a.name) : [] }

  for (const h of Object.keys(out)) out[h] = { skills: new Set(out[h].skills), agents: new Set(out[h].agents) }
  return out
}

// Every skill or agent a harness does not receive, and skill names that clash once opencode and pi flatten them.
export function gaps({ skills, agents }, delivered) {
  const found = []
  const seen = new Map()
  for (const s of skills) {
    if (seen.has(s.name)) found.push(`skill ${s.name}: in both ${seen.get(s.name)} and ${s.plugin}; opencode and pi install skills by name, so one would shadow the other`)
    seen.set(s.name, s.plugin)
  }
  for (const h of HARNESSES) {
    const d = delivered[h] ?? { skills: new Set(), agents: new Set() }
    for (const s of skills) if (!d.skills.has(s.name)) found.push(`skill ${s.plugin}:${s.name}: not delivered to ${h}`)
    for (const a of agents) if (!d.agents.has(a.name)) found.push(`agent ${a.plugin}:${a.name}: not delivered to ${h}`)
  }
  return found
}

// The tier each harness's definition of an agent sets: Claude `model` and `effort`, Codex `model` and
// `model_reasoning_effort`, a Copilot or opencode `model`. pi has no per-agent settings (session model).
export function tiers({ agents }) {
  const field = (path, key) => (existsSync(path) ? new RegExp(`^${key}\\s*[:=]\\s*"?([^"\\r\\n]*)"?\\s*$`, 'm').exec(readFileSync(path, 'utf8'))?.[1] : undefined)
  return agents.map(({ plugin, name }) => {
    const dir = join(repo, 'plugins', plugin)
    return {
      plugin,
      name,
      claude: { model: field(join(dir, 'agents', `${name}.md`), 'model'), effort: field(join(dir, 'agents', `${name}.md`), 'effort') },
      codex: { model: field(join(dir, 'codex', `${name}.toml`), 'model'), effort: field(join(dir, 'codex', `${name}.toml`), 'model_reasoning_effort') },
      copilot: { model: field(join(dir, 'copilot', `${name}.agent.md`), 'model') },
      opencode: { model: field(join(dir, 'opencode', `${name}.md`), 'model') },
    }
  })
}

// One agent, one tier everywhere. Claude names the tier with its model; the other harnesses take the session's
// model (the driver tier by default, user settings per agent), so a model pinned in their files would drift from
// it. Effort is per agent in Claude and Codex only, and must agree.
export function tierGaps(defs) {
  const found = []
  for (const d of defs) {
    for (const h of ['codex', 'copilot', 'opencode']) if (d[h].model) found.push(`agent ${d.plugin}:${d.name}: ${h} pins model ${d[h].model}; leave it to the session so the tier matches Claude's ${d.claude.model ?? 'default'}`)
    if (d.claude.effort !== d.codex.effort) found.push(`agent ${d.plugin}:${d.name}: effort ${d.claude.effort ?? 'unset'} in Claude but ${d.codex.effort ?? 'unset'} in Codex`)
  }
  return found
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const inv = inventory()
  const found = [...gaps(inv, deliveries()), ...tierGaps(tiers(inv))]
  for (const g of found) console.error(g)
  if (found.length) process.exit(1)
  console.log(`${inv.skills.length} skills and ${inv.agents.length} agents reach ${HARNESSES.join(', ')}, each agent at one tier`)
}
