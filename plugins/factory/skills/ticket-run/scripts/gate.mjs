// Runs ticket-run's gate as one call: the reads references/comments.md describes (the issue, its timeline, the body's
// last edit, the comments, the login this session posts as), judged as that reference judges them, printed as one
// JSON verdict on stdout. Readiness (acceptance criteria and a proof command) is the run's own call on the body, so
// the verdict carries the body and leaves it open.
// Usage: node gate.mjs <n>   (from the repo or a worktree; gh fills {owner}/{repo} from the checkout)
// Exit 0 go or wait, 1 stop (the verdict says which check), 2 usage or environment (no checkout, no or unreadable
// .factory/config.yaml on the default branch, no gh). Every read that fails or cannot be judged fails closed: it stops,
// never lets the run on. The config is the one committed on the forge's default branch (committedConfig), never the
// checkout's copy.
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
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

/** The gate's keys from the config text: approvers, writers, approvers_allow_bots, labels, marker, identity ({ logins, mention }, or null when the block is absent). Throws UsageError when one cannot be read. */
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
  return { approvers, writers: writers ?? null, approversAllowBots: bots === 'true', labels, marker: marker || DEFAULT_MARKER, identity: identityBlock(top.identity) }
}

// The optional `identity:` block: `logins` (a flow list or list items) and `mention` (a scalar); other keys are ignored with their lines.
const identityBlock = (e) => {
  if (!e) return null
  const bad = (what) => new UsageError(`.factory/config.yaml: identity ${what}`)
  if (e.inline) throw bad('must be a block mapping')
  const indent = /^\s*/.exec(e.block[0] ?? '')?.[0].length ?? 0
  const logins = []
  let mention = null
  let key = null
  for (const l of e.block) {
    const kv = /^(\s+)([A-Za-z_]\w*):\s*(.*)$/.exec(l)
    if (kv && kv[1].length === indent) {
      key = kv[2]
      const value = kv[3].trim()
      if (key === 'logins') {
        if (value.startsWith('[')) {
          if (!value.endsWith(']')) throw bad('has a logins list the gate cannot read')
          const body = value.slice(1, -1).trim()
          if (body) logins.push(...body.split(',').map((x) => scalar(x, 'identity.logins')))
        } else if (value) throw bad('has logins that must be a list')
      } else if (key === 'mention') mention = scalar(value, 'identity.mention') || null
      continue
    }
    const item = /^(\s+)-\s+(.+)$/.exec(l)
    if (item && key === 'logins' && item[1].length >= indent) logins.push(scalar(item[2], 'identity.logins'))
    else if (key && key !== 'logins' && key !== 'mention' && (item || /^\s*/.exec(l)[0].length > indent)) continue
    else throw bad('is a mapping the gate cannot read')
  }
  if (logins.some((x) => !x)) throw bad('has an empty login')
  return { logins, mention }
}

// --- the judgement, pure: every input is what one read returned ---

const lines = (body) => String(body).split('\n').map((l) => l.replace(/\r$/, ''))
const fieldLines = (body) => lines(body).slice(2).flatMap((l) => {
  const m = /^([a-z][a-z ]*):\s*(.*)$/.exec(l)
  return m ? [[m[1], m[2].trim()]] : []
})
// The first occurrence of a key wins: a later line with the same key is ignored.
export const fields = (body) => {
  const out = {}
  for (const [k, v] of fieldLines(body)) if (!Object.hasOwn(out, k)) out[k] = v
  return out
}
const shortHost = (h) => lc(String(h ?? '').split('.')[0])

