// Checks a run's result.json: `finished_at` and `phases` times, the optional `routing` entries and `mode` (only `dev`).
// Usage `node check-result.mjs <result.json>`. A deviation (model or effort differing from the policy's) needs a non-empty
// deviation_reason; a time the run could not find is null, never a dropped key.
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

const TICKET = /^[\w.-]+\/[\w.-]+#\d+$/

// `ticket` is the string owner/repo#N; when FACTORY_TICKET is set it must equal it.
export const ticketErrors = (result, expected = process.env.FACTORY_TICKET) => {
  if (typeof result.ticket !== 'string' || !TICKET.test(result.ticket)) return [`ticket must be a string of the form "<owner>/<repo>#<number>", got ${JSON.stringify(result.ticket)}`]
  const want = (expected ?? '').trim()
  return want && result.ticket.trim() !== want ? [`ticket "${result.ticket}" differs from FACTORY_TICKET "${want}"`] : []
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const errors = [...timeErrors(result), ...routingErrors(result), ...modeErrors(result), ...ticketErrors(result)]
  for (const e of errors) console.error(e)
  process.exit(errors.length ? 1 : 0)
}
