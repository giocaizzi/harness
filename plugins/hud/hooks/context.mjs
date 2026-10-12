// `/ctx`: the context window broken down as /context breaks it, live, in a pane.
import { tokens } from './weather.mjs'

const PANE = 'ctx'
// Catppuccin Mocha, one colour per used category in order; free space and the buffer are dim.
const PALETTE = [0x89b4fa, 0xcba6f7, 0xa6e3a1, 0xf9e2af, 0xfab387, 0x94e2d5, 0xf38ba8, 0x74c7ec, 0xf5c2e7, 0xb4befe]
const DIM = 0x585b70
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`

// The breakdown's grid as Raster cells: a full square where a category fills it, a light one where it is free.
export function gridCells(rows, colorOf) {
  const out = []
  for (const row of rows) for (const sq of row) out.push(sq.isFilled ? 0x25a0 : 0x25a1, colorOf(sq.categoryName), 0x01000000)
  return out
}

async function breakdown($, columns) {
  try {
    return (await $.session.usage({ breakdown: 'summary', columns })).context.breakdown
  } catch {
    return undefined // usage unavailable
  }
}

export function registerContext(on) {
  on('command.run', { command: 'ctx' }, async ($) => {
    const opened = await $.ui.open({ id: PANE, title: 'Context', focus: true })
    return { text: opened.isPlaced ? 'Context pane opened.' : 'Widen the terminal to see the context pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Raster } = $.ui.resolve(e)
    const b = await breakdown($, e.props.bodyColumns)
    if (!b) return Box({ flexDirection: 'column', children: [Text({ dimColor: true, children: ['No context figures yet.'] }), Button({ label: 'Close', hotkey: 'q', onPress: () => $.ui.close({ id: PANE }) })] })
    const used = b.categories.filter((c) => c.kind === 'used')
    const colorOf = (name) => {
      const i = used.findIndex((c) => c.name === name)
      return i < 0 ? DIM : PALETTE[i % PALETTE.length]
    }
    const columns = Math.max(0, ...b.gridRows.map((r) => r.length))
    const rows = b.gridRows.map((r) => [...r, ...Array(columns - r.length).fill({ isFilled: false, categoryName: '' })])
    return Box({
      flexDirection: 'column',
      children: [
        Text({ children: [`${b.model} · ${tokens(b.totalTokens)} of ${tokens(b.maxTokens)} (${Math.round(b.percentage)}%)`] }),
        columns ? Raster({ key: 'ctx-grid', columns, rows: rows.length, cells: new Uint8Array(Uint32Array.from(gridCells(rows, colorOf)).buffer).toBase64() }) : null,
        ...b.categories
          .filter((c) => c.tokens > 0)
          .map((c) =>
            Box({
              key: c.name,
              flexDirection: 'row',
              children: [Text({ color: hex(colorOf(c.name)), children: ['■ '] }), Text({ children: [`${c.name} `] }), Text({ dimColor: true, children: [`${tokens(c.tokens)} · ${((100 * c.tokens) / b.maxTokens).toFixed(1)}%`] })],
            }),
          ),
        Button({ label: 'Close', hotkey: 'q', onPress: () => $.ui.close({ id: PANE }) }),
      ].filter(Boolean),
    })
  })
}
