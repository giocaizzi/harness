// Claude Code mod (hooks.json `modules`; Copilot ignores the key): a toast and a sound for each limit, context and
// prompt-cache alert, and a sound for each way a turn ends. Every sound is a `userConfig` picker in /config.
import { atom, read, update } from 'claude-code'
import { TTL_MS, alerts, clock, turnSound } from './alerts.mjs'

// The last main-loop turn: when it ended, and the alert levels raised so far.
const last = atom({ plugin: 'sounds', key: 'last' }, null)

// A sound by its setting's value (`off` plays nothing); macOS only, elsewhere nothing plays.
async function clip($, name, gain = 1) {
  if (name && name !== 'off') await $.audio.play({ asset: `sounds/${name}.wav` }, { gain }).catch(() => {})
}

// The context % and the rate-limit windows' percent used, by kind (five_hour, seven_day, spend_limit).
async function usage($) {
  try {
    const u = await $.session.usage()
    return { ctx: u.context.percent == null ? null : Math.round(u.context.percent), limits: Object.fromEntries(u.rateLimits.map((r) => [r.kind, r.percentUsed])) }
  } catch {
    return { ctx: null, limits: {} } // usage unavailable
  }
}

export function register(on, options = {}) {
  let ttlMs = TTL_MS['5m']
  let tick
  let warned // the turn whose cache expiry was announced
  let expired // the turn whose cache expiry was announced as past

  on('session.start', async ($, e, next) => {
    try {
      ttlMs = TTL_MS[(await $.settings.read()).promptCacheTtl] ?? TTL_MS['5m']
    } catch {
      // settings unreadable: the API default
    }
    // A toast and a sound a minute before the prompt cache expires and when it has, once per turn.
    tick?.cancel()
    tick = $.clock.every(1000, async () => {
      const l = await read($, last)
      if (!l) return
      const left = ttlMs - ((await $.clock.now()) - l.at)
      if (left > 0 && left <= 60_000 && warned !== l.at) {
        warned = l.at
        $.ui.toast(`Prompt cache expires in ${clock(left)}`)
        await clip($, options.soundCacheExpiring, options.soundGain)
      }
      if (left <= 0 && expired !== l.at) {
        expired = l.at
        $.ui.toast('Prompt cache expired')
        await clip($, options.soundCacheExpired, options.soundGain)
      }
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, last, () => null)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const keys = new Set()
    // Limits, context and the cache clock follow the main loop only.
    if (!e.agentId && e.usage) {
      const at = await $.clock.now()
      const u = await usage($)
      const a = alerts(u.ctx, u.limits, (await read($, last))?.alert)
      await update($, last, () => ({ at, alert: a.now }))
      for (const x of a.alerts) {
        $.ui.toast(x.text)
        keys.add(x.key)
      }
    }
    const done = turnSound(e, options.doneAfterSeconds)
    if (done) keys.add(done)
    // One clip per distinct sound: two limits crossing together play it once.
    for (const name of new Set([...keys].map((k) => options[k]))) await clip($, name, options.soundGain)
    return next(e)
  })
}
