// Writes a run's .factory/runs/<n>/result.json from the judgment fields the run decided, filling the fields it can know
// (schema, ticket, run_id, finished_at, mode, host name and os) and checking the whole file before writing it.
// Usage:
//   node write-result.mjs [--ticket <owner>/<repo>#<n>] [--run-id <id>] <input.json|->   write the result
//   node write-result.mjs [--ticket <owner>/<repo>#<n>] --post <kind>=<url>             add a posted comment, keep finished_at
// Exit 0 written (its path on stdout), 1 invalid (errors on stderr, nothing written), 2 usage or environment.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TICKET, report, resultErrors, show } from './check-result.mjs'

// The keys the run decides, in the contract's order; `host` may carry only `runner`.
export const JUDGMENT = ['end_state', 'reason', 'reason_code', 'pr', 'tasks', 'change', 'decisions', 'evidence', 'checks', 'follow_ups', 'posts', 'phases', 'verifier', 'routing', 'cost_usd', 'tokens', 'turns', 'harness', 'model', 'effort', 'sessions', 'plugin_versions', 'host']
export const OWNED = ['schema', 'ticket', 'run_id', 'mode', 'finished_at']
const ORDER = ['schema', 'ticket', 'run_id', ...JUDGMENT.slice(0, 14), 'mode', ...JUDGMENT.slice(14), 'finished_at']
const RUNNERS = ['attended', 'headless', 'runtime']
// A session or claim id: no control or format characters (newlines included), no surrounding spaces, at most 128.
const RUN_ID = /^(?=.{1,128}$)[^\p{C}\s](?:[^\p{C}]*[^\p{C}\s])?$/u

export class UsageError extends Error {}

const cut = (key) => (key.length > 200 ? `${key.slice(0, 200)}…` : key)

const utcNow = (now) => now.toISOString().replace(/\.\d{3}Z$/, 'Z')
export const hostOs = (platform) => (platform === 'win32' ? 'windows' : platform)

// Ticket: FACTORY_TICKET (a runtime's, which a differing --ticket contradicts), else --ticket, else FACTORY_ATTENDED_TICKET.
export const resolveTicket = (env, ticketArg) => {
  const runtime = (env.FACTORY_TICKET ?? '').trim()
  const ticket = runtime || ticketArg || (env.FACTORY_ATTENDED_TICKET ?? '').trim()
  if (runtime && ticketArg && ticketArg !== runtime) throw new UsageError(`--ticket ${show(ticketArg)} differs from FACTORY_TICKET ${show(runtime)}`)
  if (!ticket) throw new UsageError('no ticket: FACTORY_TICKET and FACTORY_ATTENDED_TICKET are unset, so pass --ticket <owner>/<repo>#<n>')
  if (!TICKET.test(ticket)) throw new UsageError(`ticket must be <owner>/<repo>#<number>, got ${show(ticket)}`)
  return ticket
}

// run_id: FACTORY_RUN_ID; else FACTORY_ATTENDED_RUN_ID when the launcher was started for this ticket; else --run-id
// (the main session's id); else <host>-<n>-<UTC timestamp>.
export const resolveRunId = ({ env, ticket, runIdArg, host, now, warn }) => {
  const runtime = (env.FACTORY_RUN_ID ?? '').trim()
  const attendedTicket = (env.FACTORY_ATTENDED_TICKET ?? '').trim()
  const attendedId = (env.FACTORY_ATTENDED_RUN_ID ?? '').trim()
  let id = runtime
  if (!id && attendedTicket) {
    if (attendedTicket.toLowerCase() === ticket.toLowerCase()) id = attendedId
    else warn(`FACTORY_ATTENDED_TICKET is ${show(attendedTicket)}, not ${ticket}: this session's telemetry is tagged for that ticket, so its run id is not used; tell the person`)
  }
  if (id && runIdArg && runIdArg !== id) warn(`--run-id ${runIdArg} ignored: ${runtime ? 'FACTORY_RUN_ID' : 'FACTORY_ATTENDED_RUN_ID'} gives ${id}`)
  return id || runIdArg || `${host.split('.')[0]}-${ticket.split('#')[1]}-${utcNow(now).replace(/[-:]/g, '')}`
}

// The input's own errors: owned or unknown keys, and what only a runtime writes.
export const inputErrors = (input, env = {}) => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return ['the input must be a JSON object of the judgment fields']
  const errors = []
  for (const key of Object.keys(input)) {
    if (OWNED.includes(key)) errors.push(`${key}: filled by this script, remove it from the input`)
    else if (!JUDGMENT.includes(key)) errors.push(`${cut(key)}: not a result key the run writes (allowed: ${JUDGMENT.join(', ')})`)
  }
  if (input.host !== undefined) {
    if (input.host === null || typeof input.host !== 'object' || Array.isArray(input.host)) errors.push('host must be an object holding only runner')
    else {
      for (const key of Object.keys(input.host)) if (key !== 'runner') errors.push(`host.${cut(key)}: filled by this script, remove it from the input`)
      const runtime = (env.FACTORY_RUN_ID ?? '').trim() !== ''
      const runner = input.host.runner
      if ('runner' in input.host && !RUNNERS.includes(runner)) errors.push(`host.runner must be one of ${RUNNERS.join(', ')}`)
      else if (runner === 'runtime' && !runtime) errors.push('host.runner runtime needs FACTORY_RUN_ID: a run without it is attended or headless')
      else if (runner !== undefined && runner !== 'runtime' && runtime) errors.push(`host.runner ${runner} contradicts FACTORY_RUN_ID: a runtime's run is runtime`)
    }
  }
  if (input.end_state === 'halted') errors.push('end_state halted is written only by a runtime')
  if (input.reason_code === 'takeover') errors.push('reason_code takeover is written only by a runtime')
  return errors
}