/**
 * The gate verdict from the reads.
 * @param {object} reads  config (parseConfig), env, host (this host's name), login (the login this run posts as, or
 *   null), issue (`gh issue view --json state,labels,body`), timeline (one page), edit (the GraphQL issue: lastEditedAt,
 *   editor; null when it printed nothing), comments ({id, login, created_at, updated_at, html_url, body}, oldest first).
 *   config.identity ({ logins, mention } or null) lets a runtime run take its approval from the run's own claim.
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
  const claims = trusted.filter(isClaim).map((c) => ({ ...fields(c.body), id: c.id, url: c.html_url, login: c.login }))
  const partial = !Array.isArray(timeline) || timeline.length >= PAGE
  const PARTIAL = `refuse: the timeline has ${PAGE} or more events, more than one read covers`
  const lastEvent = (label, kinds) => [...(partial ? [] : timeline)].reverse().find((e) => kinds.includes(e.event) && lc(e.label?.name ?? '') === lc(label))

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

  const apr = (u) => inList(approvers, u) && (config.approversAllowBots || !lc(u).endsWith('[bot]'))
  // Not edited since `at`: the reference's edit check (the body's last edit, then a rename).
  const editedSince = (at) => {
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit) || !('lastEditedAt' in edit) || (edit.lastEditedAt !== null && typeof edit.lastEditedAt !== 'string')) return 'refuse: the last edit of the body could not be read'
    // The gate counts a rename with no string time as after the approval. That agrees with the jq filter when the approval has no time either; otherwise it can only refuse where the filter lets the ticket through (fail closed; GitHub always sends a string time).
    const rename = timeline.filter((e) => e.event === 'renamed' && (typeof e.created_at !== 'string' || e.created_at >= at)).at(-1)
    if (edit.lastEditedAt !== null && edit.lastEditedAt >= at) return `refuse: body edited after approval by ${edit.editor?.login ?? 'an unknown editor'}`
    if (rename) return `refuse: title renamed after approval by ${rename.actor?.login ?? 'an unknown actor'}`
    return 'ok'
  }
  const handles = typeof config.identity?.mention === 'string' && config.identity.mention
    ? [config.identity.mention.replace(/^@/, '')]
    : (config.identity?.logins ?? []).map((l) => l.replace(/\[bot\]$/i, ''))
  const mentions = (body) => handles.filter(Boolean).some((h) => new RegExp(`(?<![A-Za-z0-9_-])@${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\[bot\\])?(?![A-Za-z0-9_-])`, 'i').test(body))
  const own = claim.state === 'own' ? claims.find((c) => c.id === claim.comment_id) : null
  // A runtime run takes the approval pinned in its own claim unless the label was touched at or after the pin.
  const pinned = runId && config.identity?.logins?.length && own && !partial && Object.hasOwn(own, 'approved by') && Object.hasOwn(own, 'approved at')
    && !timeline.some((e) => ['labeled', 'unlabeled'].includes(e.event) && lc(e.label?.name ?? '') === lc(labels.approval) && (typeof e.created_at !== 'string' || e.created_at >= own['approved at']))
  let approvedCode = null
  let approvalSource = null
  const approved = (() => {
    if (partial) return PARTIAL
    if (pinned) {
      const by = own['approved by']
      const at = own['approved at']
      if (!inList([...config.identity.logins, ...approvers], own.login)) {
        approvedCode = 'auth'
        return `refuse: the claim that pins the approval is by \`${own.login}\`, which is in neither \`identity.logins\` nor \`approvers\``
      }
      const body = trusted.find((c) => c.id === own.id).body
      const seen = fieldLines(body).map(([k]) => k)
      if (seen.filter((k) => k === 'approved by').length > 1 || seen.filter((k) => k === 'approved at').length > 1) return 'refuse: the claim repeats approved by or approved at'
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(at)) return 'refuse: approved at is not a UTC time'
      let source
      if (by.startsWith('schedule:')) {
        if (!by.slice(9).trim()) return 'refuse: a schedule pin names no schedule'
        source = 'schedule'
      } else if (apr(by)) {
        const found = comments.some((c) => lc(c.login) === lc(by) && c.created_at === at && c.updated_at === c.created_at && typeof c.body === 'string' && !c.body.startsWith(marker) && mentions(c.body))
        if (!found) return `refuse: no comment by ${by} created at ${at}, unedited and unmarked, mentions the factory`
        source = 'mention'
      } else return `refuse: approved by ${by} is not an approver`
      const edited = editedSince(at)
      if (edited === 'ok') approvalSource = source
      return edited
    }
    const approval = lastEvent(labels.approval, ['labeled', 'unlabeled'])
    if (!approval || approval.event !== 'labeled' || !apr(approval.actor?.login) || !has(labels.approval)) return 'refuse: not approved by an approver'
    // No string time: '' orders below every string, as the jq filter's null does, so an edit counts as after the approval.
    const edited = editedSince(typeof approval.created_at === 'string' ? approval.created_at : '')
    if (edited === 'ok') approvalSource = 'label'
    return edited
  })()

  const checks = { open: lc(issue.state) === 'open', approved, approval_source: approved === 'ok' ? approvalSource : null, grooming: has(labels.needs_grooming), takeover, claim }
  const stop = (check, reason, reason_code = null) => ({ verdict: 'stop', stop: { check, reason, reason_code }, checks })
  const base = { checks, ready: 'judge from body: acceptance criteria and a proof command; without them ask on the ticket (a park, not a stop)', body: issue.body ?? '' }
  if (!checks.open) return { ...base, ...stop('open', 'the issue is closed') }
  if (approved !== 'ok') return { ...base, ...stop('approved', approved, approvedCode) }
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

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, windowsHide: true })
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/**
 * .factory/config.yaml as committed on the forge's default branch, never the checkout's copy: a run may stand on a
 * branch (a change's) where a writer or the session changed it. The default branch and its head commit come from the
 * remote (`git ls-remote --symref origin HEAD`), never from local refs a session can move (`origin/HEAD`, `update-ref`),
 * and the file is read from that commit with replace objects off, so `git replace` cannot swap it. The commit must be
 * fetched. Returns the text, or null when that commit has no such file; throws when any of it cannot be read.
 */
export const committedConfig = (run = git) => {
  const out = run(['ls-remote', '--symref', 'origin', 'HEAD'])
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1]
  const sha = /^(\S+)\tHEAD$/m.exec(out)?.[1]
  if (!branch || !sha || !SHA.test(sha)) throw new Error('git ls-remote --symref origin HEAD named no default branch and head')
  try {
    run(['--no-replace-objects', 'cat-file', '-e', `${sha}^{commit}`])
  } catch {
    throw new Error(`the head of the default branch ${branch} (${sha.slice(0, 12)}) is not fetched: run git fetch origin ${branch}`)
  }
  if (run(['--no-replace-objects', 'ls-tree', '--name-only', sha, '--', '.factory/config.yaml']).trim() === '') return null
  return run(['--no-replace-objects', 'show', `${sha}:.factory/config.yaml`])
}

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
  const comments = gh(['api', `repos/{owner}/{repo}/issues/${n}/comments`, '--paginate', '--jq', '.[] | {id, login: .user.login, created_at, updated_at, html_url, body}'])
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
  try {
    git(['rev-parse', '--show-toplevel'])
  } catch {
    throw new UsageError('not inside a git checkout: run it from the repo or one of its worktrees')
  }
  let text
  try {
    text = committedConfig()
  } catch (e) {
    throw new UsageError(`.factory/config.yaml: cannot read it from the default branch (${cut(String(e.stderr ?? '').trim().split('\n')[0] || e.message, 200)})`)
  }
  if (text === null) throw new UsageError('.factory/config.yaml: missing on the default branch: adopt the repo first and merge the config (https://github.com/giocaizzi/harness/blob/main/docs/adopt-factory.md)')
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
