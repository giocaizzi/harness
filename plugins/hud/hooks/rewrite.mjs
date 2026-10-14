// Reply rewrites: one pipeline over the agent's reply that makes it quicker to scan, shared by the Claude mod (display
// only, in colour through markup.mjs) and pi (message_end, no colour). Each transform is a setting (DEFAULTS, the
// plugin's userConfig), leaves code spans, fenced code and existing links alone (but secret masking, which reaches
// everywhere), and asks the world only through `facts`: cached lookups that answer undefined until known, so a
// rewrite never waits; the caller settles them and draws again.
import { KIND, target } from './links.mjs'
import { ICON } from './weather.mjs'
import { escapeMd as esc, mark } from './markup.mjs'

// The settings and their defaults, as plugin.json's userConfig declares them. A feature is `on` (the global glyph and
// colour settings apply), `off`, `no-glyph`, `no-colour` or `plain` (neither).
export const FEATURES = ['replySecrets', 'replyUrls', 'replyRefs', 'replyState', 'replyPaths', 'replyFileLinks', 'replyCommits', 'replyTimes', 'replyStatus']
export const DEFAULTS = { glyphs: true, colour: true, ...Object.fromEntries(FEATURES.map((f) => [f, 'on'])), editor: 'vscode', editorUrl: '', timeFormat: 'both' }

// Per feature { glyph, colour }, or null when off. env: NO_COLOR (any non-empty value) turns glyphs and colour off,
// as it does for the reply links; canColour: the harness draws colour at all (Claude Code yes, pi no).
export function settings(options = {}, env = {}, canColour = true) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && v !== null)) }
  const plain = !!env.NO_COLOR
  const f = {}
  for (const k of FEATURES) {
    const mode = o[k] === true ? 'on' : o[k] === false ? 'off' : o[k]
    f[k] = mode === 'off' ? null : { glyph: !plain && o.glyphs !== false && mode !== 'no-glyph' && mode !== 'plain', colour: canColour && !plain && o.colour !== false && mode !== 'no-colour' && mode !== 'plain' }
  }
  return { ...o, f }
}

// Nerd Font glyphs, each drawn followed by a space (weather.mjs's rule).
export const GLYPH = {
  dir: '', // nf-fa-folder
  file: '', // nf-fa-file
  editor: '', // nf-oct-code
  commit: '', // nf-oct-git_commit
  lock: '', // nf-fa-lock
  clock: '', // nf-fa-clock_o
  github: '', // nf-fa-github
  gitlab: '', // nf-fa-gitlab
  azure: '', // nf-cod-azure_devops
  globe: '', // nf-fa-globe
}
// A file-type icon by extension (nf-seti, nf-dev), the plain file icon for any other.
const EXT = { ts: '', tsx: '', js: '', mjs: '', cjs: '', jsx: '', py: '', md: '', json: '', sh: '', bash: '', zsh: '', ps1: '', go: '', rs: '', rb: '', java: '', html: '', css: '', yml: '', yaml: '', toml: '', sql: '', lock: '' }
export const fileGlyph = (name, kind) => (kind === 'dir' ? GLYPH.dir : (EXT[/\.([^.]+)$/.exec(name)?.[1]?.toLowerCase()] ?? GLYPH.file))

// State glyphs as GitHub draws them: open green, merged purple, closed red, draft grey.
export const STATE = {
  issue: { open: '', closed: '' }, // nf-oct-issue_opened, issue_closed
  pr: { open: ICON.pr, merged: ICON.merged, closed: '', draft: '' }, // git_pull_request(_closed, _draft), git_merge
  workitem: { open: KIND.workitem.icon, closed: '' },
}

// --- the walk: fences and protected spans ----------------------------------------------------------------------

