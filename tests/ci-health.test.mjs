import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windows, windowOf, dateChunks, percentile, duration, windowStats, mergeStats, flags, auditWorkflows, analyze, report, repoTable, collect, countFlakes, sampleWaits, MIN_RUNS, GROWTH, main, limited, GhError, parseIncluded, includeRunner, retrying, MAX_WAIT, fetchChunk, splitRange, fetchWorkflows, hasMergeQueue, errorLine, isPartial, retryAfterSeconds } from '../scripts/ci-health.mjs'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const iso = (d, t = '00:00:00') => `2026-10-${d}T${t}Z`
let id = 0
const run = (o = {}) => ({ id: ++id, event: 'pull_request', status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: 'a', workflow_id: 1, created_at: iso('05', '10:00:00'), run_started_at: iso('05', '10:01:00'), updated_at: iso('05', '10:03:00'), ...o })
const S = (runs, merged = 0, waits = [], flakes = 0) => windowStats(runs, merged, waits, flakes)
const MIN = 60000

test('windows split by UTC day, with a boundary', () => {
  const w = windows(30, NOW)
  assert.deepEqual(w, { prevFrom: '2026-09-01', prevTo: '2026-09-30', curFrom: '2026-10-01', curTo: '2026-10-30' })
  assert.equal(windowOf('2026-10-01', w), 'cur')
  assert.equal(windowOf('2026-09-30', w), 'prev')
  assert.equal(windowOf('2026-08-31', w), null)
  assert.equal(windowOf('2026-10-31', w), null)
})

test('dateChunks split into 7-day parts', () => {
  const c = dateChunks('2026-09-01', '2026-10-30')
  assert.equal(c.length, 9)
  assert.deepEqual(c[0], ['2026-09-01', '2026-09-07'])
  assert.deepEqual(c.at(-1), ['2026-10-27', '2026-10-30'])
})

test('runs per merged PR keeps PR and merge-group apart and excludes skipped', () => {
  const s = S([run(), run(), run({ event: 'pull_request_target' }), run({ event: 'merge_group' }), run({ conclusion: 'skipped' }), run({ event: 'merge_group', conclusion: 'skipped' }), run({ event: 'push' })], 2)
  assert.equal(s.prRunsPerPr, 1.5)
  assert.equal(s.mgRunsPerPr, 0.5)
  assert.equal(S([run()], 0).prRunsPerPr, null)
  assert.match(report(analyze([{ key: 'h/o/r', prev: { runs: [], mergedPrs: 0, waits: [], flakes: 0 }, cur: { runs: [run()], mergedPrs: 0, waits: [], flakes: 0 }, files: [], hasQueue: false }]), '30d'), /\| PR runs per merged PR \| - \| - \|/)
})

test('run time and queue-to-green percentiles', () => {
  const runs = [1, 2, 3, 4, 10].map((m) => run({ run_started_at: iso('05', '10:01:00'), created_at: iso('05', '10:00:00'), updated_at: new Date(Date.parse(iso('05', '10:01:00')) + m * MIN).toISOString() }))
  const s = S([...runs, run({ conclusion: 'failure', updated_at: iso('05', '11:00:00') })])
  assert.equal(s.runP50, 3 * MIN)
  assert.equal(s.runP90, 59 * MIN)
  assert.equal(s.greenP50, 4 * MIN)
  assert.equal(s.greenP90, 11 * MIN)
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile([5, 1, 3], 0.5), 3)
  assert.equal(percentile([1, 2], 0.9), 2)
})

test('durations format', () => {
  assert.equal(duration(45000), '45s')
  assert.equal(duration(125000), '2m 5s')
  assert.equal(duration(3900000), '1h 5m')
  assert.equal(duration(null), '-')
})

test('queue wait percentiles come from the sampled jobs', () => {
  const s = S([], 0, [10000, 20000, 30000, 40000])
  assert.equal(s.waitP50, 20000)
  assert.equal(s.waitP90, 40000)
})

test('cancelled, failure and re-run shares use completed non-skipped runs', () => {
  const s = S([run(), run({ conclusion: 'cancelled' }), run({ conclusion: 'cancelled' }), run({ conclusion: 'failure' }), run({ conclusion: 'timed_out' }), run({ run_attempt: 2 }), run({ conclusion: 'skipped' }), run({ status: 'in_progress', conclusion: null })])
  assert.equal(s.completed, 6)
  assert.equal(s.cancelledShare, 2 / 6)
  assert.equal(s.failureShare, 2 / 6)
  assert.equal(s.rerunShare, 1 / 6)
})

