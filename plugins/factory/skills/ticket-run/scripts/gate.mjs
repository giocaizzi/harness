// Runs ticket-run's gate as one call: the reads references/comments.md describes (the issue, its timeline, the body's
// last edit, the comments, the login this session posts as), judged as that reference judges them, printed as one
// JSON verdict on stdout. Readiness (acceptance criteria and a proof command) is the run's own call on the body, so
// the verdict carries the body and leaves it open.
// Usage: node gate.mjs <n>   (from the repo or a worktree; gh fills {owner}/{repo} from the checkout)
// Exit 0 go or wait, 1 stop (the verdict says which check), 2 usage or environment (no checkout, no or unreadable
// .factory/config.yaml, no gh). Every read that fails or cannot be judged fails closed: it stops, never lets the run on.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export class UsageError extends Error {}
class ReadError extends Error {}

const DEFAULT_MARKER = '<!-- factory -->'
const DEFAULT_LABELS = { approval: 'agent-ok', claimed: 'factory-claimed', needs_grooming: 'needs-grooming', takeover: 'factory-takeover' }
const CLAIM_TAG = '<!-- factory:claim -->'
const PAGE = 100 // one timeline page; 100 events or more refuse, as the reference does, rather than judge a partial history

const lc = (s) => String(s).toLowerCase()
const cut = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s)

// --- .factory/config.yaml: only the keys the gate reads, in the plain YAML the template uses ---

// A line without its comment: a `#` at the start or after a space, outside quotes.
const uncomment = (line) => {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}
const scalar = (raw, key) => {
  const v = raw.trim()
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v)
    } catch {
      throw new UsageError(`.factory/config.yaml: ${key} has a double-quoted value the gate cannot read`)
    }
  }
  if (v.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(v)) throw new UsageError(`.factory/config.yaml: ${key} has a single-quoted value the gate cannot read`)
    return v.slice(1, -1).replace(/''/g, "'")
  }
  return v
}

/** The gate's keys from the config text: approvers, writers, approvers_allow_bots, labels, marker. Throws UsageError when one cannot be read. */
export const parseConfig = (text) => {
  const top = {}
  let current = null
  let first = true
  for (const raw of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')) {
    const line = uncomment(raw).trimEnd()
    if (!line.trim()) continue
    if (first && line === '---') {
      first = false
      continue
    }
    first = false
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line)
    if (m) {
      current = { inline: (m[2] ?? '').trim(), block: [] }
      top[m[1]] = current
    } else if ((/^\s/.test(line) || /^-\s/.test(line)) && current) current.block.push(line.startsWith('-') ? ` ${line}` : line)
    else throw new UsageError(`.factory/config.yaml: cannot read the line ${JSON.stringify(cut(raw, 80))}`)
  }
  const list = (key) => {
    const e = top[key]
    if (!e) return undefined
    if (e.inline.startsWith('[')) {
      if (!e.inline.endsWith(']') || e.block.length) throw new UsageError(`.factory/config.yaml: ${key} is a list the gate cannot read`)
      const body = e.inline.slice(1, -1).trim()
      return body ? body.split(',').map((x) => scalar(x, key)) : []
    }
    if (e.inline) throw new UsageError(`.factory/config.yaml: ${key} must be a list`)
    return e.block.map((l) => {
      const item = /^\s+-\s+(.+)$/.exec(l)
      if (!item) throw new UsageError(`.factory/config.yaml: ${key} is a list the gate cannot read`)
      return scalar(item[1], key)
    })
  }
  const approvers = list('approvers')
  if (!approvers?.length || approvers.some((a) => !a)) throw new UsageError('.factory/config.yaml: approvers must list at least one login')
  const writers = list('writers')
  const bots = top.approvers_allow_bots ? scalar(top.approvers_allow_bots.inline, 'approvers_allow_bots') : 'false'
  if (bots !== 'true' && bots !== 'false') throw new UsageError('.factory/config.yaml: approvers_allow_bots must be true or false')
  const labels = { ...DEFAULT_LABELS }
  if (top.labels) {
    if (top.labels.inline) throw new UsageError('.factory/config.yaml: labels must be a block mapping')
    const indent = /^\s*/.exec(top.labels.block[0] ?? '')?.[0].length ?? 0
    for (const l of top.labels.block) {
      const kv = /^(\s+)([A-Za-z_]\w*):\s*(.*)$/.exec(l)
      if (!kv || kv[1].length !== indent) throw new UsageError('.factory/config.yaml: labels is a mapping the gate cannot read')
      const name = scalar(kv[3], `labels.${kv[2]}`)
      if (!name) throw new UsageError(`.factory/config.yaml: labels.${kv[2]} is empty`)
      if (kv[2] in labels) labels[kv[2]] = name
    }
  }
  const marker = top.marker ? scalar(top.marker.inline, 'marker') : ''
  return { approvers, writers: writers ?? null, approversAllowBots: bots === 'true', labels, marker: marker || DEFAULT_MARKER }
}