const FENCE = /^ {0,3}(```|~~~)/
// Spans no transform rewrites: code spans, markdown links (labels may hold escaped brackets), autolinks, bare URLs
// and spans another transform marked.
const PROTECT = /(`+)[^`]*?\1|\[(?:\\.|[^\]\\\n])*\]\([^)\n]*\)|<[a-z][\w+.-]*:[^>\n]*>|\b[a-z][\w+.-]*:\/\/[^\s)>]+|﷐[^﷒]*﷒/g

// A table already drawn in characters (`+---+`, `┌──┬──┐`, `│ a │`): its columns are padded to the text as written.
const BORDER = /^\s*[+┌├└╭╰┏┣┗╔╠╚╒╞╘][-─━═=+┬┼┴┐┤┘╮╯┓┫┛╗╣╝╤╪╧┳╋┻╦╬╩ ]*$/
const BOXED = /^\s*[│┃║]/
// The lines left as written: fenced code (also an unclosed fence, while a reply streams in) and each paragraph
// holding a drawn table, whose columns a rewrite of another width would shift.
export function kept(text) {
  const all = text.split('\n')
  const keep = all.map(() => false)
  let fence = null
  let start = 0
  let drawn = false
  const end = (i) => {
    if (drawn) keep.fill(true, start, i)
    start = i + 1
    drawn = false
  }
  all.forEach((l, i) => {
    const f = FENCE.exec(l)?.[1]
    if (fence || f) {
      if (fence && f === fence) fence = null
      else if (!fence) fence = f
      keep[i] = true
      end(i)
    } else if (!l.trim()) end(i)
    else if ((BORDER.test(l) && /[-─━═]{3}/.test(l)) || BOXED.test(l)) drawn = true
  })
  end(all.length)
  return all.map((l, i) => [l, keep[i]])
}

// Each line but the kept ones through fn(line).
function lines(text, fn) {
  return kept(text)
    .map(([l, keep]) => (keep ? l : fn(l)))
    .join('\n')
}

// Free text (outside fences and protected spans) through text.replace(re, fn), or protected spans through
// span(s) when given.
export function pass(text, re, fn, span) {
  return lines(text, (line) => {
    let out = ''
    let at = 0
    for (const m of line.matchAll(PROTECT)) {
      out += line.slice(at, m.index).replace(re, fn) + (span ? span(m[0]) : m[0])
      at = m.index + m[0].length
    }
    return out + line.slice(at).replace(re, fn)
  })
}

const link = (label, url) => `[${label}](${url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})`
const glyphed = (g, ft, label) => (ft.glyph ? `${g} ${label}` : label)

// --- secrets ---------------------------------------------------------------------------------------------------

// Tokens by their prefix, kept; the rest is masked. Each needs a digit so a long hyphenated word is no key.
const SECRET = new RegExp(
  [
    '\\b(gh[pousr]_)[A-Za-z0-9]{20,}',
    '\\b(github_pat_)\\w{20,}',
    '\\b(sk-ant-)(?=[\\w-]*\\d)[\\w-]{16,}',
    '\\b(sk-(?:proj-)?)(?=[\\w-]*\\d)[\\w-]{20,}',
    '\\b(A(?:KIA|SIA))[0-9A-Z]{16}\\b',
    '\\b(xox[abprse]-)[\\w-]{10,}',
    '\\b(Bearer\\s+)(?=[\\w.~+/=-]*\\d)[\\w.~+/=-]{16,}',
  ].join('|'),
  'g',
)
const KEY_BLOCK = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g
const MASK = '••••••••'

function secrets(text, ft) {
  const prefix = (g) => g.find((x) => x !== undefined)
  // Free text: a lock glyph, the prefix, the mask dimmed. Then everywhere else (code, URLs) plainly.
  const styled = pass(text, SECRET, (_all, ...g) => mark('secret', glyphed(GLYPH.lock, ft, prefix(g)), ft.colour) + mark('dim', MASK, ft.colour))
  return styled.replace(SECRET, (_all, ...g) => prefix(g) + MASK).replace(KEY_BLOCK, `$1\n${MASK}\n$2`)
}

// --- long URLs --------------------------------------------------------------------------------------------------

const forgeOfHost = (host) => (/github/i.test(host) ? 'github' : /gitlab/i.test(host) ? 'gitlab' : /dev\.azure\.com|visualstudio\.com/i.test(host) ? 'azure' : null)

// A URL's short label and its kind (issue, pr, workitem, commit, file, page), or null to leave it as written.
// here: the session's repository (links.mjs repoOf), whose own references drop the repository name.
export function shortUrl(href, here) {
  let u
  try {
    u = new URL(href)
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol)) return null
  const forge = forgeOfHost(u.host)
  const p = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const line = /^#L(\d+)/.exec(u.hash)?.[1]
  const at = (path, sha) => `${path.split('/').at(-1)}@${sha.slice(0, 7)}`
  const file = (path, rest) => `${path.split('/').at(-1)} › ${rest.join('/')}${line ? `:${line}` : ''}`
  const own = (path) => here && here.host === u.host && here.path === path
  if (forge === 'github' && p.length >= 2) {
    const repo = `${p[0]}/${p[1]}`
    const [kind, n] = [p[2], p[3]]
    if ((kind === 'issues' || kind === 'pull') && /^\d+$/.test(n ?? '')) return { label: `${own(repo) ? '' : repo}#${n}`, kind: kind === 'pull' ? 'pr' : 'issue', forge }
    if (kind === 'commit' && n) return { label: at(repo, n), kind: 'commit', forge }
    if ((kind === 'blob' || kind === 'tree') && p.length > 4) return { label: file(repo, p.slice(4)), kind: 'file', forge }
    if (p.length === 2) return { label: repo, kind: 'page', forge }
  }
  if (forge === 'gitlab') {
    const dash = p.indexOf('-')
    if (dash > 1) {
      const repo = p.slice(0, dash).join('/')
      const [kind, n] = [p[dash + 1], p[dash + 2]]
      if ((kind === 'issues' || kind === 'merge_requests') && /^\d+$/.test(n ?? '')) return { label: `${own(repo) ? '' : repo}${kind === 'issues' ? '#' : '!'}${n}`, kind: kind === 'issues' ? 'issue' : 'pr', forge }
      if (kind === 'commit' && n) return { label: at(repo, n), kind: 'commit', forge }
      if ((kind === 'blob' || kind === 'tree') && p.length > dash + 3) return { label: file(repo, p.slice(dash + 3)), kind: 'file', forge }
    }
  }
  if (forge === 'azure') {
    const git = p.indexOf('_git')
    const repo = git > 0 ? p[git + 1] : null
    if (repo && p[git + 2] === 'pullrequest' && /^\d+$/.test(p[git + 3] ?? '')) return { label: `${repo}!${p[git + 3]}`, kind: 'pr', forge }
    if (repo && p[git + 2] === 'commit' && p[git + 3]) return { label: at(repo, p[git + 3]), kind: 'commit', forge }
    if (repo && u.searchParams.get('path')) return { label: `${repo} › ${u.searchParams.get('path').replace(/^\//, '')}${u.searchParams.get('line') ? `:${u.searchParams.get('line')}` : ''}`, kind: 'file', forge }
    const wi = p.indexOf('_workitems')
    if (wi > 0 && p[wi + 1] === 'edit' && /^\d+$/.test(p[wi + 2] ?? '')) return { label: `AB#${p[wi + 2]}`, kind: 'workitem', forge }
  }
  // Any other page: the host and a shortened path, only where that is shorter than the URL.
  if (href.length <= 40) return null
  const host = u.host.replace(/^www\./, '')
  const path = p.length > 2 ? `/${p[0]}/…/${p.at(-1)}` : p.length ? `/${p.join('/')}` : ''
  return { label: `${host}${path}`, kind: 'page', forge }
}

