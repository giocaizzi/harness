// Checks the optional `routing` entries and `mode` (only `dev`) of a run's result.json: usage `node check-result.mjs <result.json>`.
// A deviation (model or effort differing from the policy's) needs a non-empty deviation_reason.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const fields = ['phase', 'policy_model', 'policy_effort', 'model', 'effort']

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
  const errors = [...routingErrors(result), ...modeErrors(result)]
  for (const e of errors) console.error(e)
  process.exit(errors.length ? 1 : 0)
}
