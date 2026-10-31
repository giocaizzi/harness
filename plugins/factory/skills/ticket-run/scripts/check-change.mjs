// Checks a change run's unit brief (.factory/runs/<change>/unit-<attempt>.json), the format in references/change.md.
// Usage `node check-change.mjs <unit.json>`: exit 0 valid, 1 invalid or unreadable (one line per error), 2 usage.
// The CLI also checks `max_attempts` against the cap committed on the default branch (committedCap below).
// Imports Node built-ins and ./check-result.mjs only.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHANGE_TRIGGERS, TICKET, report, show } from './check-result.mjs'

export const UNIT_KEYS = ['unit', 'version', 'run_id', 'change', 'pr', 'issues', 'branch', 'head', 'head_pusher', 'trigger', 'attempt', 'max_attempts', 'items']
export const ITEM_KEYS = ['source', 'kind', 'author', 'role', 'path', 'line', 'text']
export const ITEM_KINDS = ['review', 'review_comment', 'comment', 'check']
export const ROLES = ['approver', 'reviewer', 'check']
export const MAX_ITEMS = 50
export const MAX_TEXT = 4000

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isString = (v) => typeof v === 'string' && v !== ''
const keyErrors = (value, keys, at) => [
  ...keys.filter((k) => !(k in value)).map((k) => `${at}${k}: missing`),
  ...Object.keys(value).filter((k) => !keys.includes(k)).map((k) => `${at}${show(k)}: unknown key`),
]

const itemErrors = (item, i, seen) => {
  const at = `items[${i}]`
  if (!isObject(item)) return [`${at}: must be an object, got ${show(item)}`]
  const errors = keyErrors(item, ITEM_KEYS, `${at}.`)
  if (typeof item.source !== 'string' || !item.source.startsWith('https://')) errors.push(`${at}.source: must be an https:// URL, got ${show(item.source)}`)
  else if (seen.has(item.source)) errors.push(`${at}.source: ${show(item.source)} appears twice`)
  else seen.add(item.source)
  if (!ITEM_KINDS.includes(item.kind)) errors.push(`${at}.kind: must be one of ${ITEM_KINDS.join(', ')}, got ${show(item.kind)}`)
  if (!ROLES.includes(item.role)) errors.push(`${at}.role: must be one of ${ROLES.join(', ')}, got ${show(item.role)}`)
  if ((item.kind === 'check') !== (item.role === 'check')) errors.push(`${at}.role: check exactly for a check item, got kind ${show(item.kind)} and role ${show(item.role)}`)
  if (item.kind === 'check' ? item.author !== null : !isString(item.author)) errors.push(`${at}.author: must be null for a check and a non-empty string otherwise, got ${show(item.author)}`)
  if (item.path !== null && typeof item.path !== 'string') errors.push(`${at}.path: must be a string or null, got ${show(item.path)}`)
  if (item.line !== null && !(Number.isInteger(item.line) && item.line > 0)) errors.push(`${at}.line: must be a positive integer or null, got ${show(item.line)}`)
  else if (item.line !== null && item.path === null) errors.push(`${at}.line: needs a path`)
  if (item.kind !== 'review_comment' && (item.path !== null || item.line !== null)) errors.push(`${at}: path and line must be null unless kind is review_comment, got kind ${show(item.kind)}`)
  if (typeof item.text !== 'string') errors.push(`${at}.text: must be a string, got ${show(item.text)}`)
  else if (item.text.length > MAX_TEXT) errors.push(`${at}.text: ${item.text.length} characters, at most ${MAX_TEXT}`)
  return errors
}

