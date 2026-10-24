// Claude Code mod (hooks.json `modules`; Copilot ignores the key): the usage throttle and the ask timeout.
// The command guards run as command hooks for both harnesses; this holds only what needs the mods API.
import { cmdClass, evaluateSpawn } from '../core/engine.mjs'
import { logRequest, otelOff, repoSlug } from '../core/otel.mjs'
import { rules } from '../core/rules.mjs'

// The window closest to its limit (a gateway spend limit is not a plan window).
const worstWindow = (limits) => limits.filter((r) => r.kind !== 'spend_limit').sort((a, b) => b.percentUsed - a.percentUsed)[0]

// The OTel export settings: each OTEL_* variable, else its GUARD_-prefixed copy, as for the command hooks
// (core/otel.mjs); null when GUARD_OTEL=off.
async function otelConfig($) {
  if (otelOff({ GUARD_OTEL: await $.env.get('GUARD_OTEL') })) return null
  return {
    endpoint: (await $.env.get('OTEL_EXPORTER_OTLP_ENDPOINT')) || (await $.env.get('GUARD_OTEL_EXPORTER_OTLP_ENDPOINT')),
    headers: (await $.env.get('OTEL_EXPORTER_OTLP_HEADERS')) || (await $.env.get('GUARD_OTEL_EXPORTER_OTLP_HEADERS')),
    resource: (await $.env.get('OTEL_RESOURCE_ATTRIBUTES')) || (await $.env.get('GUARD_OTEL_RESOURCE_ATTRIBUTES')),
  }
}

// The installed guard's version (read once per load) and the session repo's `owner/name` (its `origin` remote, else the
// first remote, as the command hooks read it; once per working directory), null where unreadable. Never throws.
const attempt = async (f) => {
  try {
    return await f()
  } catch {
    return null
  }
}
let version
const repos = new Map()
async function whereAttrs($) {
  version ??= attempt(async () => JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)).version ?? null)
  const cwd = (await attempt(() => $.session.cwd())) ?? ''
  if (!repos.has(cwd)) {
    const git = async (...args) => {
      const r = await $.process.run(['git', ...args], { timeoutMs: 2000, ...(cwd ? { cwd } : {}) })
      return r.exitCode === 0 ? r.stdout.trim() : null
    }
    repos.set(cwd, attempt(async () => {
      const first = async () => {
        const name = (await git('remote'))?.split(/\r?\n/)[0]
        return name ? git('remote', 'get-url', name) : null
      }
      return repoSlug((await git('remote', 'get-url', 'origin')) ?? (await first()))
    }))
  }
  return { guard_version: await version, repo: await repos.get(cwd) }
}

// One guard record to the OTel collector, when the session exports to one; never fails the caller.
async function emitRecord($, event, attrs) {
  try {
    const config = await otelConfig($)
    const req = config && logRequest(config, event, { ...attrs, harness: 'claude', ...(await whereAttrs($)) })
    if (req) await $.http.fetch(req.url, { method: 'POST', headers: req.headers, body: req.body })
  } catch {
    // collector unreachable: the decision stands
  }
}

const emitThrottle = ($, w) => emitRecord($, 'guard.throttle', { action: 'deny', rule: 'usage-throttle', cmd_class: 'spawn', window: w?.kind, percent: w?.percentUsed })
// The class of an asked call: its shell command's, else `tool`.
const askClass = (e) => (typeof e.input?.command === 'string' ? cmdClass(null, e.input.command) : 'tool')

// Permission asks are parked (denied, with "no answer, carry on") after this long without an answer, in every mode:
// the user may be working elsewhere, so a session never waits on a dialog. GUARD_ASK_TIMEOUT_MS overrides it; 0 turns
// it off (the engine's dialog waits for an answer).
export const ASK_TIMEOUT_MS = 60_000
// Tools whose own dialog is the question (askUserQuestionTimeout covers AskUserQuestion); left to the engine.
const PERSON_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
// The session's permission mode, as the last classic hook input carried it. ponytail: a mode switched with
// shift+tab is seen at the next prompt or tool result, so one ask in between can go the old way. SessionStart carries
// no `permission_mode` (Claude Code 2.1.310), so before the first prompt or tool result the mode is unknown.
let mode

