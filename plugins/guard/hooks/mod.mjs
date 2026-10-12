// Claude Code mod (hooks.json `modules`; Copilot ignores the key): usage throttle and the token-weather band.
// The command guards run as command hooks for both harnesses; this holds only what needs the mods API.
import { atom, read, update } from 'claude-code'
import { evaluateSpawn } from '../core/engine.mjs'
import { logRequest } from '../core/otel.mjs'
import { rules } from '../core/rules.mjs'
import { ICON, TTL_MS, activityLabel, alerts, battery, clock, forecast, glyph, repoState, sparkCells, sparkRange, turnSound } from './weather.mjs'

// The last main-loop turn: its usage, when it ended, and how many turns this conversation has had.
const weather = atom({ plugin: 'guard', key: 'weather' }, null)
// Context % and cache hit % of the last turns (null: unknown), oldest first.
const history = atom({ plugin: 'guard', key: 'history' }, [])

// The tool the model is running now (the spinner says it), and the branch's PR and unpushed work (the band says it).
const activity = atom({ plugin: 'guard', key: 'activity' }, null)
const repo = atom({ plugin: 'guard', key: 'repo' }, null)
const REPO_REFRESH_MS = 60_000
const CI_ICON = { pass: '\u2713', fail: '\u2717', pending: '\u2026' }
const CI_TONE = { pass: 'ok', fail: 'bad', pending: 'warn' }

const PANE = 'weather'
const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const HISTORY_TURNS = 24
const BAND_TURNS = 8
const TONE_COLOR = { ok: undefined, warn: '#f9e2af', bad: '#f38ba8' }
const toneOf = (percent) => (percent >= 80 ? 'bad' : percent >= 50 ? 'warn' : 'ok')

// A bar chart of the history as one Raster; a value of unknown context counts as empty.
const spark = (Raster, key, values, rows, lo, hi) =>
  Raster({ key, columns: values.length, rows, cells: new Uint8Array(Uint32Array.from(sparkCells(values, rows, lo, hi)).buffer).toBase64() })

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

// The branch's PR (with its checks) and unpushed work; either part is null where git or gh cannot say.
async function refreshRepo($) {
  const run = async (argv) => {
    try {
      const r = await $.process.run(argv, { timeoutMs: 8000 })
      return r.exitCode === 0 ? r.stdout : null
    } catch {
      return null // not a repository, or the tool is missing
    }
  }
  const pr = await run(['gh', 'pr', 'view', '--json', 'number,statusCheckRollup'])
  const counts = await run(['git', 'rev-list', '--left-right', '--count', '@{u}...HEAD'])
  await update($, repo, () => repoState(pr ? JSON.parse(pr) : null, counts))
}

// A sound by its setting's value (`off` plays nothing); macOS only, elsewhere nothing plays.
async function clip($, name, gain = 1) {
  if (name && name !== 'off') await $.audio.play({ asset: `sounds/${name}.wav` }, { gain }).catch(() => {})
}

// The rate-limit windows' percent used, by kind (five_hour, seven_day); empty when unavailable.
async function windows($) {
  try {
    return Object.fromEntries((await $.session.usage()).rateLimits.map((r) => [r.kind, r.percentUsed]))
  } catch {
    return {} // usage unavailable
  }
}

