// Styled spans inside a reply's markdown, and the Claude Code tree that draws them in colour. Markdown carries no
// colour and Claude Code refuses escape sequences in a rewritten reply, so a transform marks a span
// (`﷐style﷑text﷒`, Unicode noncharacters, never in a model's text) and `toTree` draws each line holding
// one as its own Text row, the rest as the engine's Markdown. Pure: the element constructors come in.

const [OPEN, SEP, CLOSE] = ['﷐', '﷑', '﷒']
export const MARK = new RegExp(`${OPEN}([^${SEP}]*)${SEP}([^${CLOSE}]*)${CLOSE}`, 'g')

// A span drawn in a style (STYLE's keys); with colour off, the text alone.
export const mark = (style, text, colour = true) => (colour && text ? `${OPEN}${style}${SEP}${text}${CLOSE}` : text)
export const unmark = (text) => text.replace(MARK, '$2')

// Theme keys where the theme has one, so a light theme stays legible; else Catppuccin Mocha, as the band.
export const STYLE = {
  dim: { dimColor: true },
  name: { bold: true },
  line: { color: '#fab387' }, // peach: a line number
  sha: { color: '#f9e2af' }, // yellow: a commit
  ok: { color: 'success' },
  bad: { color: 'error' },
  skip: { dimColor: true },
  open: { color: 'success' },
  merged: { color: 'merged' },
  closed: { color: 'error' },
  draft: { color: 'inactive' },
  issue: { color: '#a6e3a1' },
  pr: { color: '#cba6f7' },
  workitem: { color: '#89b4fa' },
  host: { color: '#89b4fa' },
  time: { color: '#94e2d5' }, // teal: a moment
  secret: { color: 'warning' },
}

// Markdown's backslash escapes, which transforms write in labels (`\[`, `\_`) and a Text row draws plain.
export const escapeMd = (s) => s.replace(/[\\`*_[\]]/g, '\\$&')
const unescape = (s) => s.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1')

// A link the Markdown element draws (only https, http and file; any other scheme is drawn as text).
const LINK = /\[((?:\\.|[^\]\\\n])*)\]\(([^)\s]*)\)/
const OTHER_SCHEME = /\]\((?!https?:|file:)[a-z][\w+.-]*:/i
const OTHER_LINK = /\[((?:\\.|[^\]\\\n])*)\]\((?!https?:|file:)[a-z][\w+.-]*:[^)\s]*\)/gi
const INLINE = new RegExp(`${MARK.source}|${LINK.source}|(\`+)([^\`]+?)\\5|\\*\\*(.+?)\\*\\*|(?<![\\w*])\\*(?![\\s*])(.+?)(?<![\\s*])\\*(?![\\w*])`, 'g')
const CODE = { color: '#b4befe' } // the theme's inline code is lavender-blue

// One markdown line's inline content as Text children: marked spans styled, links as Link, code, bold, italic.
export function inline(s, el, base = {}) {
  const out = []
  let at = 0
  for (const m of s.matchAll(INLINE)) {
    if (m.index > at) out.push(unescape(s.slice(at, m.index)))
    at = m.index + m[0].length
    const [, style, marked, label, href, , code, bold, italic] = m
    if (style !== undefined) out.push(el.Text({ ...base, ...STYLE[style], children: [unescape(marked)] }))
    else if (href !== undefined) out.push(el.Link({ href, children: inline(label, el, base) }))
    else if (code !== undefined) out.push(el.Text({ ...CODE, children: [code] }))
    else if (bold !== undefined) out.push(el.Text({ ...base, bold: true, children: inline(bold, el, base) }))
    else out.push(el.Text({ ...base, italic: true, children: inline(italic, el, base) }))
  }
  if (at < s.length) out.push(unescape(s.slice(at)))
  return out.length ? out : ['']
}

// A line of its own: a heading bold, a list item with the engine's bullet, a quote dim, the rest inline.
function row(line, el) {
  const h = /^ {0,3}#{1,6}\s+(.*)$/.exec(line)
  if (h) return el.Text({ bold: true, children: inline(h[1], el, { bold: true }) })
  const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
  if (li) return el.Text({ children: [`${li[1]}${/\d/.test(li[2]) ? li[2] : '-'} `, ...inline(li[3], el)] })
  const q = /^\s*>\s?(.*)$/.exec(line)
  if (q) return el.Text({ dimColor: true, children: ['▎ ', ...inline(q[1], el)] })
  return el.Text({ children: inline(line, el) })
}

const FENCE = /^ {0,3}(```|~~~)/
const isTable = (l) => /^\s*\|/.test(l)
// A table row without the leading pipe, whose header the separator row below makes a table.
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const startsTable = (lines, i) => isTable(lines[i]) || (/(?<!\\)\|/.test(lines[i]) && SEPARATOR.test(lines[i + 1] ?? '') && lines[i + 1].includes('|'))
const own = (l) => l.includes(OPEN) || OTHER_SCHEME.test(l)

// The reply drawn as the engine would, but each line with a marked span (or a link the Markdown element would not
// draw) as a Text row of its own; a table stays markdown, its marks dropped. null when nothing needs it: the
// caller then hands the engine the text. first: the reply's opening block, which carries the `⏺` bullet.
export function toTree(text, el, { first = false } = {}) {
  if (!text.includes(OPEN)) return null
  const lines = text.split('\n')
  const blocks = []
  let md = []
  const flush = () => {
    while (md.length && !md[0].trim()) md.shift()
    const gap = md.length && !md.at(-1).trim()
    while (md.length && !md.at(-1).trim()) md.pop()
    if (md.length) blocks.push(el.Markdown({ text: md.join('\n') }))
    if (gap) blocks.push(el.Text({ children: [' '] }))
    md = []
  }
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const f = FENCE.exec(l)?.[1]
    if (fence || f) {
      if (fence && f === fence) fence = null
      else if (!fence) fence = f
      md.push(l)
      continue
    }
    if (startsTable(lines, i)) {
      let j = i + 1
      while (j < lines.length && lines[j].trim() && /(?<!\\)\|/.test(lines[j])) j++
      // Tables stay the engine's: it measures cells in terminal columns and fits the table to the terminal, which a
      // tree of our own cannot know. So a table loses its colour, and a link the engine would not draw keeps its label.
      md.push(...lines.slice(i, j).map((t) => unmark(t).replace(OTHER_LINK, '$1')))
      i = j - 1
      continue
    }
    if (!own(l)) {
      // A blank line between two own rows is drawn as one; inside markdown the engine spaces its blocks.
      if (!l.trim() && !md.length && blocks.length) blocks.push(el.Text({ children: [' '] }))
      else md.push(l)
      continue
    }
    flush()
    blocks.push(row(l, el))
  }
  flush()
  // The engine's bullet and its two-column gutter, which a tree of our own replaces.
  return el.Box({
    flexDirection: 'row',
    children: [el.Text({ children: [first ? '⏺ ' : '  '] }), el.Box({ flexDirection: 'column', flexShrink: 1, children: blocks })],
  })
}
