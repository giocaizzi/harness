import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunks, graph, report, repoTable, collect, parseRange, main } from '../scripts/pr-graph.mjs'

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

const node = (n) => ({ number: n, baseRefName: 'main', headRefName: `h${n}`, createdAt: '2026-10-20T00:00:00Z', closedAt: null, mergedAt: null, repository: { nameWithOwner: 'acme/app', defaultBranchRef: { name: 'main' } }, files: { totalCount: 1, nodes: [{ path: 'f' }] } })
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
