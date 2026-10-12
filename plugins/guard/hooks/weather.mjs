// Token weather facts, free of engine imports so node can test them. Pure: facts in, one display line out.
// percent: context fullness; usage: the last main-loop turn's token counts; turns: main-loop turns since the
// session (or /clear) began; ttlMs / sinceMs: the prompt-cache TTL and the time since that turn ended.
export const TTL_MS = { '5m': 300_000, '1h': 3_600_000 }

export const clock = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

const BLOCKS = '▁▂▃▄▅▆▇█'

// Nerd Font icons (BMP private use, so a Raster could take them too), checked present in JetBrainsMono Nerd Font,
// which chezmoi installs and sets in Ghostty, VS Code and Windows Terminal. Each is drawn followed by a space:
// Ghostty then draws the icon at full size instead of squeezing it into one cell.
export const ICON = { cache: '\uf472', ttl: '\uf520' } // nf-oct-database, nf-oct-stopwatch

// A weather icon for how full the context is: sunny, cloudy, showers, thunderstorm, lightning (nf-weather-*).
export const glyph = (ctx) => (ctx == null ? '' : ctx < 25 ? '\ue30d' : ctx < 50 ? '\ue302' : ctx < 75 ? '\ue319' : ctx < 90 ? '\ue31d' : '\ue315')

// A battery for how much of a rate-limit window is left (nf-fa-battery_0..4, full to empty as `used` rises).
export const battery = (used) => String.fromCharCode(0xf244 - Math.min(4, Math.max(0, Math.round((100 - used) / 25))))

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

// Cells of a bar chart, row-major [codePoint, color, background] triplets, one column per value (0-100). Heights
// span lo..hi (the tallest bar fills `rows`, the lowest keeps one eighth so it shows); colours are 0xRRGGBB by the
// value itself. 0x01000000 is the default background.
export const TONE_RGB = { ok: 0xa6e3a1, warn: 0xf9e2af, bad: 0xf38ba8 }
export function sparkCells(values, rows, lo = 0, hi = 100) {
  const out = []
  for (let r = 0; r < rows; r++) {
    for (const v of values) {
      const share = (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)
      const eighths = Math.max(1, Math.round(share * rows * 8)) - (rows - 1 - r) * 8
      const level = Math.min(8, Math.max(0, eighths))
      out.push(level ? BLOCKS.codePointAt(level - 1) : 32, v >= 80 ? TONE_RGB.bad : v >= 50 ? TONE_RGB.warn : TONE_RGB.ok, 0x01000000)
    }
  }
  return out
}

// The band's sparkline range: the history's own spread, at least 10 points, so a steady context still shows a shape.
export function sparkRange(values) {
  const lo = Math.max(0, Math.min(...values) - 2)
  return [lo, Math.min(100, Math.max(lo + 10, Math.max(...values)))]
}

// showCtx false leaves the context % out of `text` and `segments` (the Claude status line already shows it);
// `segments` are the same parts with their kind, bare value and a tone (ok | warn | bad) for a drawing to colour.
export function forecast({ percent, usage, turns = 0, ttlMs, sinceMs, showCtx = true }) {
  const ctx = percent == null ? null : Math.round(percent)
  const total = usage ? usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.input_tokens : 0
  const hit = total > 0 ? Math.round((100 * usage.cache_read_input_tokens) / total) : null
  const left = usage && ttlMs != null && sinceMs != null ? ttlMs - sinceMs : null
  const hints = []
  if (ctx != null && ctx >= 80) hints.push('compact soon')
  // The first turn always writes the cache, so a low hit rate there says nothing.
  const cold = hit != null && hit < 50 && turns > 1
  if (cold) hints.push('cache cold')
  if (left != null && left <= 0) hints.push('cache expired')
  const segments = [
    showCtx && ctx != null ? { kind: 'ctx', value: `${ctx}%`, text: `ctx ${ctx}%`, tone: ctx >= 80 ? 'bad' : ctx >= 50 ? 'warn' : 'ok' } : null,
    hit == null ? null : { kind: 'cache', value: `${hit}%`, text: `cache ${hit}%`, tone: cold ? 'bad' : 'ok' },
    left > 0 ? { kind: 'ttl', value: clock(left), text: `ttl ${clock(left)}`, tone: left <= 60_000 ? 'warn' : 'ok' } : null,
    ...hints.map((text) => ({ kind: 'hint', value: text, text, tone: text === 'compact soon' ? 'warn' : 'bad' })),
  ].filter(Boolean)
  const text = segments.map((x) => x.text).join(' · ')
  return { ctx, hit, left, hints, text, segments }
}