test('flake proxy divides the flakes by completed non-skipped runs', () => {
  const s = S([run(), run(), run(), run(), run({ conclusion: 'skipped' })], 0, [], 1)
  assert.equal(s.flakeShare, 0.25)
  assert.equal(s.flakes, 1)
})

test('flake proxy counts a re-run success whose previous attempt failed', async () => {
  const calls = []
  const runner = async (args) => {
    calls.push(args.find((a) => a.startsWith('repos/')))
    return JSON.stringify({ conclusion: args.some((a) => a.endsWith('/attempts/2')) ? 'failure' : 'cancelled' })
  }
  const runs = [run({ id: 1, run_attempt: 3, conclusion: 'success' }), run({ id: 2, run_attempt: 2 }), run({ id: 3, run_attempt: 2, conclusion: 'failure' }), run({ id: 4 })]
  assert.equal(await countFlakes(runner, 'h', 'acme/app', runs), 1)
  assert.deepEqual(calls, ['repos/acme/app/actions/runs/1/attempts/2', 'repos/acme/app/actions/runs/2/attempts/1'])
})

test('merge-group eject rate', () => {
  const s = S([run({ event: 'merge_group' }), run({ event: 'merge_group', conclusion: 'failure' }), run({ event: 'merge_group', conclusion: 'cancelled' }), run({ event: 'merge_group', conclusion: 'timed_out' }), run({ event: 'merge_group', conclusion: 'skipped' }), run({ conclusion: 'failure' })])
  assert.equal(s.ejectRate, 0.75)
  assert.equal(S([run()]).ejectRate, null)
})

test('skipped-run noise is skipped over all completed runs', () => {
  const s = S([run(), run(), run({ conclusion: 'skipped' }), run({ status: 'queued', conclusion: null })])
  assert.equal(s.skipped, 1)
  assert.equal(s.skippedNoise, 1 / 3)
})

test('aggregate sums raw tallies, not percentages', () => {
  const a = S([run(), run({ conclusion: 'failure' })])
  const b = S([run(), run(), run(), run(), run(), run(), run(), run({ conclusion: 'failure' })])
  const m = mergeStats([a, b])
  assert.equal(m.failureShare, 2 / 10)
  assert.equal(m.completed, 10)
})

const stats = (n, minutes, rerun = 0) => S(Array.from({ length: n }, (_, i) => run({ run_attempt: i < rerun ? 2 : 1, run_started_at: iso('05', '10:00:00'), updated_at: new Date(Date.parse(iso('05', '10:00:00')) + minutes * MIN).toISOString() })))

test('criticalPathGrew needs the growth and the minimum runs', () => {
  assert.equal(GROWTH, 1.2)
  assert.equal(MIN_RUNS, 5)
  assert.equal(flags(stats(5, 10), stats(5, 12)).criticalPathGrew, true)
  assert.equal(flags(stats(5, 10), stats(5, 11.9)).criticalPathGrew, false)
  assert.equal(flags(stats(4, 10), stats(5, 20)).criticalPathGrew, false)
  assert.equal(flags(stats(5, 10), stats(4, 20)).criticalPathGrew, false)
})

test('rerunGrew needs a higher share and the minimum runs', () => {
  assert.equal(flags(stats(5, 10, 1), stats(5, 10, 2)).rerunGrew, true)
  assert.equal(flags(stats(5, 10, 2), stats(5, 10, 2)).rerunGrew, false)
  assert.equal(flags(stats(5, 10, 0), stats(4, 10, 4)).rerunGrew, false)
  assert.equal(flags(stats(4, 10, 0), stats(5, 10, 4)).rerunGrew, false)
})

const wf = (text) => [{ path: '.github/workflows/a.yml', text }]
const SHA = 'a'.repeat(40)

test('audit: concurrency at top level or in a job', () => {
  const top = auditWorkflows(wf('on: push\nconcurrency:\n  group: x\njobs:\n  a:\n    runs-on: x\n'), false)
  const job = auditWorkflows(wf('on: push\njobs:\n  a:\n    concurrency: g\n    runs-on: x\n'), false)
  const none = auditWorkflows(wf('on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo concurrency:\n      - uses: o/r@v1\n        with:\n          concurrency: x\n'), false)
  assert.deepEqual([top.concurrency, job.concurrency, none.concurrency], [1, 1, 0])
})