// --- the judgement, pure: every input is what one read returned ---

const lines = (body) => String(body).split('\n').map((l) => l.replace(/\r$/, ''))
const fields = (body) => Object.fromEntries(lines(body).slice(2).flatMap((l) => {
  const m = /^([a-z][a-z ]*):\s*(.*)$/.exec(l)
  return m ? [[m[1], m[2].trim()]] : []
}))
const shortHost = (h) => lc(String(h ?? '').split('.')[0])

/**
 * The gate verdict from the reads.
 * @param {object} reads  config (parseConfig), env, host (this host's name), login (the login this run posts as, or
 *   null), issue (`gh issue view --json state,labels,body`), timeline (one page), edit (the GraphQL issue: lastEditedAt,
 *   editor; null when it printed nothing), comments ({id, login, created_at, html_url, body}, oldest first).
 * @returns {object} The verdict: `go`, `wait` (takeover: the runtime still holds the ticket) or `stop`, and each check.
 */
export const judge = ({ config, env, host, login, issue, timeline, edit, comments }) => {
  const { approvers, labels, marker } = config
  const on = new Set((issue.labels ?? []).map((l) => lc(l.name)))
  const has = (name) => on.has(lc(name))
  const inList = (list, u) => u != null && list.map(lc).includes(lc(u))
  const writers = [...(config.writers ?? approvers), ...(login ? [login] : [])]
  const marked = (c) => typeof c.body === 'string' && c.body.startsWith(marker)
  const trusted = comments.filter((c) => marked(c) && inList(writers, c.login))
  const isClaim = (c) => lines(c.body)[1] === CLAIM_TAG
  const claims = trusted.filter(isClaim).map((c) => ({ id: c.id, url: c.html_url, login: c.login, ...fields(c.body) }))
  const partial = !Array.isArray(timeline) || timeline.length >= PAGE
  const PARTIAL = `refuse: the timeline has ${PAGE} or more events, more than one read covers`
  const lastEvent = (label, kinds) => [...(partial ? [] : timeline)].reverse().find((e) => kinds.includes(e.event) && lc(e.label?.name ?? '') === lc(label))

  // Approved and not edited since: the reference's edit check, which judges the approval too.
  const apr = (u) => inList(approvers, u) && (config.approversAllowBots || !lc(u).endsWith('[bot]'))
  const approved = (() => {
    if (partial) return PARTIAL
    const approval = lastEvent(labels.approval, ['labeled', 'unlabeled'])
    if (!approval || approval.event !== 'labeled' || !apr(approval.actor?.login) || !has(labels.approval)) return 'refuse: not approved by an approver'
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit) || !('lastEditedAt' in edit) || (edit.lastEditedAt !== null && typeof edit.lastEditedAt !== 'string')) return 'refuse: the last edit of the body could not be read'
    // No string time: '' orders below every string, as the jq filter's null does, so an edit counts as after the approval.
    const at = typeof approval.created_at === 'string' ? approval.created_at : ''
    // The gate counts a rename with no string time as after the approval. That agrees with the jq filter when the approval has no time either; otherwise it can only refuse where the filter lets the ticket through (fail closed; GitHub always sends a string time).
    const rename = timeline.filter((e) => e.event === 'renamed' && (typeof e.created_at !== 'string' || e.created_at >= at)).at(-1)
    if (edit.lastEditedAt !== null && edit.lastEditedAt >= at) return `refuse: body edited after approval by ${edit.editor?.login ?? 'an unknown editor'}`
    if (rename) return `refuse: title renamed after approval by ${rename.actor?.login ?? 'an unknown actor'}`
    return 'ok'
  })()

  const runId = String(env.FACTORY_RUN_ID ?? '').trim()
  // Takeover counts only in an attended run, applied by an approver (approvers_allow_bots does not apply here).
  const takeover = runId || !has(labels.takeover) ? null : (() => {
    if (partial) return PARTIAL
    const e = lastEvent(labels.takeover, ['labeled', 'unlabeled'])
    return e?.event === 'labeled' && inList(approvers, e.actor?.login) ? 'takeover' : 'ignore: the takeover label was not applied by an approver'
  })()

  const claimOn = has(labels.claimed)
  const newest = claims.at(-1) ?? null
  let claim
  if (runId) {
    const mine = claims.filter((c) => c['run id'] === runId)
    const runtimeMine = mine.filter((c) => lc(c.runner ?? '') === 'runtime').at(-1)
    if (!claimOn) claim = runtimeMine ? { state: 'own', comment_id: runtimeMine.id, url: runtimeMine.url } : { state: 'none' }
    else if (!mine.length) {
      // Runtime claim not from a writer: name the claim label's last labeled actor only when exactly one marked claim
      // with this run id is theirs; print logins only, never a body.
      const actor = partial ? null : (lastEvent(labels.claimed, ['labeled'])?.actor?.login ?? null)
      const copies = comments.filter((c) => marked(c) && isClaim(c) && lines(c.body).includes(`run id: ${runId}`)).map((c) => c.login)
      const named = actor && copies.filter((l) => lc(l) === lc(actor)).length === 1 ? actor : null
      claim = { state: 'untrusted', login: named }
    } else if (newest && newest['run id'] === runId && lc(newest.runner ?? '') === 'runtime') claim = { state: 'own', comment_id: newest.id, url: newest.url }
    else claim = { state: 'other', newest }
  } else if (!claimOn) claim = { state: 'none' }
  else if (newest && lc(newest.runner ?? '') === 'attended' && shortHost(newest.host) === shortHost(host)) claim = { state: 'own', comment_id: newest.id, url: newest.url }
  else if (newest && lc(newest.runner ?? '') === 'runtime' && takeover === 'takeover') claim = { state: 'held', newest }
  else claim = { state: 'other', newest }

  const checks = { open: lc(issue.state) === 'open', approved, grooming: has(labels.needs_grooming), takeover, claim }
  const stop = (check, reason, reason_code = null) => ({ verdict: 'stop', stop: { check, reason, reason_code }, checks })
  const base = { checks, ready: 'judge from body: acceptance criteria and a proof command; without them ask on the ticket (a park, not a stop)', body: issue.body ?? '' }
  if (!checks.open) return { ...base, ...stop('open', 'the issue is closed') }
  if (approved !== 'ok') return { ...base, ...stop('approved', approved) }
  if (checks.grooming) return { ...base, ...stop('grooming', `the ${labels.needs_grooming} label is on: the owner removes it once the ticket is refined`) }
  if (claim.state === 'untrusted') {
    const reason = claim.login
      ? `the runtime's claim is by \`${claim.login}\`, which is not in \`writers\`: check it is the runtime's login, then add \`${claim.login}\` to \`writers\` in \`.factory/config.yaml\``
      : "no trusted claim carries this run's id (`FACTORY_RUN_ID`); if the runtime posts under its own login, add that login to `writers` in `.factory/config.yaml`"
    return { ...base, ...stop('claim', reason, 'auth') }
  }
  if (claim.state === 'other') return { ...base, ...stop('claim', `claimed by another run${claim.newest ? ` (run id ${claim.newest['run id'] ?? 'unknown'}, runner ${claim.newest.runner ?? 'unknown'}, ${claim.newest.url ?? ''})` : ' (the claim label is on and no trusted claim is this run\'s)'}`) }
  if (claim.state === 'held') return { ...base, verdict: 'wait', stop: null, checks }
  return { ...base, verdict: 'go', stop: null, checks, claim: claim.state === 'own' ? { action: 'edit', comment_id: claim.comment_id } : { action: 'post' } }
}