function urls(text, ft, here) {
  const one = (href, tail = '') => {
    const s = shortUrl(href, here)
    if (!s) return null
    const g = GLYPH[s.forge] ?? GLYPH.globe
    const style = { issue: 'issue', pr: 'pr', workitem: 'workitem', commit: 'sha' }[s.kind] ?? 'host'
    return link(mark(style, glyphed(g, ft, esc(s.label)), ft.colour), href) + tail
  }
  return pass(text, /(?!)/, null, (span) => {
    // A bare URL (trailing punctuation is the sentence's), an autolink, or a link whose label is its own URL.
    let m = /^[a-z][\w+.-]*:\/\/\S+$/i.exec(span)
    if (m) {
      const [, href, tail] = /^(.*?)([.,;:!?]*)$/.exec(span)
      return one(href, tail) ?? span
    }
    if ((m = /^<(https?:[^>]+)>$/.exec(span))) return one(m[1]) ?? span
    if ((m = /^\[(https?:[^\]]+)\]\((https?:[^)]+)\)$/.exec(span)) && m[1] === m[2]) return one(m[2]) ?? span
    return span
  })
}

// --- work-item references, with their state ---------------------------------------------------------------------

const REF = /(?<![\w&/#!@.\\-])(?:([\w-]+(?:\/[\w.-]+)+)|(AB))?([#!])(\d+)(?![\w-])/g
export const refKey = (r, { repo, sigil, n }) => `${r.forge}:${r.host ?? r.org}:${repo ?? r.path ?? r.project}:${sigil}${n}`

function refs(text, ft, here, facts, st) {
  if (!here) return text
  return pass(text, REF, (all, repo, ab, sigil, n) => {
    if (ab && sigil !== '#') return all
    const ref = { repo, sigil: ab ? 'AB#' : sigil, n }
    const t = target(here, ref)
    if (!t) return all
    // A GitHub #N may be an issue or a pull request: the state lookup says which.
    const s = st ? facts.state(here, ref) : undefined
    const kind = s?.kind ?? t.kind
    const icon = (s && STATE[kind]?.[s.state]) || KIND[kind].icon
    const colour = s ? st.colour : ft.colour
    return link(mark(s ? s.state : kind, glyphed(icon, ft, esc(all)), colour), t.url)
  })
}

// --- paths and file:line ----------------------------------------------------------------------------------------

// An absolute path (POSIX, `~/`, or a Windows drive) of two segments or more, or a relative file with an extension
// and a line; either with `:line[:col]`.
const PATH = /(?<![\w.~/\\:@$-])(~[/\\](?:[\w.@+-]+[/\\])*[\w.@+-]+|(?:[A-Za-z]:)?[/\\](?:[\w.@+-]+[/\\])+[\w.@+-]*|(?:\.{1,2}\/)?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z]\w*(?=:\d))(?::(\d+)(?::(\d+))?)?(?![\w/\\])/g

const slash = (p) => p.replace(/\\/g, '/')
const parent = (p) => p.slice(0, p.lastIndexOf('/')) || (p.startsWith('/') ? '/' : p)
const isAbs = (p) => /^(\/|[A-Za-z]:\/)/.test(p)
const base = (p) => p.slice(p.lastIndexOf('/') + 1)

// A path made absolute against the session's directory and home, `.` and `..` folded; `/` separators.
export function resolvePath(p, { cwd, home }) {
  let s = slash(p)
  if (s.startsWith('~/')) s = `${slash(home ?? '')}${s.slice(1)}`
  else if (!isAbs(s)) s = `${slash(cwd ?? '')}/${s}`
  const drive = /^[A-Za-z]:/.exec(s)?.[0] ?? ''
  const out = []
  for (const seg of s.slice(drive.length).split('/')) {
    if (seg === '..') out.pop()
    else if (seg && seg !== '.') out.push(seg)
  }
  return `${drive}/${out.join('/')}`
}

// The repository root above a path from the cached `.git` stats: a root, null for none, undefined while unknown.
// Every ancestor is asked at once, so one round of lookups settles it.
function rootOf(abs, facts) {
  const dirs = []
  for (let d = parent(abs); ; d = parent(d)) {
    dirs.push(d)
    if (parent(d) === d || /^[A-Za-z]:$/.test(d)) break
  }
  const dot = dirs.map((d) => facts.stat(`${d === '/' ? '' : d}/.git`))
  for (let i = 0; i < dirs.length; i++) {
    if (dot[i] === undefined) return undefined
    if (dot[i]) return dirs[i]
  }
  return null
}

// How an absolute path is shown: under a repository `<repo> › <rel>` (a worktree in `.claude/worktrees/<x>` as
// `<repo>[<x>]`), under home `~/<rel>`, else as written. { prefix, name } for the label; null while unknown.
export function shortPath(abs, root, home) {
  if (root) {
    const wt = /^(.*)\/\.claude\/worktrees\/([^/]+)$/.exec(root)
    const repo = wt ? `${base(wt[1])}[${wt[2]}]` : base(root)
    const rel = abs.slice(root.length + 1)
    return { prefix: `${repo} › ${rel.includes('/') ? `${parent(rel)}/` : ''}`, name: base(rel) }
  }
  const h = slash(home ?? '').replace(/\/$/, '')
  const shown = h && abs.toLowerCase().startsWith(`${h.toLowerCase()}/`) ? `~${abs.slice(h.length)}` : abs
  return { prefix: shown.includes('/') ? shown.slice(0, shown.lastIndexOf('/') + 1) : '', name: base(shown) }
}

// The editor URL for a file and line: a known editor's scheme, `file://`, or a template with {path} {line} {col}.
export const EDITORS = {
  vscode: 'vscode://file{path}:{line}:{col}',
  cursor: 'cursor://file{path}:{line}:{col}',
  zed: 'zed://file{path}:{line}:{col}',
  idea: 'idea://open?file={path}&line={line}&column={col}',
  sublime: 'subl://open?url=file://{path}&line={line}&column={col}',
  file: 'file://{path}',
}
export function editorUrl(abs, line, col, { editor = 'vscode', editorUrl: custom = '' } = {}) {
  const tpl = editor === 'custom' && custom ? custom : (EDITORS[editor] ?? EDITORS.vscode)
  const path = encodeURI(abs.startsWith('/') ? abs : `/${abs}`)
  return tpl.replaceAll('{path}', path).replaceAll('{line}', String(line ?? 1)).replaceAll('{col}', String(col ?? 1))
}

function paths(text, o, facts, ctx) {
  const [fp, fl] = [o.f.replyPaths, o.f.replyFileLinks]
  if (!fp && !fl) return text
  const ft = { glyph: !!(fp?.glyph || fl?.glyph), colour: !!(fp?.colour || fl?.colour) }
  return pass(text, PATH, (all, raw, line, col) => {
    // A sentence's full stop is not the path's.
    const dots = /\.+$/.exec(raw)?.[0] ?? ''
    const p = raw.slice(0, raw.length - dots.length)
    if (!p || (dots && line)) return all
    const tail = all.slice(raw.length) // the :line[:col]
    const abs = resolvePath(p, ctx)
    const absolute = isAbs(slash(p)) || p.startsWith('~')
    // Both asked before either answer is looked at: one round of lookups.
    const kind = facts.stat(abs)
    const root = fp && absolute ? rootOf(abs, facts) : null
    if (!kind || root === undefined) return all // missing, or not known yet
    const shown = fp && absolute ? shortPath(abs, root, ctx.home) : { prefix: p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1), name: base(slash(p)) }
    const g = line ? GLYPH.editor : fileGlyph(shown.name, kind)
    const label =
      (ft.glyph ? `${g} ` : '') +
      mark('dim', esc(shown.prefix), ft.colour) +
      mark('name', esc(shown.name), ft.colour) +
      (tail ? mark('line', tail, ft.colour) : '')
    if (!fl) return label + dots
    const url = kind === 'dir' ? `file://${encodeURI(abs.startsWith('/') ? abs : `/${abs}`)}` : editorUrl(abs, line, col, o)
    return link(label, url) + dots
  })
}