export function register(on, options = {}) {
  let ttlMs = TTL_MS['5m']
  let tick
  let repoTick
  let warned // the turn whose cache expiry was announced
  let expired // the turn whose cache expiry was announced as past

  // Draw at once (the context part needs no turn); a reload keeps $.state, so the last turn stays.
  on('session.start', async ($, e, next) => {
    $.ui.invalidate('ui.render')
    try {
      ttlMs = TTL_MS[(await $.settings.read()).promptCacheTtl] ?? TTL_MS['5m']
    } catch {
      // settings unreadable: the API default
    }
    // The TTL countdown: one redraw a second while the band shows a last turn.
    await refreshRepo($)
    await $.command.register({ name: 'weather', description: 'Show the context and prompt-cache history in a pane' })
    tick?.cancel()
    repoTick?.cancel()
    repoTick = $.clock.every(REPO_REFRESH_MS, () => refreshRepo($))
    tick = $.clock.every(1000, async () => {
      const w = await read($, weather)
      if (!w) return
      $.ui.invalidate('ui.render')
      // One toast a minute before the cache expires, once per turn.
      const left = ttlMs - ((await $.clock.now()) - w.at)
      if (left > 0 && left <= 60_000 && warned !== w.at) {
        warned = w.at
        $.ui.toast(`Prompt cache expires in ${clock(left)}`)
        await clip($, options.soundCacheExpiring, options.soundGain)
      }
      if (left <= 0 && expired !== w.at) {
        expired = w.at
        $.ui.toast('Prompt cache expired')
        await clip($, options.soundCacheExpired, options.soundGain)
      }
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await reset($)
    return next(e)
  })

  // The weather facts count main-loop turns only: a subagent's turn says nothing about this conversation's cache.
  on('turn.complete', async ($, e, next) => {
    const sounds = new Set()
    if (!e.agentId && e.usage) {
      const at = await $.clock.now()
      const lim = await windows($)
      const { ctx, hit } = forecast({ percent: await contextPercent($), usage: e.usage, turns: 2 })
      const a = alerts(ctx, lim, (await read($, weather))?.alert)
      await update($, weather, (w) => ({ usage: e.usage, at, turns: (w?.turns ?? 0) + 1, alert: a.now }))
      await update($, history, (h) => [...h, { ctx, hit, five: lim.five_hour ?? null, seven: lim.seven_day ?? null }].slice(-HISTORY_TURNS))
      for (const x of a.alerts) {
        $.ui.toast(x.text)
        sounds.add(x.key)
      }
    }
    if (!e.agentId) await refreshRepo($)
    const done = turnSound(e, options.doneAfterSeconds)
    if (done) sounds.add(done)
    // One clip per distinct sound: two limits crossing together play it once.
    for (const name of new Set([...sounds].map((k) => options[k]))) await clip($, name, options.soundGain)
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
    const h = (await read($, history)).slice(-BAND_TURNS)
    const { Box, Text, Raster } = $.ui.resolve(e)
    const dim = (children) => Text({ dimColor: true, children: [children] })
    // Each part in brackets, as the prompt and the status line draw theirs: dim while fine, coloured when not.
    const bracket = (inner) => [dim('['), inner, dim(']')]
    const part = (text, tone) => bracket(Text({ color: TONE_COLOR[tone], dimColor: tone === 'ok', children: [text] }))
    const label = (x) => (ICON[x.kind] ? `${ICON[x.kind]} ${x.value}` : x.value)
    const r = await read($, repo)
    const ahead = r && (r.ahead || r.behind) ? `${r.ahead ? `\u2191${r.ahead}` : ''}${r.ahead && r.behind ? ' ' : ''}${r.behind ? `\u2193${r.behind}` : ''}` : null
    const parts = [
      r?.pr ? part(`\uf407 #${r.pr.number}${r.pr.ci ? ` ${CI_ICON[r.pr.ci]}` : ''}`, CI_TONE[r.pr.ci] ?? 'ok') : null,
      ahead ? part(ahead, 'ok') : null,
      ...f.segments.map((x) => part(label(x), x.tone)),
      h.length > 1 ? bracket(spark(Raster, 'weather-spark', h.map((x) => x.ctx ?? 0), 1, ...sparkRange(h.map((x) => x.ctx ?? 0)))) : null,
    ].filter(Boolean)
    if (!parts.length) return below
    const line = Box({
      flexDirection: 'row',
      children: [
        glyph(f.ctx) ? Text({ color: TONE_COLOR[toneOf(f.ctx)], dimColor: toneOf(f.ctx) === 'ok', children: [`${glyph(f.ctx)} `] }) : null,
        ...parts.flatMap((p, i) => [i ? Text({ children: [' '] }) : null, ...p]),
      ].filter(Boolean),
    })
    // Claude Code keeps a blank row under the band; a blank row on top pairs it, unless a plugin beneath already
    // leads its block with one (next-steps does). The engine's own drawing under the band takes no rows.
    const alone = !below || below.type === 'engine'
    return Box({ flexDirection: 'column', marginTop: alone ? 1 : 0, children: below ? [below, line] : [line] })
  })

  // The spinner says what a running tool is doing instead of a random verb.
  on('tool.call', async ($, e, next) => {
    await update($, activity, () => e.tool)
    try {
      return await next(e)
    } finally {
      await update($, activity, () => null)
    }
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const label = activityLabel(await read($, activity))
    return next(label ? { ...e, props: { ...e.props, message: label } } : e)
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
        ...[['5h', 'five'], ['7d', 'seven']].flatMap(([label, key]) => {
          const series = h.map((x) => x[key] ?? 0)
          const now = h.at(-1)?.[key]
          return now == null ? [] : [Text({ children: [`${battery(now)} ${label} ${Math.round(now)}%`] }), spark(Raster, `weather-${key}`, series, 1, 0, 100)]
        }),
        w ? Text({ dimColor: true, children: [`last turn: ${tokens(w.usage.input_tokens)} in · ${tokens(w.usage.cache_read_input_tokens)} read · ${tokens(w.usage.cache_creation_input_tokens)} written · ${tokens(w.usage.output_tokens)} out`] }) : null,
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