// --- the reads ---

const gh = (args) => {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  } catch (e) {
    if (e.code === 'ENOENT') throw new UsageError('gh is not installed or not on PATH')
    throw new ReadError(`gh ${args.slice(0, 2).join(' ')} failed: ${cut(String(e.stderr ?? e.message).trim().split('\n')[0] ?? '')}`)
  }
}
const json = (text, what) => {
  try {
    return JSON.parse(text)
  } catch {
    throw new ReadError(`${what}: not valid JSON`)
  }
}

export const read = (n) => {
  let login = null
  try {
    login = gh(['api', 'user', '--jq', '.login']).trim() || null
  } catch (e) {
    if (e instanceof UsageError) throw e
    // an App token cannot read /user: its <slug>[bot] must then be in writers
  }
  const issue = json(gh(['issue', 'view', String(n), '--json', 'state,labels,body']), 'issue')
  const timeline = json(gh(['api', `repos/{owner}/{repo}/issues/${n}/timeline?per_page=${PAGE}`]), 'timeline')
  const editText = gh(['api', 'graphql', '-F', `n=${n}`, '-F', 'owner=:owner', '-F', 'name=:repo', '--jq', '.data.repository.issue', '-f', 'query=query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){lastEditedAt editor{login}}}}']).trim()
  const edit = editText ? json(editText, 'last edit') : null
  const comments = gh(['api', `repos/{owner}/{repo}/issues/${n}/comments`, '--paginate', '--jq', '.[] | {id, login: .user.login, created_at, html_url, body}'])
    .split('\n').filter(Boolean).map((l) => json(l, 'comments'))
  return { login, issue, timeline, edit, comments }
}

