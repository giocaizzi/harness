// Claude Code mod (hooks.json `modules`; Copilot ignores the key): the usage throttle.
// The command guards run as command hooks for both harnesses; this holds only what needs the mods API.
import { evaluateSpawn } from '../core/engine.mjs'
import { logRequest } from '../core/otel.mjs'
import { rules } from '../core/rules.mjs'

// The window closest to its limit (a gateway spend limit is not a plan window).
const worstWindow = (limits) => limits.filter((r) => r.kind !== 'spend_limit').sort((a, b) => b.percentUsed - a.percentUsed)[0]

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
