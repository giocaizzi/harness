#!/usr/bin/env node
// CI health: run volume, run time, queueing, re-runs and workflow hygiene, across every repo `gh` can reach (all owners,
// every authenticated host). Aggregates only; --repos adds a per-repo table for local reading. Runbook: docs/agent-review.md.
import { fileURLToPath } from 'node:url'
import { parseRange, ghRunner, hosts } from './pr-graph.mjs'

const DAY = 86400000
const SKIPPED = 'CI health: skipped (gh is not installed or not authenticated).'
const READING = 'How to read each figure: .agents/skills/agent-review/references/reading.md (CI health).'

// Flags compare a repo's current window to its previous one; run time p50 stands in for the critical path.
export const MIN_RUNS = 5
export const GROWTH = 1.2
const JOB_SAMPLE = 30
const PR_EVENTS = new Set(['pull_request', 'pull_request_target'])
const SAMPLE_EVENTS = new Set([...PR_EVENTS, 'merge_group'])
const BAD = new Set(['failure', 'timed_out'])
const WORKFLOW_FILE = /\.ya?ml$/

const QUERY = `query($q:String!,$cursor:String){search(query:$q,type:ISSUE,first:50,after:$cursor){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{repository{nameWithOwner defaultBranchRef{name}}}}}}`

const day = (ms) => new Date(ms).toISOString().slice(0, 10)

// Windows by UTC day: current = the last `days` days up to today, previous = the `days` days before that.
export function windows(days, now) {
  const end = Math.floor(now / DAY) * DAY
  const curStart = end - (days - 1) * DAY
  const prevStart = curStart - days * DAY
  return { prevFrom: day(prevStart), prevTo: day(curStart - DAY), curFrom: day(curStart), curTo: day(end) }
}

export const windowOf = (date, w) => (date >= w.curFrom && date <= w.curTo ? 'cur' : date >= w.prevFrom && date <= w.prevTo ? 'prev' : null)

// 7-day [from, to] date chunks (inclusive) covering from..to; the runs API returns <= 1000 results per filtered query.
export function dateChunks(from, to) {
  const out = []
  const end = Date.parse(to)
  for (let s = Date.parse(from); s <= end; s += 7 * DAY) out.push([day(s), day(Math.min(s + 6 * DAY, end))])
  return out
}

const gh = (host, path, ...fields) => ['api', '--hostname', host, '-X', 'GET', path, ...fields.flatMap((f) => ['-f', f])]
const say = () => console.error('CI health: a query failed; continuing')
async function attempt(fn) {
  try {
    return await fn()
  } catch {
    say()
    return null
  }
}

export async function fetchRepos(runner, host, from, to) {
  const out = []
  let cursor = null
  do {
    const args = ['api', 'graphql', '--hostname', host, '-f', `q=author:@me is:pr is:merged merged:${from}..${to}`, '-f', `query=${QUERY}`]
    if (cursor) args.push('-f', `cursor=${cursor}`)
    const s = JSON.parse(await runner(args)).data.search
    for (const n of s.nodes) if (n?.repository) out.push(n.repository)
    cursor = s.pageInfo.hasNextPage ? s.pageInfo.endCursor : null
  } while (cursor)
  return out
}

export async function fetchRuns(runner, host, repo, from, to) {
  const out = []
  for (let page = 1; ; page++) {
    const j = JSON.parse(await runner(gh(host, `repos/${repo}/actions/runs`, `created=${from}..${to}`, 'per_page=100', `page=${page}`)))
    const list = j.workflow_runs || []
    for (const r of list) {
      const { id, event, status, conclusion, run_attempt, head_sha, workflow_id, created_at, run_started_at, updated_at } = r
      out.push({ id, event, status, conclusion, run_attempt, head_sha, workflow_id, created_at, run_started_at, updated_at })
    }
    if (list.length < 100) return out
  }
}

const mergedCount = async (runner, host, repo, from, to) => JSON.parse(await runner(gh(host, 'search/issues', `q=repo:${repo} is:pr is:merged merged:${from}..${to}`, 'per_page=1'))).total_count

const isDone = (r) => r.status === 'completed'
const countable = (r) => isDone(r) && r.conclusion !== 'skipped'

