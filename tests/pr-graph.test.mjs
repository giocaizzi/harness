import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunks, graph, report, repoTable, collect, parseRange, main, fmtDuration, HOT_SHARE, HOT_MIN } from '../scripts/pr-graph.mjs'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const pr = (o) => ({ repo: 'h/acme/app', base: 'main', head: 'x', defaultBranch: 'main', created: Date.parse('2026-10-01T00:00:00Z'), closed: null, paths: [], fileCount: 0, ...o })
const t = (d) => Date.parse(`2026-10-${d}T00:00:00Z`)

test('parseRange', () => {
  assert.equal(parseRange('30d'), 30)
  assert.equal(parseRange('2w'), 14)
  assert.throws(() => parseRange('x'))
})

test('open-together overlap is a should-have-been-stacked pair', () => {
  const a = pr({ head: 'a', paths: ['src/a.js'], created: t('01'), closed: t('05') })
  const b = pr({ head: 'b', paths: ['src/a.js', 'x'], created: t('03') })
  const g = graph([a, b], NOW)
  assert.equal(g.overlapPairs, 1)
  assert.equal(g.overlapPrs, 2)
  assert.equal(g.manifestOnly, 0)
})

test('not open together is no pair', () => {
  const a = pr({ head: 'a', paths: ['f'], created: t('01'), closed: t('02') })
  const b = pr({ head: 'b', paths: ['f'], created: t('03') })
  assert.equal(graph([a, b], NOW).overlapPairs, 0)
})

test('already stacked pair is counted apart, and stacked share', () => {
  const a = pr({ head: 'a', paths: ['f'], created: t('01') })
  const b = pr({ head: 'b', base: 'a', paths: ['f'], created: t('02') })
  const g = graph([a, b], NOW)
  assert.equal(g.stackedPairs, 1)
  assert.equal(g.overlapPairs, 0)
  assert.equal(g.stacked, 1)
  assert.match(report(g, '30d'), /Stacked share[^\n]*50% \(1\)/)
})

test('manifest-only overlap, and pairs stay inside one repo', () => {
  const a = pr({ head: 'a', paths: ['plugins/p/.claude-plugin/plugin.json', 'm.csproj'], created: t('01') })
  const b = pr({ head: 'b', paths: ['plugins/q/.claude-plugin/plugin.json', 'plugins/p/.claude-plugin/plugin.json', 'm.csproj'], created: t('02') })
  const c = pr({ head: 'c', repo: 'h/acme/other', paths: ['plugins/p/.claude-plugin/plugin.json'], created: t('02') })
  const g = graph([a, b, c], NOW)
  assert.equal(g.overlapPairs, 1)
  assert.equal(g.manifestOnly, 1)
  assert.equal(g.repos, 2)
})

test('truncated file lists are counted', () => {
  assert.equal(graph([pr({ fileCount: 150 })], NOW).truncated, 1)
})

test('chunks split the window into 7-day parts', () => {
  const c = chunks(30, NOW)
  assert.equal(c[0][0], '2026-09-30')
  assert.equal(c.at(-1)[1], '2026-10-30')
  assert.ok(c.every(([f, to]) => f <= to))
  assert.equal(c.length, 5)
})

const node = (n) => ({ number: n, baseRefName: 'main', headRefName: `h${n}`, createdAt: '2026-10-20T00:00:00Z', closedAt: null, mergedAt: null, additions: 3, deletions: 4, repository: { nameWithOwner: 'acme/app', defaultBranchRef: { name: 'main' } }, files: { totalCount: 1, nodes: [{ path: 'f' }] } })
const hostsJson = JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true }], 'bad.example': [{ state: 'error', active: true }] } })

function fakeRunner(pages) {
  const calls = []
  const runner = async (args) => {
    calls.push(args)
    if (args[0] === 'auth') return hostsJson
    const cursor = args.find((a) => a.startsWith('cursor='))
    const key = cursor ? cursor.slice(7) : 'first'
    return JSON.stringify({ data: { search: { pageInfo: { hasNextPage: key === 'first', endCursor: 'c1' }, nodes: pages[key] ?? [] } } })
  }
  return { runner, calls }
}

test('collect pages, chunks and dedupes', async () => {
  const { runner, calls } = fakeRunner({ first: [node(1), node(2)], c1: [node(2), node(3)] })
  const prs = await collect(runner, 30, NOW)
  const queries = calls.filter((c) => c[0] === 'api')
  assert.equal(queries.length, 5 * 2)
  assert.ok(queries.every((c) => c.includes('github.com')))
  assert.equal(prs.length, 3)
})

test('a failed query continues without naming repos', async () => {
  const runner = async (args) => {
    if (args[0] === 'auth') return hostsJson
    throw new Error('boom acme/app')
  }
  const err = console.error
  const seen = []
  console.error = (m) => seen.push(m)
  try {
    assert.deepEqual(await collect(runner, 7, NOW), [])
  } finally {
    console.error = err
  }
  assert.ok(seen.length && seen.every((m) => !m.includes('acme')))
})

test('skips with no auth', async () => {
  assert.equal(await collect(async () => { throw new Error('gh missing') }, 7, NOW), null)
  assert.equal(await collect(async () => JSON.stringify({ hosts: {} }), 7, NOW), null)
  const log = console.log
  const out = []
  console.log = (m) => out.push(m)
  try {
    await main(['--range', '7d'], async () => { throw new Error('x') }, NOW)
  } finally {
    console.log = log
  }
  assert.deepEqual(out, ['PR graph: skipped (gh is not installed or not authenticated).'])
})