test('audit: cancel-in-progress counts for pull_request workflows only', () => {
  const pr = 'on:\n  pull_request:\n    branches: [main]\nconcurrency:\n  group: x\n  cancel-in-progress: true\njobs: {}\n'
  assert.deepEqual([auditWorkflows(wf(pr)).prWorkflows, auditWorkflows(wf(pr)).prCancel], [1, 1])
  const off = auditWorkflows(wf(pr.replace('true', 'false')))
  assert.deepEqual([off.prWorkflows, off.prCancel], [1, 0])
  const push = auditWorkflows(wf(pr.replace('pull_request:', 'push:')))
  assert.deepEqual([push.prWorkflows, push.prCancel], [0, 0])
  assert.equal(auditWorkflows(wf('on: [push, pull_request]\njobs: {}\n')).prWorkflows, 1)
})

test('audit: timeout-minutes per job, reusable calls excluded', () => {
  const a = auditWorkflows(wf('on: push\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - run: x\n        timeout-minutes: 1\n  b:\n    runs-on: x\n    steps:\n      - run: x\n        timeout-minutes: 1\n  c:\n    uses: o/r/.github/workflows/w.yml@main\n    timeout-minutes: 9\n'), false)
  assert.deepEqual([a.jobs, a.reusable, a.timeouts], [3, 1, 1])
})

test('audit: queue without merge_group trigger', () => {
  const none = 'on:\n  pull_request:\njobs: {}\n'
  const mg = 'on:\n  merge_group:\njobs: {}\n'
  assert.equal(auditWorkflows(wf(none), true).queueWithoutMergeGroup, true)
  assert.equal(auditWorkflows(wf(none), false).queueWithoutMergeGroup, false)
  assert.equal(auditWorkflows(wf(mg), true).queueWithoutMergeGroup, false)
  assert.equal(auditWorkflows([...wf(none), ...wf(mg)], true).queueWithoutMergeGroup, false)
})

test('audit: path filters need an aggregate check', () => {
  const filtered = 'on:\n  pull_request:\n    paths:\n      - src/**\njobs:\n  a:\n    runs-on: x\n'
  assert.equal(auditWorkflows(wf(filtered)).pathFilterNoAggregate, true)
  assert.equal(auditWorkflows(wf('on:\n  push:\n    paths-ignore: [docs/**]\njobs:\n  a:\n    runs-on: x\n')).pathFilterNoAggregate, true)
  assert.equal(auditWorkflows(wf('on:\n  pull_request:\n    branches: [main]\njobs:\n  a:\n    runs-on: x\n')).pathFilterNoAggregate, false)
  const gate = 'on: push\njobs:\n  gate:\n    needs: [a]\n    if: always()\n    runs-on: x\n'
  assert.equal(auditWorkflows([...wf(filtered), { path: 'b.yml', text: gate }]).pathFilterNoAggregate, false)
  const noIf = 'on: push\njobs:\n  gate:\n    needs: [a]\n    runs-on: x\n'
  assert.equal(auditWorkflows([...wf(filtered), { path: 'b.yml', text: noIf }]).pathFilterNoAggregate, true)
})

test('audit: cache by action or input', () => {
  const act = auditWorkflows(wf('on: push\njobs:\n  a:\n    steps:\n      - uses: actions/cache@v4\n'))
  const inp = auditWorkflows(wf('on: push\njobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          cache: npm\n'))
  const none = auditWorkflows(wf('on: push\njobs:\n  a:\n    steps:\n      - run: echo\n'))
  assert.deepEqual([act.caches, inp.caches, none.caches], [1, 1, 0])
})

test('audit: SHA pinning skips local and docker refs', () => {
  const text = `on: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA}\n      - uses: actions/setup-node@v4 # note\n      - uses: ./local@v1\n      - uses: docker://alpine@v1\n      - uses: o/r/path@${SHA.slice(1)}\n      - uses: o/r2@${SHA}\n`
  const a = auditWorkflows(wf(text))
  assert.deepEqual([a.refs, a.pinned], [4, 2])
})

test('audit: top-level permissions only', () => {
  const top = auditWorkflows(wf('permissions:\n  contents: read\non: push\njobs: {}\n'))
  const job = auditWorkflows(wf('on: push\njobs:\n  a:\n    permissions:\n      contents: read\n'))
  assert.deepEqual([top.permissions, job.permissions], [1, 0])
})