// Queue wait of sampled jobs: the most recent completed PR / merge-group runs, started_at - created_at per non-skipped job.
export async function sampleWaits(runner, host, repo, runs) {
  const picked = runs.filter((r) => isDone(r) && SAMPLE_EVENTS.has(r.event)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, JOB_SAMPLE)
  const waits = []
  for (const r of picked) {
    const j = await attempt(async () => JSON.parse(await runner(gh(host, `repos/${repo}/actions/runs/${r.id}/jobs`, 'per_page=100'))))
    for (const job of j?.jobs || []) if (job.started_at && job.created_at && job.conclusion !== 'skipped') waits.push(Date.parse(job.started_at) - Date.parse(job.created_at))
  }
  return waits
}

// Flake proxy: a run that passed on a re-run whose previous attempt (same head SHA) failed.
export async function countFlakes(runner, host, repo, runs) {
  let n = 0
  for (const r of runs) {
    if (!(isDone(r) && r.run_attempt > 1 && r.conclusion === 'success')) continue
    const a = await attempt(async () => JSON.parse(await runner(gh(host, `repos/${repo}/actions/runs/${r.id}/attempts/${r.run_attempt - 1}`))))
    if (a?.conclusion === 'failure') n++
  }
  return n
}

export async function fetchWorkflows(runner, host, repo) {
  let list
  try {
    list = JSON.parse(await runner(gh(host, `repos/${repo}/contents/.github/workflows`)))
  } catch {
    return [] // no workflows directory
  }
  const files = []
  for (const f of Array.isArray(list) ? list : []) {
    if (f.type !== 'file' || !WORKFLOW_FILE.test(f.name)) continue
    const c = await attempt(async () => JSON.parse(await runner(gh(host, `repos/${repo}/contents/${f.path}`))))
    if (c?.content) files.push({ path: f.path, text: Buffer.from(c.content, 'base64').toString('utf8') })
  }
  return files
}

export async function hasMergeQueue(runner, host, repo, branch) {
  if (!branch) return false
  try {
    const rules = JSON.parse(await runner(gh(host, `repos/${repo}/rules/branches/${branch}`)))
    return Array.isArray(rules) && rules.some((r) => r.type === 'merge_queue')
  } catch {
    return false
  }
}

export async function collect(runner, days, now = Date.now()) {
  const hs = await hosts(runner)
  if (!hs.length) return null
  const w = windows(days, now)
  const out = []
  for (const host of hs) {
    const found = new Map()
    for (const [from, to] of dateChunks(w.prevFrom, w.curTo)) {
      const list = await attempt(() => fetchRepos(runner, host, from, to))
      for (const r of list || []) found.set(r.nameWithOwner, r.defaultBranchRef?.name)
    }
    for (const [name, branch] of found) {
      const raw = new Map()
      for (const [from, to] of dateChunks(w.prevFrom, w.curTo)) {
        const list = await attempt(() => fetchRuns(runner, host, name, from, to))
        for (const r of list || []) raw.set(r.id, r)
      }
      const byWin = { prev: [], cur: [] }
      for (const r of raw.values()) byWin[windowOf(r.created_at.slice(0, 10), w)]?.push(r)
      const rec = { key: `${host}/${name}`, prev: null, cur: null }
      for (const [k, from, to] of [['prev', w.prevFrom, w.prevTo], ['cur', w.curFrom, w.curTo]]) {
        const runs = byWin[k]
        const mergedPrs = (await attempt(() => mergedCount(runner, host, name, from, to))) ?? 0
        rec[k] = { runs, mergedPrs, waits: await sampleWaits(runner, host, name, runs), flakes: await countFlakes(runner, host, name, runs) }
      }
      rec.files = await fetchWorkflows(runner, host, name)
      rec.hasQueue = await hasMergeQueue(runner, host, name, branch)
      out.push(rec)
    }
  }
  return out
}

// nearest-rank percentile; null for an empty list
export function percentile(list, p) {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  return s[Math.ceil(p * s.length) - 1]
}