// --- commit SHAs ------------------------------------------------------------------------------------------------

// 7 to 40 hex digits holding a digit and a letter, as a word of its own (not `#1a2b3c4`, a UUID part or a path).
const SHA = /(?<![\w#/@.:-])(?=[0-9a-f]{0,39}[a-f])(?=[0-9a-f]{0,39}\d)[0-9a-f]{7,40}(?![\w-])/g

export function commitUrl(r, sha) {
  if (!r) return null
  if (r.forge === 'github') return `https://${r.host}/${r.path}/commit/${sha}`
  if (r.forge === 'gitlab') return `https://${r.host}/${r.path}/-/commit/${sha}`
  return `https://dev.azure.com/${r.org}/${r.project}/_git/${r.repo}/commit/${sha}`
}

function commits(text, ft, here, facts) {
  return pass(text, SHA, (sha) => {
    if (facts.commit(sha) !== true) return sha
    const label = mark('sha', glyphed(GLYPH.commit, ft, sha), ft.colour)
    const url = commitUrl(here, sha)
    return url ? link(label, url) : label
  })
}

// --- timestamps -------------------------------------------------------------------------------------------------

const ISO = /(?<![\w:-])(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?(?![\w:])/g
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// How long ago (or until) a moment: 45s ago, 5m ago, 5h ago, 3d ago, in 2h.
export function ago(ms, now) {
  const d = Math.round((now - ms) / 1000)
  const a = Math.abs(d)
  const v = a < 60 ? `${a}s` : a < 3600 ? `${Math.floor(a / 60)}m` : a < 86400 ? `${Math.floor(a / 3600)}h` : a < 86400 * 60 ? `${Math.floor(a / 86400)}d` : a < 86400 * 730 ? `${Math.floor(a / (86400 * 30))}mo` : `${Math.floor(a / (86400 * 365))}y`
  return d >= 0 ? `${v} ago` : `in ${v}`
}

// A local `13 Oct 20:56` (the year too when not this one).
export function local(ms, now) {
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} ${hm}`
}

function times(text, ft, fmt, now) {
  return pass(text, ISO, (all, y, mo, d, h, mi, s, zone) => {
    // Without a zone the moment is local, as Date reads it.
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${zone ? (zone === 'Z' ? 'Z' : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : ''}`
    const ms = Date.parse(iso)
    if (Number.isNaN(ms) || +mo > 12 || +d > 31) return all
    const abs = local(ms, now)
    const rel = ago(ms, now)
    const head = fmt === 'relative' ? rel : abs
    const label = (ft.glyph ? `${GLYPH.clock} ` : '') + mark('time', head, ft.colour) + (fmt === 'both' ? ` ${mark('dim', `(${rel})`, ft.colour)}` : '')
    return label
  })
}

