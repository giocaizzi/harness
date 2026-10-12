// Which alerts and sounds a turn raises, free of engine imports so node can test them. Pure: facts in, alerts out.
export const TTL_MS = { '5m': 300_000, '1h': 3_600_000 }

export const clock = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

// The limits that raise a toast and a sound: the sound setting, the label, and the percent each reads.
export const LIMITS = [
  { key: 'soundLimit5h', kind: 'five_hour', label: '5h window' },
  { key: 'soundLimit7d', kind: 'seven_day', label: '7d window' },
  { key: 'soundLimitSpend', kind: 'spend_limit', label: 'Spend limit' },
]
const levelOf = (pct) => (pct >= 100 ? 100 : pct >= 90 ? 90 : pct >= 80 ? 80 : 0)

// What a turn's end raises: the context and each limit crossing 80, 90 and 100. `before` holds the levels raised
// already, so a level is announced once and again only after it was left. Each alert names the sound setting it plays.
export function alerts(ctx, limits, before = {}) {
  const now = { ctx: levelOf(ctx ?? 0) >= 90 ? 90 : levelOf(ctx ?? 0) }
  const out = []
  if (now.ctx > (before.ctx ?? 0)) out.push({ key: 'soundContext', text: now.ctx === 90 ? `Context ${ctx}%: compact now` : `Context ${ctx}%: compact soon` })
  for (const { key, kind, label } of LIMITS) {
    const pct = limits[kind]
    now[kind] = pct == null ? 0 : levelOf(pct)
    if (now[kind] > (before[kind] ?? 0)) out.push({ key, text: now[kind] === 100 ? `${label} reached` : `${label} ${Math.round(pct)}% used` })
  }
  return { alerts: out, now }
}

// The sound setting a finished turn plays, if any: a subagent's, an interrupt, a refusal, an error, or an answer
// that took at least `doneAfterSeconds`.
export function turnSound(e, doneAfterSeconds = 0) {
  if (e.agentId) return 'soundSubagent'
  if (e.reason === 'aborted') return 'soundAborted'
  if (e.reason === 'refusal') return 'soundRefused'
  if (e.reason === 'error') return 'soundError'
  return e.durationMs >= doneAfterSeconds * 1000 ? 'soundDone' : null
}
