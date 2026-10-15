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
  completed: { color: 'merged' },
  not_planned: { color: 'inactive' },
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
const INLINE = new RegExp(`${MARK.source}|${LINK.source}|(\`+)([^\`]+?)\\5|\\*\\*(.+?)\\*\\*|(?<![\\w*])\\*(?![\\s*])(.+?)(?<![\\s*])\\*(?![\\w*])`, 'g')
const CODE = { color: '#b4befe' } // the theme's inline code is lavender-blue

// One markdown line's inline content as flat runs { text, props, href }: marked spans styled, links with their
// target, code, bold, italic.
function spans(s, base = {}, href = undefined, out = []) {
  let at = 0
  const plain = (t) => t && out.push({ text: unescape(t), props: base, href })
  for (const m of s.matchAll(INLINE)) {
    plain(s.slice(at, m.index))
    at = m.index + m[0].length
    const [, style, marked, label, link, , code, bold, italic] = m
    if (style !== undefined) out.push({ text: unescape(marked), props: { ...base, ...STYLE[style] }, href })
    else if (link !== undefined) spans(label, base, link, out)
    else if (code !== undefined) out.push({ text: code, props: CODE, href })
    else if (bold !== undefined) spans(bold, { ...base, bold: true }, href, out)
    else spans(italic, { ...base, italic: true }, href, out)
  }
  plain(s.slice(at))
  return out
}

const drawRun = (r, el, base) => (r.props === base ? r.text : el.Text({ ...r.props, children: [r.text] }))

// Runs as Text children: a link's runs inside one Link.
function draw(rs, el, base = {}) {
  const out = []
  for (let i = 0; i < rs.length; i++) {
    const { href } = rs[i]
    if (!href) {
      out.push(drawRun(rs[i], el, base))
      continue
    }
    let j = i
    while (j < rs.length && rs[j].href === href) j++
    out.push(el.Link({ href, children: rs.slice(i, j).map((r) => drawRun(r, el, base)) }))
    i = j - 1
  }
  return out.length ? out : ['']
}

// One markdown line's inline content as Text children: marked spans styled, links as Link, code, bold, italic.
export const inline = (s, el, base = {}) => draw(spans(s, base), el, base)

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

// --- tables ------------------------------------------------------------------------------------------------------

// Terminal cells a string takes: wide and fullwidth characters and emoji two, combining marks and joiners none, an
// emoji presentation selector one more. An estimate the layout never depends on: each cell is a Box of its width.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}/u
const ZERO = /[\p{Mn}\p{Me}\u200B-\u200F\u2060\uFE00-\uFE0E]/u
export const cellWidth = (s) => {
  let w = 0
  for (const ch of s) w += ch === '\uFE0F' ? 1 : ZERO.test(ch) ? 0 : WIDE.test(ch) ? 2 : 1
  return w
}

// A table row's cells; a separator row (`|---|:-:|`) is null.
const split = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
const cells = (line) => (SEPARATOR.test(line) && line.includes('-') ? null : split(line))
const ALIGN = { left: 'flex-start', center: 'center', right: 'flex-end' }
const alignOf = (sep) => (/^:-+:$/.test(sep) ? 'center' : /-:$/.test(sep) ? 'right' : 'left')

// Runs wrapped into lines of at most `width` cells: at spaces, a word wider than the line split by character.
function wrap(rs, width) {
  const lines = [[]]
  let used = 0
  const put = (r, text) => {
    const line = lines.at(-1)
    const last = line.at(-1)
    if (last && last.props === r.props && last.href === r.href) last.text += text
    else line.push({ ...r, text })
    used += cellWidth(text)
  }
  for (const r of rs) {
    for (const word of r.text.split(/(\s+)/)) {
      if (!word) continue
      const w = cellWidth(word)
      if (/^\s/.test(word)) {
        if (used && used + w <= width) put(r, word)
        continue
      }
      if (used && used + w > width) {
        lines.push([])
        used = 0
      }
      for (const ch of w > width ? [...word] : [word]) {
        if (used && used + cellWidth(ch) > width) {
          lines.push([])
          used = 0
        }
        put(r, ch)
      }
    }
  }
  for (const line of lines) while (line.length && /^\s*$/.test(line.at(-1).text)) line.pop()
  return lines
}

