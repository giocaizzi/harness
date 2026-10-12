// Token weather facts, free of engine imports so node can test them. Pure: facts in, one display line out.
// percent: context fullness; usage: the last main-loop turn's token counts; turns: main-loop turns since the
// session (or /clear) began; ttlMs / sinceMs: the prompt-cache TTL and the time since that turn ended.
export const TTL_MS = { '5m': 300_000, '1h': 3_600_000 }

const clock = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

export function forecast({ percent, usage, turns = 0, ttlMs, sinceMs }) {
  const ctx = percent == null ? null : Math.round(percent)
  const total = usage ? usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.input_tokens : 0
  const hit = total > 0 ? Math.round((100 * usage.cache_read_input_tokens) / total) : null
  const left = usage && ttlMs != null && sinceMs != null ? ttlMs - sinceMs : null
  const hints = []
  if (ctx != null && ctx >= 80) hints.push('compact soon')
  // The first turn always writes the cache, so a low hit rate there says nothing.
  if (hit != null && hit < 50 && turns > 1) hints.push('cache cold')
  if (left != null && left <= 0) hints.push('cache expired')
  const parts = [ctx == null ? null : `ctx ${ctx}%`, hit == null ? null : `cache ${hit}%`, left > 0 ? `ttl ${clock(left)}` : null]
  const text = [...parts, ...hints].filter(Boolean).join(' · ')
  return { ctx, hit, left, hints, text }
}