export function duration(ms) {
  if (ms == null) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const ms = (a, b) => Date.parse(a) - Date.parse(b)
const sum = (list, k) => list.reduce((n, x) => n + x[k], 0)
const ratio = (n, d) => (d ? n / d : null)

// Raw tallies of one window; sums across repos are taken here, ratios only in derive().
export function windowStats(runs, mergedPrs, waits, flakes) {
  const kept = runs.filter((r) => r.conclusion !== 'skipped') // skipped runs count only toward skipped noise
  const done = kept.filter(isDone)
  const mg = done.filter((r) => r.event === 'merge_group')
  const raw = {
    mergedPrs,
    prRuns: kept.filter((r) => PR_EVENTS.has(r.event)).length, // pull_request and pull_request_target
    mgRuns: kept.filter((r) => r.event === 'merge_group').length,
    runTimes: done.map((r) => ms(r.updated_at, r.run_started_at)).filter((x) => x >= 0), // completed, non-skipped
    greenTimes: done.filter((r) => r.conclusion === 'success').map((r) => ms(r.updated_at, r.created_at)), // queue-to-green, includes re-run attempts
    waits,
    completed: done.length,
    gated: done.filter((r) => SAMPLE_EVENTS.has(r.event)).length, // PR + merge-group, the flag guard
    cancelled: done.filter((r) => r.conclusion === 'cancelled').length,
    failed: done.filter((r) => BAD.has(r.conclusion)).length,
    reruns: done.filter((r) => r.run_attempt > 1).length,
    flakes,
    mgCompleted: mg.length,
    mgEjected: mg.filter((r) => BAD.has(r.conclusion) || r.conclusion === 'cancelled').length,
    skipped: runs.filter((r) => isDone(r) && r.conclusion === 'skipped').length,
    allCompleted: runs.filter(isDone).length,
  }
  return derive(raw)
}

const LISTS = ['runTimes', 'greenTimes', 'waits']
const COUNTS = ['mergedPrs', 'prRuns', 'mgRuns', 'completed', 'gated', 'cancelled', 'failed', 'reruns', 'flakes', 'mgCompleted', 'mgEjected', 'skipped', 'allCompleted']

function derive(raw) {
  return {
    ...raw,
    prRunsPerPr: ratio(raw.prRuns, raw.mergedPrs),
    mgRunsPerPr: ratio(raw.mgRuns, raw.mergedPrs),
    runP50: percentile(raw.runTimes, 0.5),
    runP90: percentile(raw.runTimes, 0.9),
    greenP50: percentile(raw.greenTimes, 0.5),
    greenP90: percentile(raw.greenTimes, 0.9),
    waitP50: percentile(raw.waits, 0.5),
    waitP90: percentile(raw.waits, 0.9),
    cancelledShare: ratio(raw.cancelled, raw.completed),
    failureShare: ratio(raw.failed, raw.completed),
    rerunShare: ratio(raw.reruns, raw.completed),
    flakeShare: ratio(raw.flakes, raw.completed),
    ejectRate: ratio(raw.mgEjected, raw.mgCompleted),
    skippedNoise: ratio(raw.skipped, raw.allCompleted),
  }
}

export function mergeStats(list) {
  const raw = {}
  for (const k of COUNTS) raw[k] = sum(list, k)
  for (const k of LISTS) raw[k] = list.flatMap((x) => x[k])
  return derive(raw)
}

// Relative flags, no fixed minute budget: both windows need MIN_RUNS gated runs.
export function flags(prev, cur) {
  const enough = prev.gated >= MIN_RUNS && cur.gated >= MIN_RUNS
  return {
    criticalPathGrew: enough && prev.runP50 > 0 && cur.runP50 >= prev.runP50 * GROWTH,
    rerunGrew: enough && cur.rerunShare > prev.rerunShare,
  }
}

// ---- workflow audit: a line parser over the YAML text (no YAML library), good enough for GitHub workflow files ----
const clean = (l) => l.replace(/(^|\s)#.*$/, '').trimEnd()
const indent = (l) => l.match(/^ */)[0].length
const blank = (l) => !l.trim()

// lines under a column-0 `key:`, and its inline value
function block(lines, key) {
  const re = new RegExp(`^["']?(?:${key})["']?\\s*:(.*)$`)
  const i = lines.findIndex((l) => re.test(l))
  if (i < 0) return null
  const children = []
  for (const l of lines.slice(i + 1)) {
    if (!blank(l) && indent(l) === 0 && !l.startsWith('-')) break
    children.push(l)
  }
  return { inline: re.exec(lines[i])[1].trim(), children: children.filter((l) => !blank(l)) }
}

// trigger name -> its child lines
function triggers(lines) {
  const on = block(lines, 'on')
  const out = new Map()
  if (!on) return out
  if (on.inline) {
    for (const n of on.inline.match(/[a-z_]+/g) || []) out.set(n, [])
    return out
  }
  const base = Math.min(...on.children.map(indent))
  let cur = null
  for (const l of on.children) {
    const m = indent(l) === base ? /^(?:-\s*)?([a-z_]+)/.exec(l.trim()) : null
    if (m) out.set((cur = m[1]), [])
    else if (cur) out.get(cur).push(l)
  }
  return out
}

function jobsOf(lines) {
  const jobs = block(lines, 'jobs')
  if (!jobs || !jobs.children.length) return []
  const base = Math.min(...jobs.children.map(indent))
  const out = []
  for (const l of jobs.children) {
    if (indent(l) === base && /^["']?[\w.-]+["']?\s*:/.test(l.trim())) out.push([])
    else out.at(-1)?.push(l)
  }
  return out.map((body) => {
    const bi = body.length ? Math.min(...body.map(indent)) : 0
    const direct = (k) => body.findIndex((l) => indent(l) === bi && l.trim().startsWith(`${k}:`))
    const at = direct('if')
    let cond = ''
    if (at >= 0) for (const l of body.slice(at)) { if (l !== body[at] && indent(l) <= bi) break; cond += `${l}\n` }
    return { reusable: direct('uses') >= 0, timeout: direct('timeout-minutes') >= 0, concurrency: direct('concurrency') >= 0, aggregate: direct('needs') >= 0 && cond.includes('always()') }
  })
}

export function auditWorkflows(files, hasQueue) {
  const a = { workflows: files.length, concurrency: 0, prWorkflows: 0, prCancel: 0, jobs: 0, reusable: 0, timeouts: 0, mergeGroup: 0, filtered: 0, aggregate: 0, caches: 0, refs: 0, pinned: 0, permissions: 0 }
  for (const f of files) {
    const lines = f.text.split('\n').map(clean)
    const trig = triggers(lines)
    const jobs = jobsOf(lines)
    if (lines.some((l) => /^concurrency\s*:/.test(l)) || jobs.some((j) => j.concurrency)) a.concurrency++
    if (trig.has('pull_request')) {
      a.prWorkflows++
      if (lines.some((l) => /^\s*cancel-in-progress\s*:\s*(?!false\b)\S/.test(l))) a.prCancel++
    }
    a.jobs += jobs.length
    a.reusable += jobs.filter((j) => j.reusable).length
    a.timeouts += jobs.filter((j) => !j.reusable && j.timeout).length
    if (trig.has('merge_group')) a.mergeGroup++
    if (['pull_request', 'push', 'merge_group'].some((t) => (trig.get(t) || []).some((l) => /^\s*paths(-ignore)?\s*:/.test(l)))) a.filtered++
    a.aggregate += jobs.filter((j) => j.aggregate).length
    if (lines.some((l) => /uses\s*:\s*["']?actions\/cache[/@]/.test(l) || /^\s*cache\s*:\s*\S/.test(l))) a.caches++
    for (const l of lines) {
      const m = /\buses\s*:\s*["']?([^\s"']+)/.exec(l)
      if (!m || m[1].startsWith('./') || m[1].startsWith('docker://') || !m[1].includes('@')) continue
      a.refs++
      if (/@[0-9a-f]{40}$/.test(m[1])) a.pinned++
    }
    if (lines.some((l) => /^permissions\s*:/.test(l))) a.permissions++
  }
  a.queueWithoutMergeGroup = Boolean(hasQueue) && a.mergeGroup === 0
  a.pathFilterNoAggregate = a.filtered > 0 && a.aggregate === 0
  return a
}

const AUDIT_SUMS = ['workflows', 'concurrency', 'prWorkflows', 'prCancel', 'jobs', 'reusable', 'timeouts', 'mergeGroup', 'filtered', 'aggregate', 'caches', 'refs', 'pinned', 'permissions']
export function mergeAudits(list) {
  const out = {}
  for (const k of AUDIT_SUMS) out[k] = sum(list, k)
  out.queueWithoutMergeGroup = list.filter((a) => a.queueWithoutMergeGroup).length
  out.pathFilterNoAggregate = list.filter((a) => a.pathFilterNoAggregate).length
  return out
}

export function analyze(repos) {
  const perRepo = {}
  for (const r of repos) {
    const prev = windowStats(r.prev.runs, r.prev.mergedPrs, r.prev.waits, r.prev.flakes)
    const cur = windowStats(r.cur.runs, r.cur.mergedPrs, r.cur.waits, r.cur.flakes)
    perRepo[r.key] = { prev, cur, audit: auditWorkflows(r.files, r.hasQueue), ...flags(prev, cur) }
  }
  const rows = Object.values(perRepo)
  return {
    repos: rows.length,
    prev: mergeStats(rows.map((r) => r.prev)),
    cur: mergeStats(rows.map((r) => r.cur)),
    audit: mergeAudits(rows.map((r) => r.audit)),
    criticalPathGrew: rows.filter((r) => r.criticalPathGrew).length,
    rerunGrew: rows.filter((r) => r.rerunGrew).length,
    perRepo,
  }
}

const one = (x) => (x == null ? '-' : x.toFixed(1))
const share = (n, d) => (d ? `${Math.round((100 * n) / d)}% (${n})` : '-')
const shareOf = (n, d) => (d ? `${Math.round((100 * n) / d)}% (${n}/${d})` : '-')
const pair = (a, b) => `${duration(a)} / ${duration(b)}`

export function report(agg, range) {
  const row = (name, f) => `| ${name} | ${f(agg.prev)} | ${f(agg.cur)} |`
  const a = agg.audit
  const audit = [
    ['Workflows', a.workflows],
    ['Concurrency set', shareOf(a.concurrency, a.workflows)],
    ['PR workflows cancelling superseded runs', shareOf(a.prCancel, a.prWorkflows)],
    ['Jobs with timeout-minutes', shareOf(a.timeouts, a.jobs - a.reusable)],
    ['Repos with a merge queue and no merge_group trigger', a.queueWithoutMergeGroup],
    ['Repos with trigger path filters and no aggregate check', a.pathFilterNoAggregate],
    ['Workflows with a cache', shareOf(a.caches, a.workflows)],
    ['Action refs pinned by SHA', shareOf(a.pinned, a.refs)],
    ['Workflows with top-level permissions', shareOf(a.permissions, a.workflows)],
  ]
  return [
    `## CI health (last ${range} vs the ${range} before, every repo gh can reach)`,
    '',
    '| Measure | Previous | Current |',
    '|---|---|---|',
    `| Repos | ${agg.repos} | ${agg.repos} |`,
    row('Merged PRs', (s) => s.mergedPrs),
    row('PR runs per merged PR', (s) => one(s.prRunsPerPr)),
    row('Merge-group runs per merged PR', (s) => one(s.mgRunsPerPr)),
    row('Run time p50 / p90', (s) => pair(s.runP50, s.runP90)),
    row('Queue-to-green p50 / p90', (s) => pair(s.greenP50, s.greenP90)),
    row('Queue wait p50 / p90 (sampled jobs)', (s) => pair(s.waitP50, s.waitP90)),
    row('Cancelled share', (s) => share(s.cancelled, s.completed)),
    row('Failure share', (s) => share(s.failed, s.completed)),
    row('Re-run share', (s) => share(s.reruns, s.completed)),
    row('Flake proxy (failed, then passed on a re-run)', (s) => share(s.flakes, s.completed)),
    row('Merge-group eject rate', (s) => share(s.mgEjected, s.mgCompleted)),
    row('Skipped-run noise', (s) => share(s.skipped, s.allCompleted)),
    `| Repos whose critical path grew | - | ${agg.criticalPathGrew} |`,
    `| Repos whose re-run rate grew | - | ${agg.rerunGrew} |`,
    '',
    '### Workflow audit (current)',
    '',
    '| Check | Value |',
    '|---|---|',
    ...audit.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    READING,
    '',
  ].join('\n')
}

const arrow = (a, b) => `${a} → ${b}`
const pc = (x) => (x == null ? '-' : `${Math.round(100 * x)}%`)

export function repoTable(agg) {
  const rows = Object.entries(agg.perRepo).sort((a, b) => b[1].cur.completed - a[1].cur.completed).map(([k, r]) => {
    const f = [r.criticalPathGrew && 'critical path', r.rerunGrew && 're-run', r.audit.queueWithoutMergeGroup && 'queue without merge_group', r.audit.pathFilterNoAggregate && 'path filters without aggregate'].filter(Boolean)
    return `| ${k} | ${r.cur.mergedPrs} | ${r.cur.completed} | ${arrow(duration(r.prev.runP50), duration(r.cur.runP50))} | ${arrow(pc(r.prev.rerunShare), pc(r.cur.rerunShare))} | ${f.join(', ') || '-'} |`
  })
  return ['Local detail: never paste into a PR, issue or committed file.', '', '| Repo | Merged PRs | Runs | Run time p50 prev→cur | Re-run share prev→cur | Flags |', '|---|---|---|---|---|---|', ...rows, ''].join('\n')
}

export async function main(argv, runner = ghRunner, now = Date.now()) {
  const i = argv.indexOf('--range')
  const range = i >= 0 ? argv[i + 1] : '30d'
  const days = parseRange(range)
  const repos = await collect(runner, days, now)
  if (!repos) return console.log(SKIPPED)
  const agg = analyze(repos)
  process.stdout.write(report(agg, range))
  if (argv.includes('--repos')) process.stdout.write(`\n${repoTable(agg)}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
