import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeMd, inline, mark, STYLE, toTree, unmark } from './markup.mjs'

// Element constructors that build plain objects, as $.ui.resolve's would.
const el = Object.fromEntries(['Box', 'Text', 'Link', 'Markdown'].map((type) => [type, ({ children, ...props }) => ({ type, props, children })]))
// What a tree draws, as text; a Markdown block is drawn as `md(…)`.
const draw = (n) => (typeof n === 'string' ? n : n.type === 'Markdown' ? `md(${n.props.text})` : (n.children ?? []).map(draw).join(n.type === 'Box' && n.props.flexDirection === 'column' ? '\n' : ''))

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

test('toTree: a table with a mark is drawn as rows of cells, padded to the widest', () => {
  const t = toTree(['| check | result |', '|---|---|', `| lint | ${mark('ok', '✓')} |`, `| \`e2e\` | ${mark('bad', '✗ failed')} |`].join('\n'), el)
  assert.equal(draw(t.children[1]), ['┌───────┬──────────┐', '│ check │ result   │', '├───────┼──────────┤', '│ lint  │ ✓        │', '│ e2e   │ ✗ failed │', '└───────┴──────────┘'].join('\n'))
  // A table without a mark stays markdown.
  assert.equal(draw(toTree(`${mark('ok', 'x')}\n\n| a |\n|---|\n| b |`, el).children[1]), 'x\n \nmd(| a |\n|---|\n| b |)')
})
