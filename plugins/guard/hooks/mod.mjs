// Claude Code mod (hooks.json `modules`; Copilot ignores the key): usage throttle and the token-weather band.
// The command guards run as command hooks for both harnesses; this holds only what needs the mods API.
import { atom, read, update } from 'claude-code'
import { evaluateSpawn } from '../core/engine.mjs'
import { logRequest } from '../core/otel.mjs'
import { rules } from '../core/rules.mjs'
import { ICON, TTL_MS, clock, forecast, glyph, sparkCells } from './weather.mjs'

// The last main-loop turn: its usage, when it ended, and how many turns this conversation has had.
const weather = atom({ plugin: 'guard', key: 'weather' }, null)
// Context % and cache hit % of the last turns (null: unknown), oldest first.
const history = atom({ plugin: 'guard', key: 'history' }, [])

const PANE = 'weather'
const HISTORY_TURNS = 24
const TONE_COLOR = { ok: undefined, warn: '#f9e2af', bad: '#f38ba8' }
const toneOf = (percent) => (percent >= 80 ? 'bad' : percent >= 50 ? 'warn' : 'ok')

// A bar chart of the history as one Raster; a value of unknown context counts as empty.
const spark = (Raster, key, values, rows) =>
  Raster({ key, columns: values.length, rows, cells: new Uint8Array(Uint32Array.from(sparkCells(values, rows)).buffer).toBase64() })

// The window closest to its limit (a gateway spend limit is not a plan window).
const worstWindow = (limits) => limits.filter((r) => r.kind !== 'spend_limit').sort((a, b) => b.percentUsed - a.percentUsed)[0]

// A /clear: forget the last turn and redraw.
async function reset($) {
  await update($, weather, () => null)
  await update($, history, () => [])
  $.ui.invalidate('ui.render')
}

async function contextPercent($) {
  try {
    return (await $.session.usage()).context.percent
  } catch {
    return undefined // usage unavailable
  }
}

// The throttle denial as a log record for the OTel collector, when the session exports to one; never fails the denial.
async function emitThrottle($, w) {
  try {
    const req = logRequest(
      { endpoint: await $.env.get('OTEL_EXPORTER_OTLP_ENDPOINT'), headers: await $.env.get('OTEL_EXPORTER_OTLP_HEADERS'), resource: await $.env.get('OTEL_RESOURCE_ATTRIBUTES') },
      'guard.throttle',
      { action: 'deny', rule: 'usage-throttle', window: w?.kind, percent: w?.percentUsed, harness: 'claude' },
    )
    if (req) await $.http.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body })
  } catch {
    // collector unreachable: the denial stands
  }
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
    await $.command.register({ name: 'weather', description: 'Show the context and prompt-cache history in a pane' })
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
      const { ctx, hit } = forecast({ percent: await contextPercent($), usage: e.usage, turns: 2 })
      await update($, history, (h) => [...h, { ctx, hit }].slice(-HISTORY_TURNS))
    }
    return next(e)
  })

  // Our line under whatever the plugins beneath draw (next-steps and the like), never in its place: last in the
  // band, it sits right above the prompt, and a blank row such a plugin leads with stays above the band.
  // The context % is in the status line already, so the band says the context as a glyph and the cache facts.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const w = await read($, weather)
    const now = await $.clock.now()
    const f = forecast({ percent: await contextPercent($), usage: w?.usage, turns: w?.turns ?? 0, ttlMs, sinceMs: w ? now - w.at : undefined, showCtx: false })
    if (!f.segments.length) return below
    const h = await read($, history)
    const { Box, Text, Raster } = $.ui.resolve(e)
    const dim = (children) => Text({ dimColor: true, children: [children] })
    const sep = () => dim('  │  ')
    // Icon, space, value: dim while fine, coloured when not.
    const label = (x) => (ICON[x.kind] ? `${ICON[x.kind]} ${x.value}` : x.value)
    const parts = f.segments.flatMap((x, i) => [i ? sep() : null, Text({ color: TONE_COLOR[x.tone], dimColor: x.tone === 'ok', children: [label(x)] })])
    const line = Box({
      flexDirection: 'row',
      children: [
        glyph(f.ctx) ? Text({ color: TONE_COLOR[toneOf(f.ctx)], dimColor: toneOf(f.ctx) === 'ok', children: [`${glyph(f.ctx)}  `] }) : null,
        ...parts,
        h.length > 1 ? sep() : null,
        h.length > 1 ? spark(Raster, 'weather-spark', h.map((x) => x.ctx ?? 0), 1) : null,
      ].filter(Boolean),
    })
    return Box({ flexDirection: 'column', children: below ? [below, line] : [line] })
  })

  // The spinner says how long the prompt cache lasts while a turn runs.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const w = await read($, weather)
    if (!w) return next(e)
    const left = ttlMs - ((await $.clock.now()) - w.at)
    return next(left > 0 ? { ...e, props: { ...e.props, suffix: ` · ${ICON.ttl} ${clock(left)}…` } } : e)
  })

  // /weather: the history at full size.
  on('command.run', { command: 'weather' }, async ($) => {
    const opened = await $.ui.open({ id: PANE, title: 'Token weather', focus: true })
    return { text: opened.isPlaced ? 'Token weather pane opened.' : 'Widen the terminal to see the token weather pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Raster } = $.ui.resolve(e)
    const w = await read($, weather)
    const h = await read($, history)
    const left = w ? ttlMs - ((await $.clock.now()) - w.at) : null
    const filled = left == null ? 0 : Math.round((20 * Math.max(0, left)) / ttlMs)
    return Box({
      flexDirection: 'column',
      children: [
        h.length ? Text({ dimColor: true, children: ['context %, one bar per turn'] }) : Text({ dimColor: true, children: ['No turns yet.'] }),
        h.length ? spark(Raster, 'weather-pane', h.map((x) => x.ctx ?? 0), 4) : null,
        ...h.slice(-8).map((x, i, rows) =>
          Text({ children: [`turn ${w.turns - (rows.length - 1 - i)}  ${glyph(x.ctx) || ' '}  ${x.ctx ?? '?'}%  ${ICON.cache} ${x.hit ?? '?'}%`] }),
        ),
        // The TTL gauge: a heavy rule for what is left, a light one for what is spent.
        left == null
          ? null
          : Box({
              flexDirection: 'row',
              children:
                left > 0
                  ? [
                      Text({ children: [`${ICON.ttl} `] }),
                      Text({ color: TONE_COLOR[left <= 60_000 ? 'warn' : 'ok'] ?? '#a6e3a1', children: ['━'.repeat(filled)] }),
                      Text({ dimColor: true, children: ['─'.repeat(20 - filled)] }),
                      Text({ children: [` ${clock(left)}`] }),
                    ]
                  : [Text({ color: TONE_COLOR.bad, children: ['cache expired'] })],
            }),
        Button({ label: 'Close', hotkey: 'q', onPress: () => $.ui.close({ id: PANE }) }),
      ].filter(Boolean),
    })
  })

  // Usage throttle: no new subagents at the throttle level.
  on('agent.spawn', async ($, e, next) => {
    const { rateLimits } = await $.session.usage()
    const w = worstWindow(rateLimits)
    const d = evaluateSpawn({ usagePercent: w?.percentUsed, resetsAt: w?.resetsAt, rules })
    if (d.action !== 'deny') return next(e)
    await emitThrottle($, w)
    return { deny: d.reason }
  }).catch(($, e, next) => next(e)) // usage unreadable: fail open
}