export const unitErrors = (unit) => {
  if (!isObject(unit)) return [`unit must be a JSON object, got ${show(unit)}`]
  const errors = keyErrors(unit, UNIT_KEYS, '')
  if (unit.unit !== 'change_fix') errors.push(`unit: must be "change_fix", got ${show(unit.unit)}`)
  if (unit.version !== 2) errors.push(`version: must be 2, got ${show(unit.version)}`)
  if (!isString(unit.run_id)) errors.push(`run_id: must be a non-empty string, got ${show(unit.run_id)}`)
  const change = typeof unit.change === 'string' && TICKET.test(unit.change) ? unit.change : null
  if (!change) errors.push(`change: must be <owner>/<repo>#<number>, got ${show(unit.change)}`)
  const m = change ? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(change) : null
  const p = typeof unit.pr === 'string' ? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/.exec(unit.pr) : null
  if (!p) errors.push(`pr: must be https://github.com/<owner>/<repo>/pull/<number>, got ${show(unit.pr)}`)
  else if (m && (p[1].toLowerCase() !== m[1].toLowerCase() || p[2].toLowerCase() !== m[2].toLowerCase() || p[3] !== m[3])) errors.push(`pr: ${show(unit.pr)} is not the change ${show(change)}`)
  const { issues } = unit
  if (!Array.isArray(issues) || issues.length === 0 || !issues.every((i) => typeof i === 'string' && TICKET.test(i)) || new Set(issues.map((i) => i.toLowerCase())).size !== issues.length) errors.push(`issues: must be a non-empty array of unique <owner>/<repo>#<number>, got ${show(issues)}`)
  else if (issues.some((i) => i.toLowerCase() === String(unit.change).toLowerCase())) errors.push(`issues: must not include the change ${show(unit.change)}`)
  if (typeof unit.branch !== 'string' || !/^(?!-)[\w.\/-]+$/.test(unit.branch) || unit.branch.includes('..')) errors.push(`branch: must be one plain ref name, got ${show(unit.branch)}`)
  if (typeof unit.head !== 'string' || !/^[0-9a-f]{40}$/.test(unit.head)) errors.push(`head: must be 40 lowercase hex, got ${show(unit.head)}`)
  if (!CHANGE_TRIGGERS.includes(unit.trigger)) errors.push(`trigger: must be one of ${CHANGE_TRIGGERS.join(', ')}, got ${show(unit.trigger)}`)
  const max = unit.max_attempts
  if (!Number.isInteger(max) || max < 1) errors.push(`max_attempts: must be an integer of at least 1, got ${show(max)}`)
  if (!Number.isInteger(unit.attempt) || unit.attempt < 1 || (Number.isInteger(max) && unit.attempt > max)) errors.push(`attempt: must be an integer from 1 to max_attempts, got ${show(unit.attempt)} of ${show(max)}`)
  if (!Array.isArray(unit.items) || unit.items.length < 1 || unit.items.length > MAX_ITEMS) errors.push(`items: must be an array of 1 to ${MAX_ITEMS}, got ${Array.isArray(unit.items) ? unit.items.length : show(unit.items)}`)
  if (Array.isArray(unit.items)) {
    const seen = new Set()
    unit.items.forEach((item, i) => errors.push(...itemErrors(item, i, seen)))
    const items = unit.items.filter(isObject)
    if (unit.trigger === 'check_failed' ? !items.some((i) => i.kind === 'check') : CHANGE_TRIGGERS.includes(unit.trigger) && !items.some((i) => i.role === 'approver')) {
      errors.push(unit.trigger === 'check_failed' ? 'items: a check_failed unit needs at least one check item' : `items: a ${unit.trigger} unit needs at least one approver item`)
    }
  }
  // A failed check is acted on only on a head a factory or approver login pushed, or that an approver's answer on the
  // change allowed (that answer is then an approver comment item).
  const pusher = unit.head_pusher
  if (unit.trigger !== 'check_failed') {
    if ('head_pusher' in unit && pusher !== null) errors.push(`head_pusher: must be null unless trigger is check_failed, got ${show(pusher)}`)
  } else if (pusher === null) {
    if (!(Array.isArray(unit.items) && unit.items.some((i) => isObject(i) && i.role === 'approver' && i.kind === 'comment'))) errors.push("head_pusher: a check_failed unit needs the factory or approver login that pushed head, or an approver's answer as a comment item")
  } else if (pusher !== undefined && !(isString(pusher) && pusher.trim() === pusher)) errors.push(`head_pusher: must be a login or null, got ${show(pusher)}`)
  return errors
}

// `change_requests.max_attempts` from a config text, in the plain YAML the template uses; absent, the default.
export const DEFAULT_MAX_ATTEMPTS = 3
export const parseCap = (text) => {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const at = lines.findIndex((l) => /^change_requests:/.test(l))
  if (at === -1) return DEFAULT_MAX_ATTEMPTS
  if (!/^change_requests:\s*(?:#.*)?$/.test(lines[at])) throw new Error('change_requests must be a block mapping')
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line) && !/^#/.test(line)) break
    const m = /^\s+max_attempts:\s*(.*?)\s*(?:#.*)?$/.exec(line)
    if (!m) continue
    if (!/^[1-9]\d{0,3}$/.test(m[1])) throw new Error(`change_requests.max_attempts must be a whole number from 1, got ${show(m[1])}`)
    return Number(m[1])
  }
  return DEFAULT_MAX_ATTEMPTS
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

// The cap as committed on the default branch (origin/HEAD), never the checkout's copy: a change run works the change's
// branch, where a session could raise it. No config file there: the default; a ref or file that cannot be read throws.
export const committedCap = (run = git) => {
  const ref = run(['rev-parse', '--abbrev-ref', 'origin/HEAD']).trim()
  if (!/^origin\/\S+$/.test(ref) || ref === 'origin/HEAD') throw new Error(`origin/HEAD is ${show(ref)}, not a remote branch`)
  if (run(['ls-tree', '--name-only', ref, '--', '.factory/config.yaml']).trim() === '') return DEFAULT_MAX_ATTEMPTS
  return parseCap(run(['show', `${ref}:.factory/config.yaml`]))
}

export const capErrors = (unit, cap) =>
  isObject(unit) && Number.isInteger(unit.max_attempts) && unit.max_attempts !== cap ? [`max_attempts: ${unit.max_attempts} is not the cap committed on the default branch, ${cap}`] : []

// Exit code, not process.exit: an exit mid-pipe can cut stderr short.
const main = (args) => {
  const [file] = args
  if (!file || args.length > 1) {
    console.error('usage: node check-change.mjs <unit.json>')
    return 2
  }
  let unit
  try {
    unit = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'no such file' : e instanceof SyntaxError ? `not valid JSON (${e.message})` : `cannot read (${e.code ?? e.message})`
    for (const line of report([`${file}: ${why}`])) console.error(line)
    return 1
  }
  const errors = unitErrors(unit)
  try {
    errors.push(...capErrors(unit, committedCap()))
  } catch (e) {
    const why = String(e.stderr ?? '').trim().split('\n')[0] || e.message
    errors.push(`max_attempts: cannot read the cap committed on the default branch (${why}): fetch the default branch and set origin/HEAD (git remote set-head origin --auto)`)
  }
  for (const line of report(errors)) console.error(line)
  return errors.length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
