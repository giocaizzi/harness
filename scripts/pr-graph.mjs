#!/usr/bin/env node
// PR graph: how consistently dependent PRs are stacked, plus PR size and pace, across every repo `gh` can reach
// (all owners, every authenticated host). Aggregates only; --repos adds a per-repo table for local reading. Runbook: docs/agent-review.md.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const DAY = 86400000
const SKIPPED = 'PR graph: skipped (gh is not installed or not authenticated).'
const MANIFESTS = new Set(['package.json', 'plugin.json', 'marketplace.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'VERSION', '.release-please-manifest.json', 'CHANGELOG.md'])

export const HOT_SHARE = 0.2
export const HOT_MIN = 3

const QUERY = `query($q:String!,$cursor:String){search(query:$q,type:ISSUE,first:50,after:$cursor){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{number baseRefName headRefName createdAt closedAt mergedAt additions deletions repository{nameWithOwner defaultBranchRef{name}} files(first:100){totalCount nodes{path}}}}}}`

export function parseRange(s = '30d') {
  const m = /^(\d+)([dw])$/.exec(s)
  if (!m || !Number(m[1])) throw new Error(`bad --range "${s}" (use Nd or Nw)`)
  return Number(m[1]) * (m[2] === 'w' ? 7 : 1)
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10)

// 7-day [from, to] date windows (inclusive) covering the last `days` days up to now; search returns <= 1000 hits per query.
export function chunks(days, now) {
  const out = []
  const end = Math.floor(now / DAY) * DAY
  for (let s = end - days * DAY; s <= end; s += 7 * DAY) out.push([day(s), day(Math.min(s + 6 * DAY, end))])
  return out
}

export async function ghRunner(args) {
  return (await run('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout
}

export async function hosts(runner) {
  try {
    const j = JSON.parse(await runner(['auth', 'status', '--json', 'hosts']))
    return Object.entries(j.hosts || {}).filter(([, accts]) => (accts || []).some((a) => a.state === 'success' && a.active !== false)).map(([h]) => h)
  } catch {
    return []
  }
}

export async function fetchPrs(runner, host, from, to) {
  const out = []
  let cursor = null
  do {
    const args = ['api', 'graphql', '--hostname', host, '-f', `q=author:@me is:pr created:${from}..${to}`, '-f', `query=${QUERY}`]
    if (cursor) args.push('-f', `cursor=${cursor}`)
    const s = JSON.parse(await runner(args)).data.search
    for (const n of s.nodes) if (n && n.number != null) out.push({ host, ...n })
    cursor = s.pageInfo.hasNextPage ? s.pageInfo.endCursor : null
  } while (cursor)
  return out
}

export async function collect(runner, days, now = Date.now()) {
  const hs = await hosts(runner)
  if (!hs.length) return null
  const seen = new Map()
  for (const h of hs) {
    for (const [from, to] of chunks(days, now)) {
      try {
        for (const p of await fetchPrs(runner, h, from, to)) seen.set(`${h}/${p.repository.nameWithOwner}#${p.number}`, p)
      } catch {
        console.error(`PR graph: a query failed for ${from}..${to}; continuing`)
      }
    }
  }
  return [...seen.values()].map((p) => ({
    repo: `${p.host}/${p.repository.nameWithOwner}`,
    base: p.baseRefName,
    head: p.headRefName,
    defaultBranch: p.repository.defaultBranchRef?.name,
    created: Date.parse(p.createdAt),
    closed: p.closedAt ? Date.parse(p.closedAt) : null,
    merged: p.mergedAt ? Date.parse(p.mergedAt) : null,
    lines: (p.additions ?? 0) + (p.deletions ?? 0),
    paths: (p.files?.nodes || []).map((f) => f.path),
    fileCount: p.files?.totalCount ?? 0,
  }))
}

const manifestOnly = (paths) => paths.length > 0 && paths.every((p) => MANIFESTS.has(p.split('/').pop()) || p.endsWith('.csproj'))
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '0%')
const nearest = (sorted, q) => (sorted.length ? sorted[Math.ceil(q * sorted.length) - 1] : null)

// Compact duration: `Xm`, `Xh Ym`, `Xd Yh`; '-' when unknown.
export function fmtDuration(ms) {
  if (ms == null) return '-'
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
}

// Paths touched by more than HOT_SHARE of a repo's PRs and by at least HOT_MIN of them.
const hotFiles = (list) => {
  const n = new Map()
  for (const p of list) for (const x of new Set(p.paths)) n.set(x, (n.get(x) || 0) + 1)
  return new Set([...n].filter(([, c]) => c > HOT_SHARE * list.length && c >= HOT_MIN).map(([x]) => x))
}
const isStacked = (p) => Boolean(p.defaultBranch) && p.base !== p.defaultBranch

export function graph(prs, now = Date.now(), days = 30) {
  const byRepo = new Map()
  for (const p of prs) {
    if (!byRepo.has(p.repo)) byRepo.set(p.repo, [])
    byRepo.get(p.repo).push(p)
  }
  const lines = prs.map((p) => p.lines ?? 0).sort((a, b) => a - b)
  const mergeMs = prs.filter((p) => p.merged != null).map((p) => p.merged - p.created).sort((a, b) => a - b)
  const agg = { perDay: prs.length / days, linesQ: prs.length ? { p25: nearest(lines, 0.25), p50: nearest(lines, 0.5), p75: nearest(lines, 0.75), p90: nearest(lines, 0.9) } : null, small: prs.filter((p) => (p.lines ?? 0) <= 10).length, manifestOnlyPrs: prs.filter((p) => manifestOnly(p.paths)).length, openToMergeP50: nearest(mergeMs, 0.5), refinedPairs: 0, hotFiles: 0, prs: prs.length, repos: byRepo.size, stacked: prs.filter(isStacked).length, stackedPairs: 0, overlapPairs: 0, manifestOnly: 0, truncated: prs.filter((p) => p.fileCount > 100).length, perRepo: {} }
  const inOverlap = new Set()
  for (const [repo, list] of byRepo) {
    const r = { prs: list.length, stacked: list.filter(isStacked).length, stackedPairs: 0, overlapPairs: 0, refinedPairs: 0 }
    const hot = hotFiles(list)
    agg.hotFiles += hot.size
    const sorted = [...list].sort((a, b) => a.created - b.created)
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]
        const b = sorted[j]
        if (!(a.created <= b.created && b.created < (a.closed ?? now))) continue
        if (b.base === a.head || a.base === b.head) {
          r.stackedPairs++
          continue
        }
        const bp = new Set(b.paths)
        const shared = a.paths.filter((x) => bp.has(x))
        if (!shared.length) continue
        r.overlapPairs++
        if (shared.some((x) => !hot.has(x))) r.refinedPairs++
        if (manifestOnly(shared)) agg.manifestOnly++
        inOverlap.add(a).add(b)
      }
    }
    agg.stackedPairs += r.stackedPairs
    agg.overlapPairs += r.overlapPairs
    agg.refinedPairs += r.refinedPairs
    agg.perRepo[repo] = r
  }
  agg.overlapPrs = inOverlap.size
  return agg
}