// --- pass / fail ------------------------------------------------------------------------------------------------

const OK = /^(?:pass(?:ed|ing)?|ok|success(?:ful)?|succeeded|green|✓|✔|✅|✔️)$/i
const BAD = /^(?:fail(?:ed|ing|ure)?|errou?red|error|broken|red|✗|✘|❌)$/i
const SKIP = /^(?:skip(?:ped)?|pending|⊘|⏭|⏭️)$/i
const STATUS_WORD = '(?:pass(?:ed|ing)?|ok|success(?:ful)?|succeeded|green|fail(?:ed|ing|ure)?|errored|error|broken|red|skip(?:ped)?|pending|✓|✔️?|✅|✗|✘|❌|⊘|⏭️?)'
const SYMBOL = { ok: '✓', bad: '✗', skip: '⊘' }

const statusOf = (w) => (OK.test(w) ? 'ok' : BAD.test(w) ? 'bad' : SKIP.test(w) ? 'skip' : null)

// A status word drawn with its symbol and colour; a symbol alone becomes the canonical one.
function badge(word, ft) {
  const s = statusOf(word)
  const symbolOnly = /^[^\w]+$/.test(word)
  const text = symbolOnly ? SYMBOL[s] : ft.glyph ? `${SYMBOL[s]} ${word}` : word
  return mark(s, text, ft.colour)
}

