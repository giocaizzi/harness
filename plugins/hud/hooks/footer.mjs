// The turn footer: the engine's `Baked for 3s` line, followed by what the turn read, wrote and cost.
import { atom, read } from 'claude-code'
import { footerText } from './weather.mjs'

// The main loop's last turns: duration (the footer's key), usage, the session cost after it and the turn's own.
const turns = atom({ plugin: 'hud', key: 'turns' }, [])

export function registerFooter(on) {
  // A footer carries no turn id, so its turn is the latest one of the same duration.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const own = await next(e)
    const t = (await read($, turns)).findLast((x) => x.durationMs === e.props.durationMs)
    if (!own || !t) return own
    const { Box, Text } = $.ui.resolve(e)
    // flexWrap moves the tail whole onto its own line when the row is narrow, instead of wrapping it in a column.
    return Box({ flexDirection: 'row', flexWrap: 'wrap', children: [own, Text({ dimColor: true, wrap: 'truncate-end', children: [` · ${footerText(t)}`] })] })
  })
}
