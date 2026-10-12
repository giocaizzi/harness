// Tool rows: an icon coloured by how the call went, the lines an edit changed and how long the call took. The
// spinner names the running tool in place of a random verb.
import { atom, read, update } from 'claude-code'
import { ACTIVITY, activityLabel, duration, editStat } from './weather.mjs'

// The tool the model is running now, and how long each finished call took, by tool_use_id.
const activity = atom({ plugin: 'hud', key: 'activity' }, null)
const calls = atom({ plugin: 'hud', key: 'calls' }, {})
const KEEP = 300
const TONE_COLOR = { ok: '#a6e3a1', warn: '#f9e2af', bad: '#f38ba8' }

export function registerTools(on) {
  on('tool.call', async ($, e, next) => {
    const t0 = await $.clock.now()
    await update($, activity, () => e.tool)
    try {
      return await next(e)
    } finally {
      const ms = (await $.clock.now()) - t0
      await update($, activity, () => null)
      if (e.tool_use_id) await update($, calls, (c) => Object.fromEntries([...Object.entries(c).slice(1 - KEEP), [e.tool_use_id, ms]]))
    }
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const label = activityLabel(await read($, activity))
    return next(label ? { ...e, props: { ...e.props, message: label } } : e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    if (!row) return row
    const p = e.props
    const { Box, Text } = $.ui.resolve(e)
    const tone = p.isErrored ? 'bad' : p.isRunning || p.isInterrupted ? 'warn' : 'ok'
    const icon = (ACTIVITY[p.tool] ?? (String(p.tool).startsWith('mcp__') ? [''] : ['']))[0]
    const ms = p.isRunning ? undefined : (await read($, calls))[p.tool_use_id]
    const tail = [editStat(p.tool, p.input), ms == null ? null : duration(ms)].filter(Boolean).join(' · ')
    return Box({
      flexDirection: 'row',
      children: [
        Text({ color: TONE_COLOR[tone], children: [`${icon} `] }),
        Box({ flexDirection: 'column', flexGrow: 1, children: [row] }),
        tail ? Text({ dimColor: true, children: [` ${tail}`] }) : null,
      ].filter(Boolean),
    })
  })
}