// The counts of a table or list: `12 ✓ · 1 ✗ · 2 ⊘`, zero counts left out.
export const summary = (n, ft) =>
  ['ok', 'bad', 'skip']
    .filter((k) => n[k])
    .map((k) => mark(k, `${n[k]} ${SYMBOL[k]}`, ft.colour))
    .join(' · ')

const ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/
// An item's status: as its last word after a separator (`lint: passed`, `build — failed`, `e2e (skipped)`), or as its
// first when that is a symbol or upper case (`✓ lint`, `PASS lint`), or a `name: status` line. Prose never: "the
// tests passed" has no separator.
const TAIL = new RegExp(`^(.*?\\S)(\\s*(?::|—|–|\\s-|→|->|=|\\.\\.\\.|…)\\s*|\\s+\\()(\\*{0,2})(${STATUS_WORD})(\\*{0,2})(\\)?)(\\s*\\.?)$`, 'iu')
const HEAD = new RegExp(`^(\\*{0,2})(✓|✔️?|✅|✗|✘|❌|⊘|⏭️?|PASS(?:ED)?|FAIL(?:ED)?|OK|SKIP(?:PED)?|ERROR)(\\*{0,2})(:?\\s+)(\\S.*)$`, 'u')
const NAMED = /^(\s*[^\s:|>#-][^:|]{0,60}:\s*)(\S+)(\s*\.?)$/

function statusText(s, ft, count) {
  let m = TAIL.exec(s)
  if (m && (!m[6] || m[2].includes('('))) {
    count(statusOf(m[4]))
    return `${m[1]}${m[2]}${m[3]}${badge(m[4], ft)}${m[5]}${m[6]}${m[7]}`
  }
  m = HEAD.exec(s)
  if (m) {
    count(statusOf(m[2]))
    return `${m[1]}${badge(m[2], ft)}${m[3]}${m[4]}${m[5]}`
  }
  return null
}

function status(text, ft) {
  // A table cell or list item at a time; a table or list of two statuses or more gets its counts after it.
  const out = []
  let n = null
  const close = () => {
    if (n && n.ok + n.bad + n.skip >= 2) out.push('', summary(n, ft))
    n = null
  }
  let kind = null
  for (const [line, keep] of kept(text)) {
    if (keep) {
      close()
      kind = null
      out.push(line)
      continue
    }
    const k = /^\s*\|/.test(line) ? 'table' : ITEM.test(line) ? 'list' : null
    if (k !== kind) {
      close()
      kind = k
    }
    if (k) n ??= { ok: 0, bad: 0, skip: 0 }
    const count = (s) => s && n && n[s]++
    if (k === 'table') {
      out.push(
        line.replace(/(?<=\|)([^|]*)(?=\|)/g, (cell) => {
          const w = cell.trim().replace(/^\*\*(.*)\*\*$/, '$1')
          const s = statusOf(w)
          if (!s) return cell
          count(s)
          return cell.replace(w, badge(w, ft))
        }),
      )
      continue
    }
    if (k === 'list') {
      const [, lead, body] = ITEM.exec(line)
      const t = statusText(body, ft, count)
      out.push(t ? lead + t : line)
      continue
    }
    const m = NAMED.exec(line)
    out.push(m && statusOf(m[2]) && !/`/.test(line) ? `${m[1]}${badge(m[2], ft)}${m[3]}` : line)
  }
  close()
  return out.join('\n')
}

// --- facts --------------------------------------------------------------------------------------------------------

// Cached answers to stat, commit and state, each looked up once per session through the injected async readers;
// a getter answers undefined until its answer is in. settle(ms) waits (at most ms) for those asked so far and
// resolves true when one came in.
export function createFacts({ stat = async () => null, commit = async () => false, state = async () => null } = {}) {
  const known = new Map()
  const pending = new Map()
  const ask = (key, fn) => {
    if (known.has(key)) return known.get(key)
    if (!pending.has(key))
      pending.set(
        key,
        Promise.resolve()
          .then(fn)
          .catch(() => null)
          .then((v) => {
            known.set(key, v ?? null)
            pending.delete(key)
          }),
      )
    return undefined
  }
  return {
    stat: (p) => ask(`stat:${p}`, () => stat(p)),
    commit: (sha) => ask(`commit:${sha}`, () => commit(sha)),
    state: (r, ref) => ask(`state:${refKey(r, ref)}`, () => state(r, ref)),
    get pending() {
      return pending.size
    },
    async settle(ms = 2000) {
      if (!pending.size) return false
      let timer
      const all = Promise.all([...pending.values()])
      await Promise.race([all, new Promise((r) => (timer = setTimeout(r, ms)))])
      clearTimeout(timer)
      return true
    },
  }
}

// The state of a work item from the forge's CLI, through run(argv) -> stdout | null: { kind, state } where kind is
// issue, pr or workitem and state open, merged, closed or draft; null when the CLI cannot say.
export async function fetchState(run, r, { repo, sigil, n }) {
  const json = async (argv) => {
    try {
      const out = await run(argv)
      return out ? JSON.parse(out) : null
    } catch {
      return null
    }
  }
  if (r.forge === 'github') {
    const j = await json(['gh', 'api', '--hostname', r.host, `repos/${repo ?? r.path}/issues/${n}`])
    if (!j?.state) return null
    if (!j.pull_request) return { kind: 'issue', state: j.state === 'closed' ? 'closed' : 'open' }
    return { kind: 'pr', state: j.pull_request.merged_at ? 'merged' : j.state === 'closed' ? 'closed' : j.draft ? 'draft' : 'open' }
  }
  if (r.forge === 'gitlab') {
    const mr = sigil === '!'
    const j = await json(['glab', 'api', '--hostname', r.host, `projects/${encodeURIComponent(repo ?? r.path)}/${mr ? 'merge_requests' : 'issues'}/${n}`])
    if (!j?.state) return null
    const state = j.state === 'merged' ? 'merged' : j.state === 'closed' ? 'closed' : j.draft || j.work_in_progress ? 'draft' : 'open'
    return { kind: mr ? 'pr' : 'issue', state }
  }
  const org = `https://dev.azure.com/${r.org}`
  if (sigil === '!') {
    const j = await json(['az', 'repos', 'pr', 'show', '--id', String(n), '--org', org, '--output', 'json'])
    if (!j?.status) return null
    return { kind: 'pr', state: j.status === 'completed' ? 'merged' : j.status === 'abandoned' ? 'closed' : j.isDraft ? 'draft' : 'open' }
  }
  const j = await json(['az', 'boards', 'work-item', 'show', '--id', String(n), '--org', org, '--output', 'json'])
  const s = j?.fields?.['System.State']
  return s ? { kind: 'workitem', state: /closed|done|removed|resolved|completed/i.test(s) ? 'closed' : 'open' } : null
}

// --- the pipeline ---------------------------------------------------------------------------------------------------

// The reply rewritten by every feature that is on. o: settings(); ctx: { repo (links.mjs repoOf, or null), cwd,
// home, now (epoch ms) }; facts: createFacts(). Marked spans (markup.mjs) only where a feature's colour is on.
export function rewrite(text, o, ctx, facts) {
  if (!text) return text
  const f = o.f
  let t = text
  if (f.replySecrets) t = secrets(t, f.replySecrets)
  if (f.replyUrls) t = urls(t, f.replyUrls, ctx.repo)
  if (f.replyRefs) t = refs(t, f.replyRefs, ctx.repo, facts, f.replyState)
  if (f.replyPaths || f.replyFileLinks) t = paths(t, o, facts, ctx)
  if (f.replyCommits) t = commits(t, f.replyCommits, ctx.repo, facts)
  if (f.replyTimes) t = times(t, f.replyTimes, o.timeFormat, ctx.now ?? Date.now())
  if (f.replyStatus) t = status(t, f.replyStatus)
  return t
}