test('report has no repo names; repos table does', () => {
  const g = graph([pr({})], NOW)
  assert.ok(!report(g, '30d').includes('acme'))
  assert.match(report(g, '30d'), /## PR graph \(last 30d, every repo gh can reach\)/)
  assert.match(repoTable(g), /Local detail: never paste[\s\S]*acme\/app/)
})

test('perDay is PRs over the window days', () => {
  assert.equal(graph([pr({}), pr({}), pr({})], NOW, 30).perDay, 0.1)
  assert.match(report(graph([pr({}), pr({}), pr({})], NOW, 2), '2d'), /PRs per day \| 1\.5 \|/)
})

test('linesQ is nearest-rank over all PRs', () => {
  const g = graph([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => pr({ lines: n * 10 })), NOW)
  assert.deepEqual(g.linesQ, { p25: 30, p50: 50, p75: 80, p90: 90 })
  assert.equal(graph([], NOW).linesQ, null)
  assert.match(report(g, '30d'), /Changed lines p25 \/ p50 \/ p75 \/ p90 \| 30 \/ 50 \/ 80 \/ 90 \|/)
  assert.match(report(graph([], NOW), '30d'), /Changed lines[^\n]*\| - \|/)
})

test('small counts 10 lines or fewer', () => {
  const g = graph([pr({ lines: 10 }), pr({ lines: 11 }), pr({ lines: 0 })], NOW)
  assert.equal(g.small, 2)
  assert.match(report(g, '30d'), /10 lines or fewer \| 67% \(2\)/)
})

test('manifestOnlyPrs counts PRs whose paths are all manifests', () => {
  const g = graph([pr({ paths: ['plugin.json', 'a/package.json'] }), pr({ paths: ['plugin.json', 'src/x.js'] }), pr({ paths: [] })], NOW)
  assert.equal(g.manifestOnlyPrs, 1)
  assert.match(report(g, '30d'), /Manifest-only PRs \| 33% \(1\)/)
})

test('openToMergeP50 uses merged PRs only; fmtDuration is compact', () => {
  const H = 3600000
  const m = (h) => pr({ created: t('01'), merged: t('01') + h * H })
  const g = graph([m(1), m(3), m(10), pr({})], NOW)
  assert.equal(g.openToMergeP50, 3 * H)
  assert.equal(graph([pr({})], NOW).openToMergeP50, null)
  assert.equal(fmtDuration(null), '-')
  assert.equal(fmtDuration(45 * 60000), '45m')
  assert.equal(fmtDuration(5.5 * H), '5h 30m')
  assert.equal(fmtDuration(50 * H), '2d 2h')
  assert.match(report(g, '30d'), /Median open-to-merge \| 3h 0m \|/)
})

test('hot files are dropped from the refined pairs only', () => {
  assert.equal(HOT_SHARE, 0.2)
  assert.equal(HOT_MIN, 3)
  const open = { created: t('01') }
  // 5 PRs: src/hot.js in 3 (> 20% and >= 3) is hot; a1/a2 share only it, b1/b2 share a cold file
  const a1 = pr({ ...open, head: 'a1', paths: ['src/hot.js'] })
  const a2 = pr({ ...open, head: 'a2', paths: ['src/hot.js'] })
  const a3 = pr({ ...open, head: 'a3', paths: ['src/hot.js', 'z1'] })
  const b1 = pr({ ...open, head: 'b1', paths: ['src/cold.js'] })
  const b2 = pr({ ...open, head: 'b2', paths: ['src/cold.js'] })
  const g = graph([a1, a2, a3, b1, b2], NOW)
  assert.equal(g.hotFiles, 1)
  assert.equal(g.overlapPairs, 4)
  assert.equal(g.refinedPairs, 1)
  assert.equal(g.perRepo['h/acme/app'].refinedPairs, 1)
  assert.match(report(g, '30d'), /hot files dropped[^\n]*\| 1 \|/)
  assert.match(repoTable(g), /\| 5 \| 0 \| 4 \| 1 \|/)
})

test('the HOT_MIN floor keeps a small repo from calling a shared file hot', () => {
  const g = graph([pr({ head: 'a', paths: ['f'] }), pr({ head: 'b', paths: ['f'] })], NOW)
  assert.equal(g.hotFiles, 0)
  assert.equal(g.refinedPairs, 1)
})

test('collect maps lines and merged', async () => {
  const n = { ...node(1), mergedAt: '2026-10-21T00:00:00Z', additions: 5, deletions: 7 }
  const { runner } = fakeRunner({ first: [n], c1: [] })
  const [p] = await collect(runner, 7, NOW)
  assert.equal(p.lines, 12)
  assert.equal(p.merged, Date.parse('2026-10-21T00:00:00Z'))
  const [q] = await collect(fakeRunner({ first: [{ ...node(2), additions: undefined, deletions: undefined }], c1: [] }).runner, 7, NOW)
  assert.equal(q.lines, 0)
  assert.equal(q.merged, null)
})

test('a file under the share threshold is not hot even with HOT_MIN PRs', () => {
  const list = Array.from({ length: 20 }, (_, i) => pr({ head: `p${i}`, paths: i < 3 ? ['f'] : [`u${i}`] }))
  const g = graph(list, NOW)
  assert.equal(g.hotFiles, 0)
  assert.equal(g.refinedPairs, 3)
})