// A markdown table drawn as the engine draws one, its cells keeping their colour and links. Columns take their widest
// cell, and when the table is wider than the room the widest give way, their cells wrapping. Every line of a row is a
// Box row of fixed-width cell Boxes, so the borders stay straight whatever a cell's characters measure.
function table(lines, el, room) {
  const rows = lines.map(cells)
  const sep = lines.find((_l, i) => rows[i] === null)
  const body = rows.filter(Boolean)
  const n = Math.max(...body.map((r) => r.length))
  const aligns = sep ? split(sep).map(alignOf) : []
  const content = rows.map((r, i) => r && Array.from({ length: n }, (_, c) => spans(r[c] ?? '', i === 0 && rows[1] === null ? { bold: true } : {})))
  const natural = (rs) => rs.reduce((w, r) => w + cellWidth(r.text), 0)
  const longest = (rs) => Math.max(1, ...rs.flatMap((r) => r.text.split(/\s+/).map(cellWidth)))
  const w = Array.from({ length: n }, (_, c) => Math.max(1, ...content.filter(Boolean).map((r) => natural(r[c]))))
  const floor = w.map((x, c) => Math.min(x, Math.max(3, Math.min(12, Math.max(...content.filter(Boolean).map((r) => longest(r[c])))))))
  const avail = room ? room - (3 * n + 1) : Infinity
  while (w.reduce((a, b) => a + b, 0) > avail) {
    const c = w.reduce((best, x, i) => (x > floor[i] && (best < 0 || x > w[best]) ? i : best), -1)
    if (c < 0) break
    w[c]--
  }
  const dim = (s) => el.Text({ dimColor: true, children: [s] })
  const rule = (l, m, r) => dim(l + w.map((x) => '─'.repeat(x + 2)).join(m) + r)
  const out = [rule('┌', '┬', '┐')]
  for (const r of content) {
    if (!r) {
      out.push(rule('├', '┼', '┤'))
      continue
    }
    const wrapped = r.map((rs, c) => wrap(rs, w[c]))
    const height = Math.max(...wrapped.map((l) => l.length))
    for (let k = 0; k < height; k++) {
      const kids = [dim('│ ')]
      wrapped.forEach((ls, c) => {
        const line = ls[k] ?? []
        kids.push(el.Box({ width: w[c], flexShrink: 0, justifyContent: ALIGN[aligns[c] ?? 'left'], children: [el.Text({ wrap: 'truncate-end', children: draw(line, el) })] }))
        kids.push(dim(c < n - 1 ? ' │ ' : ' │'))
      })
      out.push(el.Box({ flexDirection: 'row', children: kids }))
    }
  }
  out.push(rule('└', '┴', '┘'))
  return out
}

const FENCE = /^ {0,3}(```|~~~)/
const isTable = (l) => /^\s*\|/.test(l)
// A table row without the leading pipe, whose header the separator row below makes a table.
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const startsTable = (lines, i) => isTable(lines[i]) || (/(?<!\\)\|/.test(lines[i]) && SEPARATOR.test(lines[i + 1] ?? '') && lines[i + 1].includes('|'))
const own = (l) => l.includes(OPEN) || OTHER_SCHEME.test(l)

// The reply drawn as the engine would, but each line with a marked span (or a link the Markdown element would not
// draw) as a Text row of its own, and a table holding one as a table of our own. null when nothing needs it: the
// caller then hands the engine the text. first: the reply's opening block, which carries the `⏺` bullet; columns:
// the viewport's width, which the table fits (less the two-column gutter).
export function toTree(text, el, { first = false, columns = 0 } = {}) {
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
      const t = lines.slice(i, j)
      if (t.some(own)) {
        flush()
        blocks.push(...table(t, el, columns && columns - 2))
      } else md.push(...t)
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
