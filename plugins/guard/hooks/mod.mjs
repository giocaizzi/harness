// Claude Code mod (hooks.json `modules`; Copilot ignores the key): the usage throttle and the ask timeout.
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

// Permission asks deny after this long without an answer, so an unattended session never waits forever.
export const ASK_TIMEOUT_MS = 60_000
// Tools whose own dialog is the question (askUserQuestionTimeout covers AskUserQuestion); left to the engine.
const PERSON_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
// The session's permission mode, as the last classic hook input carried it. ponytail: a mode switched with
// shift+tab is seen at the next prompt or tool result, so one ask in between can go the old way.
let mode

function trackMode($, e, next) {
  mode = e.permission_mode ?? mode
  return next(e)
}

const summary =(input) => String(input?.command ?? input?.file_path ?? input?.url ?? input?.pattern ?? '').slice(0, 500)

// Puts the ask in the plugin's own dialog and denies when nobody answers within ASK_TIMEOUT_MS.
async function askWithTimeout($, e, reason) {
  let expire
  const timedOut = new Promise((resolve) => (expire = resolve))
  const timer = $.clock.after(ASK_TIMEOUT_MS, () => expire('timeout'))
  const asked = $.ui.ask(`Allow ${e.tool}? ${summary(e.input)}\n${reason ?? ''}\nDenied after ${ASK_TIMEOUT_MS / 1000} s without an answer.`, ['Allow', 'Deny']).catch(() => 'Deny')
  const answer = await Promise.race([asked, timedOut])
  timer.cancel()
  if (answer === 'Allow') return { decision: 'allow', reason: 'allowed in the guard dialog' }
  if (answer === 'timeout') return { decision: 'deny', reason: `The user isn't there: nobody answered the permission prompt in ${ASK_TIMEOUT_MS / 1000} seconds, so ${e.tool} was not run. Carry on without it, or leave it for the user.` }
  return { decision: 'deny', reason: `The user denied this ${e.tool} call.` }
}

export function register(on) {
  on('classic.UserPromptSubmit', trackMode)
  on('classic.PostToolUse', trackMode)

  // Ask timeout: a dialog nobody answers would hold the session forever. Only a real call whose ask reaches the
  // person: auto mode's own asks go to its classifier, a hosted session's to its host. Fails to the engine's dialog.
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision !== 'ask' || !e.tool_use_id || r.decider || PERSON_TOOLS.has(e.tool)) return r
    if (mode === 'auto' && !r.hook) return r
    return askWithTimeout($, e, r.reason)
  }).catch(($, e, next) => next(e))

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
