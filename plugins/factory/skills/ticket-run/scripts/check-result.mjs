// Checks a run's result.json: the core fields (`schema`, `ticket`, `run_id`, `end_state`, `reason`, `reason_code`),
// `finished_at` and `phases` times, the optional `routing` entries and `mode` (only `dev`).
// Usage `node check-result.mjs <result.json>`: exit 0 valid, 1 invalid or unreadable (one line per error), 2 usage.
// A deviation (model or effort differing from the policy's) needs a non-empty deviation_reason; a time the run could not
// find is null, never a dropped key. Imports Node built-ins only, so a hook can copy it.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const fields = ['phase', 'policy_model', 'policy_effort', 'model', 'effort']

const STEPS = ['gate', 'plan', 'work', 'verify', 'ship', 'deploy', 'record']
const ISO = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
// Date.parse rolls an impossible day over (2026-02-30 → 03-02): the date must round-trip unchanged.
const isTime = (v) =>
  typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v)) && new Date(`${v.slice(0, 10)}T00:00:00Z`).toISOString().startsWith(v.slice(0, 10))

export const timeErrors = (result) => {
  const errors = isTime(result.finished_at) ? [] : ['finished_at must be an ISO 8601 time']
  if (!Array.isArray(result.phases) || result.phases.length === 0) return [...errors, 'phases must list every step the run reached']
  let last = -1
  result.phases.forEach((p, i) => {
    const at = `phases[${i}]`
    if (p === null || typeof p !== 'object' || Array.isArray(p)) return errors.push(`${at}: must be an object with name, started_at and ended_at`)
    const step = STEPS.indexOf(p.name)
    if (step <= last) errors.push(`${at}: name must be one of ${STEPS.join(', ')}, in that order, each once`)
    last = Math.max(last, step)
    for (const key of ['started_at', 'ended_at']) {
      if (!(key in p)) errors.push(`${at}: ${key} missing (write null when unknown)`)
      else if (p[key] !== null && !isTime(p[key])) errors.push(`${at}: ${key} must be an ISO 8601 time or null`)
    }
    if (isTime(p.started_at) && isTime(p.ended_at) && Date.parse(p.ended_at) < Date.parse(p.started_at)) errors.push(`${at}: ended_at is before started_at`)
  })
  return errors
}

export const TICKET = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/

// `ticket` is the string owner/repo#N; when FACTORY_TICKET is set it must equal it.
export const ticketErrors = (result, expected = process.env.FACTORY_TICKET) => {
  if (typeof result.ticket !== 'string' || !TICKET.test(result.ticket)) return [`ticket must be a string of the form "<owner>/<repo>#<number>", got ${JSON.stringify(result.ticket)}`]
  const want = (expected ?? '').trim()
  return want && result.ticket !== want ? [`ticket "${result.ticket}" differs from FACTORY_TICKET "${want}"`] : []
}

export const modeErrors = (result) => (result.mode === undefined || result.mode === 'dev' ? [] : ['mode must be "dev" or absent'])

export const routingErrors = (result) => {
  if (result.routing === undefined) return []
  if (!Array.isArray(result.routing)) return ['routing must be an array']
  return result.routing.flatMap((entry, i) => {
    const at = `routing[${i}]`
    const missing = fields.filter((f) => typeof entry?.[f] !== 'string' || entry[f] === '')
    if (missing.length) return [`${at}: missing ${missing.join(', ')}`]
    const reason = entry.deviation_reason
    const deviates = entry.model !== entry.policy_model || entry.effort !== entry.policy_effort
    if (deviates && (typeof reason !== 'string' || reason.trim() === '')) return [`${at} (${entry.phase}): deviates from the policy without a deviation_reason`]
    if (reason !== null && reason !== undefined && typeof reason !== 'string') return [`${at}: deviation_reason must be a string or null`]
    return []
  })
}

export const END_STATES = ['done', 'parked', 'failed', 'budget_reached', 'halted']
export const REASON_CODES = ['question', 'plan_gate', 'merge_gate', 'grooming', 'verify_rounds', 'live_verify_failed', 'env_blocked', 'budget', 'auth', 'takeover']

// `run_id` equals FACTORY_RUN_ID when set, so the result matches the runtime's claim.
export const coreErrors = (result, env = process.env) => {
  const errors = []
  if (result.schema !== 2) errors.push(`schema must be 2, got ${JSON.stringify(result.schema)}`)
  const want = (env.FACTORY_RUN_ID ?? '').trim()
  if (typeof result.run_id !== 'string' || result.run_id.trim() === '') errors.push(`run_id must be a non-empty string, got ${JSON.stringify(result.run_id)}`)
  else if (want && result.run_id !== want) errors.push(`run_id "${result.run_id}" differs from FACTORY_RUN_ID "${want}"`)
  if (!END_STATES.includes(result.end_state)) errors.push(`end_state must be one of ${END_STATES.join(', ')}, got ${JSON.stringify(result.end_state)}`)
  if (typeof result.reason !== 'string') errors.push(`reason must be a string (empty when done), got ${JSON.stringify(result.reason)}`)
  if (result.reason_code !== null && !REASON_CODES.includes(result.reason_code)) errors.push(`reason_code must be null or one of ${REASON_CODES.join(', ')}, got ${JSON.stringify(result.reason_code)}`)
  return errors
}

// Every check, in one list; a value that is not a JSON object is one error, never a throw.
export const resultErrors = (result, env = process.env) => {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return [`result.json must hold a JSON object, got ${JSON.stringify(result)}`]
  return [...coreErrors(result, env), ...ticketErrors(result, env.FACTORY_TICKET ?? ''), ...timeErrors(result), ...routingErrors(result), ...modeErrors(result)]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2]
  if (!file || process.argv.length > 3) {
    console.error('usage: node check-result.mjs <result.json>')
    process.exit(2)
  }
  let result
  try {
    result = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    console.error(e.code === 'ENOENT' ? `${file}: no such file` : e instanceof SyntaxError ? `${file}: not valid JSON (${e.message})` : `${file}: cannot read (${e.code ?? e.message})`)
    process.exit(1)
  }
  const errors = resultErrors(result)
  for (const e of errors) console.error(e)
  process.exit(errors.length ? 1 : 0)
}