const parseNumber = (argv, env) => {
  if (argv.length !== 1 || !/^#?[1-9]\d*$/.test(argv[0])) throw new UsageError('usage: node gate.mjs <issue number>')
  const n = Number(argv[0].replace('#', ''))
  const ticket = String(env.FACTORY_TICKET ?? '').trim()
  if (ticket && !ticket.endsWith(`#${n}`)) throw new UsageError(`issue ${n} is not FACTORY_TICKET ${JSON.stringify(cut(ticket, 200))}`)
  return n
}

const main = (argv, env) => {
  const n = parseNumber(argv, env)
  let top
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
  } catch {
    throw new UsageError('not inside a git checkout: run it from the repo or one of its worktrees')
  }
  let text
  try {
    text = readFileSync(path.join(top, '.factory', 'config.yaml'), 'utf8')
  } catch (e) {
    throw new UsageError(`.factory/config.yaml: ${e.code === 'ENOENT' ? 'missing: adopt the repo first (https://github.com/giocaizzi/harness/blob/main/docs/adopt-factory.md)' : `cannot read (${e.code ?? e.message})`}`)
  }
  const config = parseConfig(text)
  let verdict
  try {
    verdict = { number: n, ...judge({ config, env, host: hostname(), ...read(n) }) }
  } catch (e) {
    if (!(e instanceof ReadError)) throw e
    verdict = { number: n, verdict: 'stop', stop: { check: 'read', reason: `${e.message}: a read that fails counts as no`, reason_code: null }, checks: null, body: null, ready: null }
  }
  console.log(JSON.stringify(verdict, null, 2))
  return verdict.verdict === 'stop' ? 1 : 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), process.env)
  } catch (e) {
    console.error(e instanceof UsageError ? e.message : `gate failed: ${e.message}`)
    process.exitCode = 2
  }
}