// ---- collect, with a fake runner ----
const hostsJson = JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true }], 'bad.example': [{ state: 'error', active: true }] } })
const repoNode = { repository: { nameWithOwner: 'acme/app', defaultBranchRef: { name: 'main' } } }
const b64 = (s) => Buffer.from(s).toString('base64')
const field = (args, k) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1)

function fakeRunner(over = {}) {
  const calls = []
  const runner = async (args) => {
    calls.push(args)
    if (args[0] === 'auth') return hostsJson
    if (args[1] === 'graphql') {
      if (field(args, 'query').includes('issueCount')) return JSON.stringify({ data: { search: { issueCount: field(args, 'q').includes('2026-10-01..') ? 4 : 2 } } })
      const first = field(args, 'q').endsWith('2026-09-01..2026-09-07') && !field(args, 'cursor')
      const second = field(args, 'cursor') === 'c1'
      return JSON.stringify({ data: { search: { pageInfo: { hasNextPage: first, endCursor: 'c1' }, nodes: first || second ? [repoNode, repoNode] : [] } } })
    }
    const path = args[args.indexOf('GET') + 1]
    if (over[path]) return over[path](args)
    if (path === 'repos/acme/app/actions/runs') {
      const [from] = field(args, 'created').split('..')
      const page = Number(field(args, 'page'))
      if (from === '2026-10-06') return JSON.stringify({ workflow_runs: Array.from({ length: page === 1 ? 100 : 2 }, (_, i) => run({ id: 1000 + (page === 1 ? i : 99 + i) })) })
      if (from === '2026-09-29') return JSON.stringify({ workflow_runs: [run({ id: 5000, created_at: '2026-09-30T10:00:00Z' }), run({ id: 5001, created_at: '2026-09-29T23:00:00Z' }), run({ id: 5002, created_at: '2026-09-30T10:00:00Z' })] })
      if (from === '2026-10-27') return JSON.stringify({ workflow_runs: [run({ id: 5000, created_at: '2026-09-30T10:00:00Z' })] })
      return JSON.stringify({ workflow_runs: [] })
    }
    if (path.endsWith('/jobs')) return JSON.stringify({ jobs: [{ created_at: iso('05', '10:00:00'), started_at: iso('05', '10:00:20'), conclusion: 'success' }, { created_at: iso('05', '10:00:00'), started_at: iso('05', '10:09:00'), conclusion: 'skipped' }] })
    if (path === 'repos/acme/app/contents/.github/workflows') return JSON.stringify([{ type: 'file', name: 'a.yml', path: '.github/workflows/a.yml' }, { type: 'file', name: 'README.md', path: '.github/workflows/README.md' }])
    if (path === 'repos/acme/app/contents/.github/workflows/a.yml') return JSON.stringify({ content: b64('on: merge_group\njobs: {}\n') })
    if (path === 'repos/acme/app/rules/branches/main') return JSON.stringify([{ type: 'merge_queue' }])
    throw new GhError(404)
  }
  return { runner, calls }
}

test('collect pages, chunks and dedupes repos, runs and windows', async () => {
  const { runner, calls } = fakeRunner()
  const repos = await collect(runner, 30, NOW)
  assert.equal(repos.length, 1)
  const r = repos[0]
  assert.equal(r.key, 'github.com/acme/app')
  assert.equal(calls.filter((c) => c[1] === 'graphql').length, 9 + 1 + 2)
  assert.ok(calls.filter((c) => c[0] === 'api').every((c) => c.includes('github.com') && c.includes('--hostname')))
  assert.equal(r.cur.runs.length, 101)
  assert.deepEqual(r.prev.runs.map((x) => x.id), [5000, 5001, 5002])
  assert.deepEqual([r.prev.mergedPrs, r.cur.mergedPrs], [2, 4])
  assert.deepEqual(Object.keys(r.cur.runs[0]).sort(), ['conclusion', 'created_at', 'event', 'head_sha', 'id', 'run_attempt', 'run_started_at', 'status', 'updated_at', 'workflow_id'])
  assert.equal(r.files.length, 1)
  assert.equal(r.hasQueue, true)
})

