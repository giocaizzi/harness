// Claude Code mod (hooks.json `modules`; Copilot ignores the key): usage throttle and the token-weather band.
// The command guards run as command hooks for both harnesses; this holds only what needs the mods API.
import { atom, read, update } from 'claude-code'
import { evaluateSpawn } from '../core/engine.mjs'
import { rules } from '../core/rules.mjs'
import { TTL_MS, forecast } from './weather.mjs'

// The last main-loop turn: its usage, when it ended, and how many turns this conversation has had.
const weather = atom({ plugin: 'guard', key: 'weather' }, null)

// The window closest to its limit (a gateway spend limit is not a plan window).
const worstWindow = (limits) => limits.filter((r) => r.kind !== 'spend_limit').sort((a, b) => b.percentUsed - a.percentUsed)[0]

// A /clear: forget the last turn and redraw.
async function reset($) {
  await update($, weather, () => null)
  $.ui.invalidate('ui.render')
}

export function register(on) {
  let ttlMs = TTL_MS['5m']
  let tick

  // Draw at once (the context part needs no turn); a reload keeps $.state, so the last turn stays.
  on('session.start', async ($, e, next) => {
    $.ui.invalidate('ui.render')
    try {
      ttlMs = TTL_MS[(await $.settings.read()).promptCacheTtl] ?? TTL_MS['5m']
    } catch {
      // settings unreadable: the API default
    }
    // The TTL countdown: one redraw a second while the band shows a last turn.
    tick?.cancel()
    tick = $.clock.every(1000, async () => {
      if (await read($, weather)) $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await reset($)
    return next(e)
  })

  // Main loop only: a subagent's turn says nothing about this conversation's cache.
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.usage) {
      const at = await $.clock.now()
      await update($, weather, (w) => ({ usage: e.usage, at, turns: (w?.turns ?? 0) + 1 }))
    }
    return next(e)
  })

  // Our line on top of whatever the plugins beneath draw (next-steps and the like), never in its place.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const w = await read($, weather)
    let percent
    try {
      percent = (await $.session.usage()).context.percent
    } catch {
      // usage unavailable: show the cache part alone
    }
    const now = await $.clock.now()
    const f = forecast({ percent, usage: w?.usage, turns: w?.turns ?? 0, ttlMs, sinceMs: w ? now - w.at : undefined })
    if (!f.text) return below
    const { Box, Text } = $.ui.resolve(e)
    const line = Text({ dimColor: !f.hints.length, color: f.hints.length ? 'yellow' : undefined, children: [f.text] })
    return Box({ flexDirection: 'column', children: below ? [line, below] : [line] })
  })

  // Usage throttle: no new subagents at the throttle level.
  on('agent.spawn', async ($, e, next) => {
    const { rateLimits } = await $.session.usage()
    const w = worstWindow(rateLimits)
    const d = evaluateSpawn({ usagePercent: w?.percentUsed, resetsAt: w?.resetsAt, rules })
    return d.action === 'deny' ? { deny: d.reason } : next(e)
  }).catch(($, e, next) => next(e)) // usage unreadable: fail open
}