function trackMode($, e, next) {
  mode = e.permission_mode ?? mode
  return next(e)
}

const summary = (input) => String(input?.command ?? input?.file_path ?? input?.url ?? input?.pattern ?? '').slice(0, 500)

// GUARD_ASK_TIMEOUT_MS when it is a whole number of ms >= 0, else the default; unreadable env: the default.
async function askTimeoutMs($) {
  try {
    const v = await $.env.get('GUARD_ASK_TIMEOUT_MS')
    return /^\d+$/.test(v ?? '') ? Number(v) : ASK_TIMEOUT_MS
  } catch {
    return ASK_TIMEOUT_MS
  }
}

// GUARD_UNATTENDED in the environment Claude Code was launched with: nobody is there to answer, so an ask is parked at
// once instead of after the timeout. Only the environment: a switch a command set lives in the command hooks' state.
async function unattendedEnv($) {
  try {
    return /^(1|true|on)$/i.test((await $.env.get('GUARD_UNATTENDED')) ?? '')
  } catch {
    return false
  }
}

// What the agent is told when nobody answered: the user may be busy elsewhere, so the call is parked, not refused.
// It names the call, not the tool: "Bash was not run" read as "Bash is unavailable", and an agent gave up the task.
const noAnswer = (input, why) => {
  const call = summary(input).slice(0, 120)
  return `No answer: ${why}, so this call${call ? ` (${call})` : ''} was not run; other calls still run. This is not a refusal. Carry on with the rest of the task without it, or park it: say in your report that it is waiting for the user's approval.`
}

// Puts the ask in the plugin's own dialog and denies when nobody answers within `ms`. Every outcome is reported as
// guard.ask_result (allow, deny, timeout, unavailable) with how long it waited.
async function askWithTimeout($, e, reason, ms) {
  const started = await $.clock.now().catch(() => NaN)
  let expire
  const timedOut = new Promise((resolve) => (expire = resolve))
  const timer = $.clock.after(ms, () => expire('timeout'))
  // A dialog that cannot show (headless, a host without one) or is dismissed rejects: nobody answered.
  const asked = $.ui.ask(`Allow ${e.tool}? ${summary(e.input)}\n${reason ?? ''}\nParked after ${ms / 1000} s without an answer.`, ['Allow', 'Deny']).catch(() => 'unavailable')
  const answer = await Promise.race([asked, timedOut])
  timer.cancel()
  const result = answer === 'Allow' ? 'allow' : answer === 'Deny' ? 'deny' : answer
  const waited = (await $.clock.now().catch(() => NaN)) - started
  // Not awaited: a slow collector never delays the decision.
  void emitRecord($, 'guard.ask_result', { result, wait_ms: Number.isFinite(waited) ? waited : undefined, tool: e.tool, cmd_class: askClass(e), tool_use_id: e.tool_use_id })
  if (result === 'allow') return { decision: 'allow', reason: 'allowed in the guard dialog' }
  if (result === 'timeout') return { decision: 'deny', reason: noAnswer(e.input, `nobody answered the permission prompt within ${ms / 1000} seconds`) }
  if (result === 'unavailable') return { decision: 'deny', reason: noAnswer(e.input, 'the permission prompt could not be shown or was dismissed') }
  return { decision: 'deny', reason: `The user denied this ${e.tool} call. Do not retry it or a respelling of it; ask the user what they want instead.` }
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
    // dontAsk denies anything not pre-approved itself; there is no one to ask.
    if (mode === 'dontAsk') return r
    if (await unattendedEnv($)) {
      void emitRecord($, 'guard.ask_result', { result: 'unavailable', via: 'unattended', wait_ms: 0, tool: e.tool, cmd_class: askClass(e), tool_use_id: e.tool_use_id })
      return { decision: 'deny', reason: noAnswer(e.input, 'this is an unattended run (GUARD_UNATTENDED), so nobody can answer the permission prompt') }
    }
    const ms = await askTimeoutMs($)
    return ms ? askWithTimeout($, e, r.reason, ms) : r
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