test('queue wait samples at most 30 recent completed PR runs and skips skipped jobs', async () => {
  const { runner, calls } = fakeRunner()
  const repos = await collect(runner, 30, NOW)
  assert.equal(repos[0].cur.waits.length, 30)
  assert.ok(repos[0].cur.waits.every((w) => w === 20000))
  assert.equal(repos[0].prev.waits.length, 3)
  assert.equal(calls.filter((c) => c.some((a) => a.endsWith('/jobs'))).length, 33)
  const runs = [run({ id: 1, event: 'push' }), run({ id: 2, status: 'in_progress' }), run({ id: 3, created_at: iso('06', '00:00:00') }), run({ id: 4, event: 'merge_group', created_at: iso('07', '00:00:00') })]
  const seen = []
  const w = await sampleWaits(async (a) => { seen.push(a[5]); return JSON.stringify({ jobs: [{ created_at: iso('05'), started_at: iso('05', '00:00:05'), conclusion: 'success' }] }) }, 'h', 'acme/app', runs)
  assert.deepEqual(seen, ['repos/acme/app/actions/runs/4/jobs', 'repos/acme/app/actions/runs/3/jobs'])
  assert.deepEqual(w, [5000, 5000])
})

test('a failed query continues and names no repo', async () => {
  const { runner } = fakeRunner({ 'repos/acme/app/actions/runs': async () => { throw new Error('boom acme/app') } })
  const err = console.error
  const seen = []
  console.error = (m) => seen.push(m)
  try {
    const repos = await collect(runner, 30, NOW, 6, { tries: 1 })
    assert.equal(repos[0].cur.runs.length, 0)
    assert.equal(repos[0].files.length, 1)
    assert.equal(repos[0].failures.runs, 9)
    assert.ok(isPartial(repos[0]))
    const agg = analyze(repos)
    assert.deepEqual([agg.repos, agg.partial, agg.failedQueries, agg.cur.completed], [0, 1, 9, 0])
    assert.match(report(agg, '30d'), /\| Repos left out as partial[^\n]*\| - \| 1 \|\n\| Queries failed after retries \| - \| 9 \(runs 9\) \|/)
    assert.match(repoTable(agg), /github\.com\/acme\/app \| unknown \| unknown[^\n]*partial: 9 failed, 0 truncated/)
  } finally {
    console.error = err
  }
  assert.ok(seen.includes('CI health: a query failed; continuing'))
  assert.ok(seen.includes('CI health: 1/1 repos measured'))
  assert.ok(seen.every((m) => !m.includes('acme')))
})

test('limited keeps at most n gh calls in flight, and collect goes through it', async () => {
  let active = 0
  let peak = 0
  const slow = async (a) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 2))
    active--
    return a
  }
  const run = limited(slow, 3)
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5, 6, 7].map((n) => run(n))), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(peak, 3)
  const { runner } = fakeRunner()
  let inFlight = 0
  let top = 0
  const tracked = async (a) => {
    inFlight++
    top = Math.max(top, inFlight)
    await new Promise((r) => setTimeout(r, 1))
    try {
      return await runner(a)
    } finally {
      inFlight--
    }
  }
  const err = console.error
  console.error = () => {}
  try {
    await collect(tracked, 30, NOW, 2)
  } finally {
    console.error = err
  }
  assert.ok(top <= 2 && top > 1, `peak ${top}`)
})

test('skips with no auth', async () => {
  assert.equal(await collect(async () => { throw new Error('gh missing') }, 7, NOW), null)
  const log = console.log
  const out = []
  console.log = (m) => out.push(m)
  try {
    await main(['--range', '7d'], async () => { throw new Error('x') }, NOW)
  } finally {
    console.log = log
  }
  assert.deepEqual(out, ['CI health: skipped (gh is not installed or not authenticated).'])
})

