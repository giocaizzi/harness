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

// A minute-and-seconds duration for a notification: 45s, 2m 3s.
const took = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)

// The system notification a finished main-loop turn raises, if any: an answer after at least `afterSeconds`, or a
// turn that ended badly. An interrupt is the person's own doing and raises none.
export function turnNotice(e, afterSeconds = 60) {
  if (e.agentId || e.reason === 'aborted') return null
  if (e.reason === 'refusal') return 'The model refused the turn'
  if (e.reason === 'error') return 'The turn ended on an API error'
  return e.durationMs >= afterSeconds * 1000 ? `Turn finished in ${took(e.durationMs)}` : null
}

// The notification a change of the branch's PR checks raises (from the hud plugin's repo state), if any: checks that
// were running and now passed or failed, on the same PR.
export function ciNotice(previous, value) {
  const [a, b] = [previous?.pr, value?.pr]
  if (!a || !b || a.number !== b.number || a.ci !== 'pending' || b.ci === 'pending' || !b.ci) return null
  return b.ci === 'fail' ? `Checks failed on #${b.number}` : `Checks passed on #${b.number}`
}

// The plugin.json defaults, for the harnesses without per-plugin settings (pi, Codex, opencode): the clip per alert
// or turn ending.
export const CLIPS = { soundContext: 'alert', soundDone: 'done', soundAborted: null, soundRefused: 'error', soundError: 'error', soundSubagent: 'tick' }

// What a finished run raises there: the clips to play, the notices to show, and the context levels raised so far
// (`before` for the next run).
export function settle({ durationMs, aborted, error, agentId, pct, before }) {
  const e = { durationMs, agentId, reason: aborted ? 'aborted' : error ? 'error' : 'done' }
  const { alerts: raised, now } = alerts(pct, {}, before)
  const clips = [CLIPS[turnSound(e)], ...raised.map((a) => CLIPS[a.key])].filter(Boolean)
  const notices = [turnNotice(e), ...raised.map((a) => a.text)].filter(Boolean)
  return { clips: [...new Set(clips)], notices, now }
}
