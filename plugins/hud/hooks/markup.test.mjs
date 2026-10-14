import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cellWidth, escapeMd, inline, mark, STYLE, toTree, unmark } from './markup.mjs'

// Element constructors that build plain objects, as $.ui.resolve's would.
const el = Object.fromEntries(['Box', 'Text', 'Link', 'Markdown'].map((type) => [type, ({ children, ...props }) => ({ type, props, children })]))
// What a tree draws, as text; a Markdown block is drawn as `md(…)`, a Box of a width padded to it as its
// justifyContent says.
const pad = (s, n, how) => {
  const gap = Math.max(0, n - cellWidth(s))
  const left = how === 'center' ? Math.floor(gap / 2) : how === 'flex-end' ? gap : 0
  return ' '.repeat(left) + s + ' '.repeat(gap - left)
}
const draw = (n) => {
  if (typeof n === 'string') return n
  if (n.type === 'Markdown') return `md(${n.props.text})`
  const s = (n.children ?? []).map(draw).join(n.type === 'Box' && n.props.flexDirection === 'column' ? '\n' : '')
  return n.type === 'Box' && n.props.width ? pad(s, n.props.width, n.props.justifyContent) : s
}

test('mark and unmark; colour off writes the text alone', () => {
  assert.equal(unmark(`a ${mark('ok', 'b')} c`), 'a b c')
  assert.equal(mark('ok', 'b', false), 'b')
  assert.equal(mark('ok', ''), '')
  assert.equal(escapeMd('a[b]_c*'), 'a\\[b\\]\\_c\\*')
})

test('inline: marked spans styled, links with styled labels, code, bold, italic, escapes', () => {
  const out = inline(`x ${mark('ok', '✓ passed')} [${mark('dim', 'r › ')}${mark('name', 'a\\_b.ts')}](vscode://file/a_b.ts) \`c\` **b** *i* \\[w\\]`, el)
  assert.equal(out[0], 'x ')
  assert.deepEqual(out[1], { type: 'Text', props: STYLE.ok, children: ['✓ passed'] })
  assert.equal(out[3].type, 'Link')
  assert.equal(out[3].props.href, 'vscode://file/a_b.ts')
  assert.deepEqual(out[3].children.map((c) => c.children[0]), ['r › ', 'a_b.ts'])
  assert.equal(out[5].children[0], 'c')
  assert.equal(out[7].props.bold, true)
  assert.equal(out[9].props.italic, true)
  assert.equal(out.at(-1), ' [w]')
})

test('toTree: null without a mark; marked lines are rows, the rest the engine Markdown', () => {
  assert.equal(toTree('plain [a](vscode://x) text', el), null)
  const text = ['# Title', '', 'Some **prose**.', 'More prose.', '', `- lint: ${mark('ok', '✓ passed')}`, '- docs', '', '```', `code ${'x'}`, '```', '', `> quote ${mark('bad', 'x')}`].join('\n')
  const t = toTree(text, el, { first: true })
  assert.equal(t.children[0].children[0], '⏺ ')
  assert.equal(draw(t.children[1]), ['md(# Title\n\nSome **prose**.\nMore prose.)', ' ', '- lint: ✓ passed', 'md(- docs\n\n```\ncode x\n```)', ' ', '▎ quote x'].join('\n'))
  assert.equal(toTree(mark('ok', 'x'), el).children[0].children[0], '  ') // not the reply's first block: no bullet
})

test('cellWidth: wide characters and emoji two, combining marks and joiners none', () => {
  assert.equal(cellWidth('abc'), 3)
  assert.equal(cellWidth('日本'), 4)
  assert.equal(cellWidth('✅ ok'), 5)
  assert.equal(cellWidth('✔️'), 2)
  assert.equal(cellWidth('e\u0301'), 1)
  assert.equal(cellWidth('✓ ✗ ⊘'), 5)
})

const T = (...rows) => rows.join('\n')

test('toTree: a table with a mark is drawn in colour, its columns as wide as their widest cell', () => {
  const t = toTree(T('| check | result |', '|---|---|', `| lint | ${mark('ok', '✓')} |`, `| \`e2e\` | ${mark('bad', '✗ failed')} |`, '| 日本 | *slow* |'), el)
  assert.equal(draw(t.children[1]), T('┌───────┬──────────┐', '│ check │ result   │', '├───────┼──────────┤', '│ lint  │ ✓        │', '│ e2e   │ ✗ failed │', '│ 日本  │ slow     │', '└───────┴──────────┘'))
  // The colour, the header's bold, code and the link stay on the cells.
  const cell = (r, c) => t.children[1].children[r].children[1 + 2 * c].children[0]
  assert.deepEqual(cell(3, 1).children[0].props, STYLE.ok)
  assert.equal(cell(1, 0).children[0].props.bold, true)
  // Each cell is a Box of its column's width, so a character the estimate gets wrong never shifts a border.
  assert.equal(t.children[1].children[3].children[1].props.width, 5)
})

test('toTree: a table keeps its links and its alignment, and is recognised without the leading pipe', () => {
  const t = toTree(T('| file | n |', '|:-:|--:|', `| [${mark('name', 'a.ts')}](vscode://file/a.ts) | 1 |`), el)
  assert.equal(draw(t.children[1]), T('┌──────┬───┐', '│ file │ n │', '├──────┼───┤', '│ a.ts │ 1 │', '└──────┴───┘'))
  const link = t.children[1].children[3].children[1].children[0].children[0]
  assert.equal(link.type, 'Link')
  assert.equal(link.props.href, 'vscode://file/a.ts')
  assert.equal(t.children[1].children[3].children[3].props.justifyContent, 'flex-end')
  assert.equal(draw(toTree(T('a | b', '--- | ---', `lint | ${mark('bad', '✗')}`), el).children[1]), T('┌──────┬───┐', '│ a    │ b │', '├──────┼───┤', '│ lint │ ✗ │', '└──────┴───┘'))
})

test('toTree: a table wider than the viewport fits it, the widest column wrapping at spaces, a long word split', () => {
  const text = T('| id | note |', '|---|---|', `| ${mark('ok', '1')} | a long note that will not fit | `, '| 2 | path/to/a/very/long/file.ts |')
  const lines = draw(toTree(text, el, { columns: 30 }).children[1]).split('\n')
  for (const l of lines) assert.equal(cellWidth(l), 28, l) // the viewport less the gutter
  assert.deepEqual(lines, ['┌────┬─────────────────────┐', '│ id │ note                │', '├────┼─────────────────────┤', '│ 1  │ a long note that    │', '│    │ will not fit        │', '│ 2  │ path/to/a/very/long │', '│    │ /file.ts            │', '└────┴─────────────────────┘'])
  // Without a viewport, or wide enough: one line a row.
  assert.equal(draw(toTree(text, el).children[1]).split('\n').length, 6)
})

test('toTree: a table without a mark stays the engine Markdown', () => {
  assert.equal(draw(toTree(`${mark('ok', 'x')}\n\n| a |\n|---|\n| b |`, el).children[1]), 'x\n \nmd(| a |\n|---|\n| b |)')
})