export function report(agg, range) {
  const rows = [
    ['PRs', agg.prs],
    ['Repos', agg.repos],
    ['PRs per day', agg.perDay.toFixed(1)],
    ['Changed lines p25 / p50 / p75 / p90', agg.linesQ ? `${agg.linesQ.p25} / ${agg.linesQ.p50} / ${agg.linesQ.p75} / ${agg.linesQ.p90}` : '-'],
    ['PRs of 10 lines or fewer', `${pct(agg.small, agg.prs)} (${agg.small})`],
    ['Manifest-only PRs', `${pct(agg.manifestOnlyPrs, agg.prs)} (${agg.manifestOnlyPrs})`],
    ['Median open-to-merge', fmtDuration(agg.openToMergeP50)],
    ['Stacked share (base is not the default branch)', `${pct(agg.stacked, agg.prs)} (${agg.stacked})`],
    ['Open-together pairs already stacked', agg.stackedPairs],
    ['Should-have-been-stacked pairs, hot files dropped (share a file that is not hot)', agg.refinedPairs],
    ['Hot files dropped (touched by more than 20% of a repo\'s PRs, at least 3)', agg.hotFiles],
    ['Should-have-been-stacked pairs, any shared file (secondary)', agg.overlapPairs],
    ['of which overlap only on version manifests', agg.manifestOnly],
    ['Share of PRs in a should-have-been-stacked pair', pct(agg.overlapPrs, agg.prs)],
    ['PRs with more than 100 files (overlap undercounted)', agg.truncated],
  ]
  return [`## PR graph (last ${range}, every repo gh can reach)`, '', '| Measure | Value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`), '', 'Target: hot-file-free should-have-been-stacked pairs trend to 0 and the stacked share rises (github-workflow, Landing a change). How to read each figure: .agents/skills/agent-review/references/reading.md (PR graph).', ''].join('\n')
}

export function repoTable(agg) {
  const rows = Object.entries(agg.perRepo).sort((a, b) => b[1].overlapPairs - a[1].overlapPairs).map(([k, r]) => `| ${k} | ${r.prs} | ${r.stacked} | ${r.overlapPairs} | ${r.refinedPairs} |`)
  return ['Local detail: never paste into a PR, issue or committed file.', '', '| Repo | PRs | Stacked | Overlap pairs | Refined pairs |', '|---|---|---|---|---|', ...rows, ''].join('\n')
}

// A gh failure message holds the command line, which names a repo: print the message only for a bad --range.
export const errorLine = (e) => (/^bad --range/.test(e?.message) ? e.message : 'PR graph: failed with an unexpected error (detail withheld, it may name a repo)')

export async function main(argv, runner = ghRunner, now = Date.now()) {
  const i = argv.indexOf('--range')
  const range = i >= 0 ? argv[i + 1] : '30d'
  const days = parseRange(range)
  const prs = await collect(runner, days, now)
  if (!prs) return console.log(SKIPPED)
  const agg = graph(prs, now, days)
  process.stdout.write(report(agg, range))
  if (argv.includes('--repos')) process.stdout.write(`\n${repoTable(agg)}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(errorLine(e))
    process.exit(1)
  })
}
