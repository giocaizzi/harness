#!/usr/bin/env node
// memory-lint.mjs [--repo <path>] [<memory-dir>...]   report-only lint of Claude Code auto-memory
//
// Default dirs: ~/.claude/projects/*/memory (CLAUDE_CONFIG_DIR respected). Prints one finding per
// line as "<dir>/<file>: <what>" and always exits 0 (2 on usage errors): fixing is a judgement call.
// Checks: frontmatter has name, description and a type (user|feedback|project|reference) and
// parses (an unquoted description with ": " breaks YAML); MEMORY.md exists, links only to existing
// files, lists every file, stays under 200 lines / 25000 bytes; [[links]] and relative .md links
// resolve; files over 4 KB; append-style wording ("Update:", "superseded", "no longer");
// with --repo, backticked repo paths that no longer exist. Contradictions with skills or
// instructions need reading, not a script: see the memory-hygiene reference.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const TYPES = ['user', 'feedback', 'project', 'reference']
const APPEND = /\b(update[ds]?:|superseded|no longer|previously|was changed)/i
const INDEX_MAX_LINES = 200
const INDEX_MAX_BYTES = 25000
const FILE_MAX_BYTES = 4000

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  const fm = { body: text.slice(m[0].length), raw: m[1] }
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z_]+):\s*(.*)$/)
    if (kv && fm[kv[1]] === undefined) fm[kv[1]] = kv[2]
  }
  return fm
}

export function lintDir(dir, { repo } = {}) {
  const out = []
  if (!readdirSync(dir).length) return out
  const say = (file, what) => out.push(`${dir}/${file}: ${what}`)
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
  const index = existsSync(join(dir, 'MEMORY.md')) ? readFileSync(join(dir, 'MEMORY.md'), 'utf8') : null
  if (index === null) say('MEMORY.md', 'missing')
  else {
    const lines = index.split('\n').length
    if (lines > INDEX_MAX_LINES) say('MEMORY.md', `${lines} lines (limit ${INDEX_MAX_LINES}): the rest is not loaded`)
    if (Buffer.byteLength(index) > INDEX_MAX_BYTES) say('MEMORY.md', `over ${INDEX_MAX_BYTES} bytes: the rest is not loaded`)
    const linked = [...index.matchAll(/\]\(([^)#]+\.md)\)/g)].map((m) => m[1])
    for (const l of linked) if (!existsSync(join(dir, l))) say('MEMORY.md', `links to missing ${l}`)
    for (const f of files) if (!linked.includes(f)) say(f, 'not in MEMORY.md')
  }
  const slugs = new Set(files.map((f) => f.slice(0, -3).replaceAll('_', '-').toLowerCase()))
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8')
    const fm = frontmatter(text)
    if (!fm) say(f, 'no frontmatter')
    else {
      if (!fm.name) say(f, 'frontmatter: no name')
      if (!fm.description) say(f, 'frontmatter: no description')
      else if (!/^["'>|]/.test(fm.description) && /: | #/.test(fm.description)) say(f, 'frontmatter: description needs quotes (": " breaks YAML)')
      if (!TYPES.includes((fm.type ?? '').replace(/["']/g, ''))) say(f, `frontmatter: type is ${fm.type ?? 'missing'}, want one of ${TYPES.join('|')}`)
    }
    const body = fm ? fm.body : text
    for (const m of body.matchAll(/\[\[([\w-]+)\]\]/g)) if (!slugs.has(m[1].replaceAll('_', '-').toLowerCase())) say(f, `dangling link [[${m[1]}]]`)
    for (const m of body.matchAll(/\]\(([^)#:]+\.md)\)/g)) if (!existsSync(join(dir, m[1]))) say(f, `dangling link ${m[1]}`)
    if (Buffer.byteLength(text) > FILE_MAX_BYTES) say(f, `${Buffer.byteLength(text)} bytes: likely an accreted log, split or cut it`)
    const w = body.match(APPEND)
    if (w) say(f, `append-style wording "${w[0]}": state the current fact instead`)
    if (repo) {
      for (const m of body.matchAll(/`((?:[\w.-]+\/)+[\w.-]+\.\w+)`/g)) if (!existsSync(join(repo, m[1]))) say(f, `path not in ${repo}: ${m[1]}`)
    }
  }
  return out
}

export function defaultDirs(env = process.env) {
  const root = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  if (!existsSync(root)) return []
  return readdirSync(root).map((p) => join(root, p, 'memory')).filter((d) => existsSync(d))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  let repo
  const dirs = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo') repo = args[++i]
    else if (args[i].startsWith('-')) { console.error('usage: memory-lint.mjs [--repo <path>] [<memory-dir>...]'); process.exit(2) }
    else dirs.push(args[i])
  }
  const targets = dirs.length ? dirs : defaultDirs()
  const findings = targets.flatMap((d) => lintDir(d, { repo }))
  console.log(findings.length ? findings.join('\n') : `memory-lint: ${targets.length} dir(s), no findings`)
}