// The full result from the input; `errors` lists everything wrong with it, input and result alike.
export const buildResult = (input, { env, ticket, runIdArg, now = new Date(), host = hostname(), platform = process.platform, warn = () => {} }) => {
  const errors = inputErrors(input, env)
  if (errors.length) return { errors }
  const finished_at = utcNow(now)
  const filled = {
    ...input,
    schema: input.tasks === undefined ? 2 : 3,
    ticket,
    run_id: resolveRunId({ env, ticket, runIdArg, host, now, warn }),
    ...(env.FACTORY_DEV === '1' ? { mode: 'dev' } : {}),
    host: { name: host, os: hostOs(platform), runner: input.host?.runner ?? ((env.FACTORY_RUN_ID ?? '').trim() ? 'runtime' : 'attended') },
    finished_at,
  }
  // The record step ends when the file is written.
  const last = Array.isArray(filled.phases) ? filled.phases.at(-1) : undefined
  if (last && typeof last === 'object' && last.name === 'record' && last.ended_at === null) filled.phases = [...filled.phases.slice(0, -1), { ...last, ended_at: finished_at }]
  const result = Object.fromEntries(ORDER.filter((k) => k in filled).map((k) => [k, filled[k]]))
  return { result, errors: resultErrors(result, env) }
}

// The posted comment added to an existing result; finished_at stays as the write set it.
export const addPost = (result, ticket, post, env) => {
  const m = /^([a-z][a-z_]*)=(https?:\/\/\S+)$/.exec(post)
  if (!m) throw new UsageError(`--post takes <kind>=<url>, got ${show(post)}`)
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return { errors: resultErrors(result, env) }
  if (result.ticket !== ticket) return { errors: [`the result's ticket ${show(result.ticket)} is not ${ticket}`] }
  const posts = Array.isArray(result.posts) ? result.posts : []
  // A URL already listed (as posting or maybe_posted) is now known to be posted; posting it again changes nothing.
  const listed = posts.some((p) => p?.url === m[2])
  const next = { ...result, posts: listed ? posts.map((p) => (p?.url === m[2] ? { ...p, state: 'posted' } : p)) : [...posts, { kind: m[1], url: m[2], state: 'posted' }] }
  return { result: next, errors: resultErrors(next, env) }
}

// <main checkout>/.factory/runs/<n>/result.json, the main checkout being the parent of git's common dir.
export const resultPath = (commonDir, ticket, p = path) => p.join(p.dirname(commonDir), '.factory', 'runs', ticket.split('#')[1], 'result.json')

const parseArgs = (argv) => {
  const args = { input: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const flag = { '--ticket': 'ticket', '--run-id': 'runId', '--post': 'post' }[a]
    if (flag) {
      if (argv[i + 1] === undefined || args[flag] !== undefined) throw new UsageError(`${a} needs one value`)
      args[flag] = argv[++i]
    } else if (a.startsWith('--') || args.input !== undefined) throw new UsageError(`unexpected argument ${a}`)
    else args.input = a
  }
  if ((args.input === undefined) === (args.post === undefined)) throw new UsageError('give an input file (or - for stdin) or --post <kind>=<url>, not both')
  if (args.post !== undefined && args.runId !== undefined) throw new UsageError('--run-id applies to a write, not to --post')
  if (args.runId !== undefined && !RUN_ID.test(args.runId)) throw new UsageError(`--run-id must be 1 to 128 printable characters without spaces at either end, got ${show(args.runId)}`)
  return args
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))

const main = (argv, env) => {
  const args = parseArgs(argv)
  const ticket = resolveTicket(env, args.ticket)
  let commonDir
  try {
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    throw new UsageError('not inside a git checkout: run it from the repo or one of its worktrees')
  }
  const file = resultPath(commonDir, ticket)
  let built
  if (args.post !== undefined) {
    let current
    try {
      current = readJson(file)
    } catch (e) {
      if (e.code === 'ENOENT') throw new UsageError(`${file}: no result to add the post to; write it first`)
      return fail([`${file}: ${e instanceof SyntaxError ? `not valid JSON (${e.message})` : `cannot read (${e.code ?? e.message})`}`])
    }
    built = addPost(current, ticket, args.post, env)
  } else {
    let input
    try {
      input = readJson(args.input === '-' ? 0 : args.input)
    } catch (e) {
      if (e.code === 'ENOENT') throw new UsageError(`${args.input}: no such file`)
      return fail([`${args.input === '-' ? 'stdin' : args.input}: ${e instanceof SyntaxError ? `not valid JSON (${e.message})` : `cannot read (${e.code ?? e.message})`}`])
    }
    built = buildResult(input, { env, ticket, runIdArg: args.runId, warn: (w) => console.error(`warning: ${w}`) })
  }
  if (built.errors.length) return fail(built.errors)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(built.result, null, 2)}\n`)
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw new UsageError(`${file}: cannot write (${e.code ?? e.message})`)
  }
  console.log(file)
  return 0
}

const fail = (errors) => {
  for (const line of report(errors)) console.error(line)
  console.error('nothing written: fix the input and run it again')
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), process.env)
  } catch (e) {
    console.error(e instanceof UsageError ? e.message : `write-result failed: ${e.message}`)
    process.exitCode = 2
  }
}
