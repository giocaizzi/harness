// Checks a group run's member handoffs (references/group.md): the member brief the run writes and the member result the
// member hands back, and turns them into the member's entry of result.json's `tasks`.
// Usage `node check-handoff.mjs brief <brief.json>` or `node check-handoff.mjs result <brief.json> <result.json>` (checks
// the brief too): exit 0 valid, 1 invalid or unreadable (one line per error), 2 usage.
// Imports Node built-ins and ./check-result.mjs only.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REASON_CODES, TICKET, report, show } from './check-result.mjs'

export const BRIEF_KEYS = ['handoff', 'version', 'run_id', 'ticket', 'worktree', 'branch', 'base', 'brief']
export const RESULT_KEYS = ['handoff', 'version', 'run_id', 'ticket', 'outcome', 'reason', 'reason_code', 'branch', 'head', 'checks']

const SHA = /^[0-9a-f]{40}$/
const REF = /^(?!-)[\w.\/-]+$/
const OUTCOMES = ['done', 'parked', 'released']
const CHECK_RESULTS = ['pass', 'fail', 'not_run']
// `handoff` is the park code of a malformed handoff; this does not depend on REASON_CODES holding it.
const PARK_CODES = [...new Set([...REASON_CODES, 'handoff'])]

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isText = (v) => typeof v === 'string' && v.trim() !== ''

const keyErrors = (obj, keys) => [
  ...keys.filter((k) => !(k in obj)).map((k) => `missing key ${k}`),
  ...Object.keys(obj).filter((k) => !keys.includes(k)).map((k) => `unknown key ${show(k)}`),
]

export const briefErrors = (brief) => {
  if (!isObject(brief)) return [`brief must be a JSON object, got ${show(brief)}`]
  const errors = keyErrors(brief, BRIEF_KEYS)
  const bad = (key, want) => key in brief && errors.push(`${key} must be ${want}, got ${show(brief[key])}`)
  if (brief.handoff !== 'member_brief') bad('handoff', '"member_brief"')
  if (brief.version !== 1) bad('version', '1')
  if (!isText(brief.run_id)) bad('run_id', 'a non-empty string')
  if (typeof brief.ticket !== 'string' || !TICKET.test(brief.ticket)) bad('ticket', 'of the form "<owner>/<repo>#<number>"')
  if (typeof brief.worktree !== 'string' || !(path.posix.isAbsolute(brief.worktree) || path.win32.isAbsolute(brief.worktree))) bad('worktree', 'an absolute path')
  if (typeof brief.branch !== 'string' || !REF.test(brief.branch) || brief.branch.includes('..')) bad('branch', 'one plain ref name')
  if (typeof brief.base !== 'string' || !SHA.test(brief.base)) bad('base', 'a 40-hex commit')
  if (!isText(brief.brief)) bad('brief', 'a non-empty string')
  return errors
}

const checkErrors = (checks) => {
  if (!Array.isArray(checks)) return [`checks must be an array, got ${show(checks)}`]
  return checks.flatMap((c, i) => {
    const at = `checks[${i}]`
    if (!isObject(c)) return [`${at}: must be an object with command and result`]
    const errors = [
      ...['command', 'result'].filter((k) => !(k in c)).map((k) => `${at}: missing key ${k}`),
      ...Object.keys(c).filter((k) => !['command', 'result', 'note'].includes(k)).map((k) => `${at}: unknown key ${show(k)}`),
    ]
    if ('command' in c && !isText(c.command)) errors.push(`${at}: command must be a non-empty string`)
    if ('result' in c && !CHECK_RESULTS.includes(c.result)) errors.push(`${at}: result must be one of ${CHECK_RESULTS.join(', ')}, got ${show(c.result)}`)
    if (c.result === 'not_run' && !isText(c.note)) errors.push(`${at}: a not_run check needs a non-empty note`)
    if ('note' in c && typeof c.note !== 'string') errors.push(`${at}: note must be a string`)
    return errors
  })
}

export const memberResultErrors = (result, brief) => {
  if (!isObject(result)) return [`result must be a JSON object, got ${show(result)}`]
  const errors = keyErrors(result, RESULT_KEYS)
  const bad = (key, want) => key in result && errors.push(`${key} must be ${want}, got ${show(result[key])}`)
  if (result.handoff !== 'member_result') bad('handoff', '"member_result"')
  if (result.version !== 1) bad('version', '1')
  if (isObject(brief)) {
    for (const key of ['run_id', 'ticket', 'branch']) if (key in result && result[key] !== brief[key]) errors.push(`${key} ${show(result[key])} differs from the brief's ${show(brief[key])}`)
  }
  if (!OUTCOMES.includes(result.outcome)) bad('outcome', `one of ${OUTCOMES.join(', ')}`)
  const { outcome } = result
  if (outcome === 'done') {
    if (result.reason !== '') bad('reason', 'empty when done')
    if (result.reason_code !== null) bad('reason_code', 'null when done')
    if (typeof result.head !== 'string' || !SHA.test(result.head)) bad('head', 'a 40-hex commit when done')
    if (Array.isArray(result.checks) && result.checks.some((c) => c?.result === 'fail')) errors.push('a done member has a failing check')
  } else if (OUTCOMES.includes(outcome)) {
    if (!isText(result.reason)) bad('reason', `non-empty when ${outcome}`)
    if (outcome === 'parked' && !PARK_CODES.includes(result.reason_code)) bad('reason_code', `one of ${PARK_CODES.join(', ')} when parked`)
    if (outcome === 'released' && result.reason_code !== null && !PARK_CODES.includes(result.reason_code)) bad('reason_code', 'null or one of the codes when released')
    if (result.head !== null && (typeof result.head !== 'string' || !SHA.test(result.head))) bad('head', 'a 40-hex commit or null when not done')
  }
  if ('checks' in result) errors.push(...checkErrors(result.checks))
  return errors
}

// The result.json task entry of one member; the run sets pr_link once it knows the PR. `ticket` comes from the group's
// list, never from the files. A result of undefined means the member returned no JSON.
export const memberTask = (ticket, brief, result) => {
  const errors = [...briefErrors(brief), ...(result === undefined ? ['no member result'] : memberResultErrors(result, brief))]
  if (errors.length) return { ticket, outcome: 'parked', reason: `malformed handoff: ${errors[0]}`.slice(0, 300), reason_code: 'handoff', pr_link: null }
  return { ticket, outcome: result.outcome, reason: result.reason, reason_code: result.reason_code, pr_link: null }
}

const load = (file) => {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) }
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'no such file' : e instanceof SyntaxError ? `not valid JSON (${e.message})` : `cannot read (${e.code ?? e.message})`
    return { errors: [`${file}: ${why}`] }
  }
}

// Exit code, not process.exit: an exit mid-pipe can cut stderr short.
const main = (args) => {
  const [mode, ...files] = args
  if (!((mode === 'brief' && files.length === 1) || (mode === 'result' && files.length === 2))) {
    console.error('usage: node check-handoff.mjs brief <brief.json> | node check-handoff.mjs result <brief.json> <result.json>')
    return 2
  }
  const loaded = files.map(load)
  const errors = loaded.some((l) => l.errors)
    ? loaded.flatMap((l) => l.errors ?? [])
    : mode === 'brief'
      ? briefErrors(loaded[0].value)
      : [...briefErrors(loaded[0].value), ...memberResultErrors(loaded[1].value, loaded[0].value)]
  for (const line of report(errors)) console.error(line)
  return errors.length ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