test('report has no repo names and the exact rows; repoTable has them', () => {
  const rec = { key: 'github.com/acme/app', prev: { runs: [run({ run_attempt: 2 })], mergedPrs: 1, waits: [], flakes: 0 }, cur: { runs: [run({ event: 'merge_group' }), run()], mergedPrs: 2, waits: [30000], flakes: 1 }, files: wf('on: pull_request\njobs:\n  a:\n    timeout-minutes: 3\n'), hasQueue: true }
  const agg = analyze([rec])
  const out = report(agg, '30d')
  assert.ok(!out.includes('acme'))
  assert.match(out, /## CI health \(last 30d vs the 30d before, repos you merged a PR into, every host gh can reach\)/)
  assert.match(out, /\| Merged PRs \(all authors, in the measured repos\) \| 1 \| 2 \|/)
  assert.match(out, /\| Repos left out as partial[^\n]*\| - \| 0 \|/)
  assert.match(out, /repos you merged a PR into, every host gh can reach/)
  assert.match(out, /\| PR runs per merged PR \| 1\.0 \| 0\.5 \|/)
  assert.match(out, /\| Re-run share \| 100% \(1\) \| 0% \(0\) \|/)
  assert.match(out, /\| Queue wait p50 \/ p90 \(sampled jobs\) \| - \/ - \| 30s \/ 30s \|/)
  assert.match(out, /\| Jobs with timeout-minutes \| 100% \(1\/1\) \|/)
  assert.match(out, /\| Repos with a merge queue and no merge_group trigger \| 1 \|/)
  assert.match(out, /How to read each figure: \.agents\/skills\/agent-review\/references\/reading\.md \(CI health\)\./)
  assert.match(repoTable(agg), /Local detail: never paste[\s\S]*github\.com\/acme\/app \| 2 \| 2 \|[^\n]*queue without merge_group/)
})

// ---- failures are counted, never read as zeros (review round 1) ----
const quiet = async (fn) => {
  const err = console.error
  console.error = () => {}
  try {
    return await fn()
  } finally {
    console.error = err
  }
}

test('a failed merged-PR count is null and counted, and the repo is partial', async () => {
  const { runner } = fakeRunner()
  const failing = async (a) => {
    if (a[1] === 'graphql' && a.some((x) => x.includes('issueCount'))) throw new GhError(502)
    return runner(a)
  }
  const [r] = await quiet(() => collect(failing, 30, NOW, 6, { tries: 1 }))
  assert.deepEqual([r.prev.mergedPrs, r.cur.mergedPrs, r.failures.merged], [null, null, 2])
  const agg = analyze([r])
  assert.deepEqual([agg.repos, agg.partial, agg.cur.mergedPrs], [0, 1, 0])
})

test('a partial repo is left out of the figures and the flags', () => {
  const runs = Array.from({ length: 6 }, () => run({ run_attempt: 2 }))
  const ok = { key: 'h/acme/ok', prev: { runs: runs.map((x) => ({ ...x, run_attempt: 1 })), mergedPrs: 1, waits: [], flakes: 0 }, cur: { runs, mergedPrs: 1, waits: [], flakes: 0 }, files: [], hasQueue: false, failures: {}, truncated: 0 }
  const bad = { ...ok, key: 'h/acme/bad', failures: { jobs: 1 } }
  const cut = { ...ok, key: 'h/acme/cut', truncated: 1 }
  const agg = analyze([ok, bad, cut])
  assert.deepEqual([agg.repos, agg.partial, agg.rerunGrew, agg.cur.completed, agg.truncated, agg.failedQueries], [1, 2, 1, 6, 1, 1])
  assert.equal(agg.perRepo['h/acme/bad'].rerunGrew, false)
})

test('workflows: a 404 is no directory, another failure is counted, a file over 1 MB is skipped and counted', async () => {
  const t1 = {}
  assert.deepEqual(await fetchWorkflows(async () => { throw new GhError(404) }, 'h', 'acme/app', t1), { files: [], tooLarge: 0 })
  assert.equal(t1.workflows, undefined)
  const t2 = {}
  await quiet(() => fetchWorkflows(async () => { throw new GhError(500) }, 'h', 'acme/app', t2))
  assert.equal(t2.workflows, 1)
  const big = async (a) => (a.at(-1).endsWith('workflows') ? JSON.stringify([{ type: 'file', name: 'a.yml', path: '.github/workflows/a.yml' }, { type: 'file', name: 'b.yml', path: '.github/workflows/b.yml' }]) : a.at(-1).endsWith('a.yml') ? JSON.stringify({ content: '', encoding: 'none', size: 2000000 }) : JSON.stringify({ content: b64('on: push\n') }))
  const w = await fetchWorkflows(big, 'h', 'acme/app', {})
  assert.deepEqual([w.files.length, w.tooLarge], [1, 1])
  const agg = analyze([{ key: 'h/acme/app', prev: { runs: [], mergedPrs: 0, waits: [], flakes: 0 }, cur: { runs: [], mergedPrs: 0, waits: [], flakes: 0 }, files: w.files, tooLarge: w.tooLarge, hasQueue: false, failures: {}, truncated: 0 }])
  assert.match(report(agg, '30d'), /\| Workflow files skipped \(over 1 MB, the contents API limit\) \| 1 \|/)
})

test('merge queue: a 404 is no rules, another failure is counted', async () => {
  const t = {}
  assert.equal(await hasMergeQueue(async () => { throw new GhError(404) }, 'h', 'acme/app', 'main', t), false)
  assert.equal(t.queue, undefined)
  assert.equal(await hasMergeQueue(async () => { throw new GhError(403, {}, 'Upgrade to GitHub Pro or make this repository public to enable this feature.') }, 'h', 'acme/app', 'main', t), false)
  assert.equal(t.queue, undefined)
  await quiet(() => hasMergeQueue(async () => { throw new GhError(503) }, 'h', 'acme/app', 'main', t))
  await quiet(() => hasMergeQueue(async () => { throw new GhError(403, {}, 'Resource not accessible') }, 'h', 'acme/app', 'main', t))
  assert.equal(t.queue, 2)
})

test('a run range over the 1000 cap is refetched by day, 6 hours and hour, and an hour still over it is truncated', async () => {
  const seen = []
  const runner = async (a) => {
    const created = a.find((x) => x.startsWith('created=')).slice(8)
    const page = Number(a.find((x) => x.startsWith('page=')).slice(5))
    seen.push(`${created}#${page}`)
    if (seen.length > 400) throw new Error('paged past the 1000-run cap')
    const [from, to] = created.split('..')
    const over = from !== to && from.length === 10 ? true : from === '2026-10-02' || created === '2026-10-02T00:00:00Z..2026-10-02T05:59:59Z' || from === '2026-10-02T03:00:00Z'
    if (over) return JSON.stringify({ total_count: 1500, workflow_runs: Array.from({ length: 100 }, () => run()) })
    return JSON.stringify({ total_count: 1, workflow_runs: page === 1 ? [run()] : [] })
  }
  const tally = {}
  const runs = await fetchChunk(runner, 'h', 'acme/app', '2026-10-01', '2026-10-03', tally)
  assert.equal(tally.truncated, 1)
  // days 1 and 3 (1 each), day 2: three 6-hour parts (1 each), and the first 6 hours by hour: 5 hours (1 each) + one truncated hour (1000)
  assert.equal(runs.length, 2 + 3 + 5 + 1000)
  assert.equal(seen.filter((x) => x.startsWith('2026-10-01..2026-10-03')).length, 10)
  assert.ok(seen.includes('2026-10-02T06:00:00Z..2026-10-02T11:59:59Z#1'))
  assert.ok(seen.includes('2026-10-02T03:00:00Z..2026-10-02T03:59:59Z#1'))
})

test('splitRange ladders a week to days, a day to 6 hours, 6 hours to hours, and stops at an hour', () => {
  assert.deepEqual(splitRange('2026-10-01', '2026-10-02'), [['2026-10-01', '2026-10-01'], ['2026-10-02', '2026-10-02']])
  assert.deepEqual(splitRange('2026-10-02', '2026-10-02')[1], ['2026-10-02T06:00:00Z', '2026-10-02T11:59:59Z'])
  assert.equal(splitRange('2026-10-02', '2026-10-02').length, 4)
  assert.equal(splitRange('2026-10-02T00:00:00Z', '2026-10-02T05:59:59Z').length, 6)
  assert.equal(splitRange('2026-10-02T03:00:00Z', '2026-10-02T03:59:59Z'), null)
})

test('greenTimes drops negative durations from clock skew', () => {
  const s = S([run({ created_at: iso('05', '10:05:00'), updated_at: iso('05', '10:03:00') }), run()])
  assert.deepEqual(s.greenTimes, [3 * MIN])
})

test('includeRunner parses --include output and turns a failure into a GhError without the command line', async () => {
  const ok = await includeRunner(['api', 'x'], async (a) => {
    assert.equal(a[1], '--include')
    return 'HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 9\r\n\r\n{"a":1}'
  })
  assert.equal(ok, '{"a":1}')
  assert.equal(await includeRunner(['auth', 'status'], async (a) => a.join(' ')), 'auth status')
  const e = await includeRunner(['api', 'repos/acme/app'], async () => { throw Object.assign(new Error('Command failed: gh api repos/acme/app'), { stdout: 'HTTP/2.0 429 Too Many\nRetry-After: 7\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: 100\n\n{}' }) }).catch((x) => x)
  assert.ok(e instanceof GhError)
  assert.deepEqual([e.status, e.retryAfter, e.remaining, e.reset], [429, 7, 0, 100])
  const d = await includeRunner(['api', 'x'], async () => { throw Object.assign(new Error('x'), { stdout: 'HTTP/2.0 403 Forbidden\n\n{"message":"Upgrade to GitHub Pro"}' }) }).catch((x) => x)
  assert.deepEqual([d.status, d.detail, d.message], [403, 'Upgrade to GitHub Pro', 'gh call failed (HTTP 403)'])
  assert.ok(!e.message.includes('acme'))
  assert.deepEqual(parseIncluded('plain'), { status: null, headers: {}, body: 'plain' })
})

test('retrying honours Retry-After, backs off on 5xx, stops at the try limit and skips plain failures', async () => {
  const waits = []
  const wait = async (s) => { waits.push(s) }
  let n = 0
  const flaky = async () => {
    n++
    if (n === 1) throw new GhError(429, { 'retry-after': '7' })
    if (n === 2) throw new GhError(502)
    if (n === 3) throw new GhError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1030' })
    return 'ok'
  }
  assert.equal(await retrying(flaky, { wait, now: () => 1000000 })(['api']), 'ok')
  assert.deepEqual(waits, [7, 4, 31])
  let m = 0
  await assert.rejects(retrying(async () => { if (++m > 10) return 'retried past the limit'; throw new GhError(500) }, { tries: 3, wait })(['api']))
  assert.equal(m, 3)
  let p = 0
  await assert.rejects(retrying(async () => { p++; throw new GhError(403) }, { wait })(['api']))
  await assert.rejects(retrying(async () => { p++; throw new GhError(404) }, { wait })(['api']))
  assert.equal(p, 2)
  let q = 0
  await assert.rejects(retrying(async () => { q++; throw new GhError(429, { 'retry-after': String(MAX_WAIT + 1) }) }, { wait })(['api']))
  assert.equal(q, 1)
})

test('the top-level error line withholds a gh command line', () => {
  assert.equal(errorLine(new Error('bad --range "x" (use Nd or Nw)')), 'bad --range "x" (use Nd or Nw)')
  assert.ok(!errorLine(new Error('Command failed: gh api repos/acme/app/actions/runs')).includes('acme'))
})

test('collect retries a rate-limited call instead of counting it failed', async () => {
  const { runner } = fakeRunner()
  let hit = 0
  const once = async (a) => {
    if (a.includes('repos/acme/app/actions/runs') && !hit++) throw new GhError(429, { 'retry-after': '1' })
    return runner(a)
  }
  const waits = []
  const [r] = await quiet(() => collect(once, 30, NOW, 6, { wait: async (s) => { waits.push(s) } }))
  assert.deepEqual([r.failures.runs, waits], [undefined, [1]])
})

test('a failed repo-discovery query is counted in the report', async () => {
  const { runner } = fakeRunner()
  const failing = async (a) => {
    if (a[1] === 'graphql' && field(a, 'q').startsWith('author:@me') && field(a, 'q').endsWith('2026-10-27..2026-10-30')) throw new GhError(500)
    return runner(a)
  }
  const repos = await quiet(() => collect(failing, 30, NOW, 6, { tries: 1 }))
  const agg = analyze(repos)
  assert.deepEqual([repos.discoveryFailed, agg.failedQueries, agg.discoveryFailed], [1, 1, 1])
  assert.match(report(agg, '30d'), /\| Queries failed after retries \| - \| 1 \(discovery 1\) \|/)
})

test('Retry-After takes seconds or an HTTP date; anything else falls back to backoff', async () => {
  const now = Date.parse('2026-10-30T12:00:00Z')
  assert.equal(retryAfterSeconds('7', now), 7)
  assert.equal(retryAfterSeconds('Fri, 30 Oct 2026 12:00:09 GMT', now), 9)
  assert.equal(retryAfterSeconds('Fri, 30 Oct 2026 11:00:00 GMT', now), 0)
  assert.equal(retryAfterSeconds('soon', now), null)
  assert.equal(retryAfterSeconds(undefined, now), null)
  const e = new GhError(429, { 'retry-after': 'soon' })
  e.retryAfter = NaN // a value that slipped past parsing still backs off
  const waits = []
  let n = 0
  const r = retrying(async () => { if (!n++) throw e; return 'ok' }, { wait: async (s) => { waits.push(s) } })
  assert.equal(await r(['api']), 'ok')
  assert.deepEqual(waits, [2])
})
