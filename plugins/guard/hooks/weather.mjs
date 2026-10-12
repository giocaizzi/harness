// Token weather facts, free of engine imports so node can test them. Pure: facts in, one display line out.
// percent: context fullness; usage: the last main-loop turn's token counts; turns: main-loop turns since the
// session (or /clear) began; ttlMs / sinceMs: the prompt-cache TTL and the time since that turn ended.
export const TTL_MS = { '5m': 300_000, '1h': 3_600_000 }

export const clock = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

const BLOCKS = '▁▂▃▄▅▆▇█'

// One single-width glyph for how full the context is.
export const glyph = (ctx) => (ctx == null ? '' : ctx < 25 ? '☀' : ctx < 50 ? '☁' : ctx < 75 ? '☂' : ctx < 90 ? '☇' : '↯')

// Cells of a bar chart, row-major [codePoint, color, background] triplets, one column per value (0-100), the
// tallest bar filling `rows`. Colours are 0xRRGGBB by how full the value is; 0x01000000 is the default background.
export const TONE_RGB = { ok: 0xa6e3a1, warn: 0xf9e2af, bad: 0xf38ba8 }
export function sparkCells(values, rows) {
  const out = []
  for (let r = 0; r < rows; r++) {
    for (const v of values) {
      const eighths = Math.round((Math.min(100, Math.max(0, v)) / 100) * rows * 8) - (rows - 1 - r) * 8
      const level = Math.min(8, Math.max(0, eighths))
      out.push(level ? BLOCKS.codePointAt(level - 1) : 32, v >= 80 ? TONE_RGB.bad : v >= 50 ? TONE_RGB.warn : TONE_RGB.ok, 0x01000000)
    }
  }
  return out
}

// showCtx false leaves the context % out of `text` and `segments` (the Claude status line already shows it);
// `segments` are the same parts with a tone (ok | warn | bad) for a drawing to colour.
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
    showCtx && ctx != null ? { text: `ctx ${ctx}%`, tone: ctx >= 80 ? 'bad' : ctx >= 50 ? 'warn' : 'ok' } : null,
    hit == null ? null : { text: `cache ${hit}%`, tone: cold ? 'bad' : 'ok' },
    left > 0 ? { text: `ttl ${clock(left)}`, tone: left <= 60_000 ? 'warn' : 'ok' } : null,
    ...hints.map((text) => ({ text, tone: text === 'compact soon' ? 'warn' : 'bad' })),
  ].filter(Boolean)
  const text = segments.map((x) => x.text).join(' · ')
  return { ctx, hit, left, hints, text, segments }
}
