// Shared by tests/land-scripts-sh.test.mjs and tests/land-scripts-ps1.test.mjs: the tests of
// plugins/dev-tools/skills/land/scripts/{land-many,resync-after-squash}.{sh,ps1}. land-many runs against a
// scripted `gh` on PATH; resync-after-squash against a temp repo with a bare origin. The .sh runs on
// macOS/Linux, the .ps1 on Windows (CI's windows-scripts job), like the scripts themselves.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = fileURLToPath(new URL('../plugins/dev-tools/skills/land/scripts/', import.meta.url))
export const win = process.platform === 'win32'
export const CONCURRENCY = 4

// The shim. SHIM_SCENARIO is { required: [ruleset names], classic: [protection names], prs: { <n>: [step...] },
// noAutoMerge?, expected?: { <n>: count } }; each GraphQL query for a PR takes its next step (the last one repeats).
// A step is 'error' or { state, merge, base, queue, queued, checks: {name: bucket}, runs: {workflow: suite status} };
// every head also carries a queued app suite with no workflow run, which never blocks. noAutoMerge refuses
// `gh pr merge --auto`; expected refuses that PR's first <count> enqueues and merges with gh's
// `Required status check ... is expected`. A step with `queued: 'after-enqueue'` reports true once that PR was
// enqueued. Calls go to <scenario>.log.
const shim = `
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const file = process.env.SHIM_SCENARIO
const sc = JSON.parse(readFileSync(file, 'utf8'))
const argv = process.argv.slice(2)
const log = (l) => appendFileSync(file + '.log', l + '\\n')
const field = (k) => { for (let i = 0; i < argv.length - 1; i++) if ((argv[i] === '-f' || argv[i] === '-F') && argv[i + 1].startsWith(k + '=')) return argv[i + 1].slice(k.length + 1) }
const jq = argv.indexOf('--jq')
// refuse(n): true (after logging it) while that PR still has \`is expected\` refusals left in the scenario.
const refuse = (n) => {
  const f = file + '.refused-' + n
  const done = existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0
  if (done >= (sc.expected?.[n] ?? 0)) return false
  writeFileSync(f, String(done + 1))
  log('refused ' + n)
  process.stderr.write('GraphQL: Required status check "check" is expected. (mergePullRequest)\\n')
  return true
}
const out = (data) => {
  let text = typeof data === 'string' ? data : JSON.stringify(data)
  if (jq >= 0) text = spawnSync('jq', ['-r', argv[jq + 1]], { input: text, encoding: 'utf8' }).stdout.replace(/\\n$/, '')
  if (text) process.stdout.write(text + '\\n')
  process.exit(0)
}
if (argv[0] === 'repo' && argv[1] === 'view') out({ nameWithOwner: 'acme/app', defaultBranchRef: { name: 'main' } })
if (argv[0] === 'pr' && argv[1] === 'merge') {
  if (sc.noAutoMerge && argv.includes('--auto')) { process.stderr.write('GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)\\n'); process.exit(1) }
  if (refuse(argv[2])) process.exit(1)
  log('merge ' + argv.slice(2).join(' ')); process.exit(0)
}
if (argv[0] === 'api' && argv[1] === 'repos/acme/app/branches/main') out({ name: 'main', protection: { required_status_checks: { contexts: sc.classic ?? [] } } })
if (argv[0] === 'api' && argv[1].startsWith('repos/acme/app/rules/branches/')) {
  log('rules ' + argv[1].split('/').pop())
  out([{ type: 'deletion' }, { type: 'required_status_checks', parameters: { required_status_checks: sc.required.map((context) => ({ context, integration_id: 1 })) } }])
}
if (argv[0] === 'api' && argv[1] === 'graphql') {
  const q = field('query')
  if (q.startsWith('mutation')) {
    const n = field('id').replace('PR_', '')
    if (refuse(n)) process.exit(1)
    log('enqueue ' + n + ' ' + field('head'))
    appendFileSync(file + '.enq-' + n, 'x')
    out({ data: { enqueuePullRequest: { mergeQueueEntry: { position: 1 } } } })
  }
  const n = field('n')
  const counter = file + '.n-' + n
  const i = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  writeFileSync(counter, String(i + 1))
  const steps = sc.prs[n]
  const s = steps[Math.min(i, steps.length - 1)]
  log('poll ' + n)
  if (s === 'error') { process.stderr.write('HTTP 502: bad gateway\\n'); process.exit(1) }
  const queued = s.queued === 'after-enqueue' ? existsSync(file + '.enq-' + n) : !!s.queued
  const nodes = Object.entries(s.checks ?? {}).map(([name, b]) => b === 'status-fail'
    ? { __typename: 'StatusContext', context: name, state: 'FAILURE', targetUrl: 'https://ci.example/' + name }
    : { __typename: 'CheckRun', name, status: b === 'pending' ? 'IN_PROGRESS' : 'COMPLETED', conclusion: b === 'pending' ? null : b === 'pass' ? 'SUCCESS' : 'FAILURE', detailsUrl: 'https://ci.example/' + name })
  const suites = [{ status: 'QUEUED', workflowRun: null }, ...Object.entries(s.runs ?? {}).map(([name, status]) => ({ status, workflowRun: { workflow: { name } } }))]
  out({ data: { repository: { pullRequest: { id: 'PR_' + n, state: s.state ?? 'OPEN', mergeStateStatus: s.merge ?? 'BLOCKED', headRefOid: 'head' + n, baseRefName: s.base ?? 'main',
    isInMergeQueue: queued, isMergeQueueEnabled: s.queue ?? true, mergeCommit: s.state === 'MERGED' ? { oid: 'sha' + n } : null,
    commits: { nodes: [{ commit: { checkSuites: { nodes: suites } } }] }, statusCheckRollup: { contexts: { nodes } } } } } })
}
process.stderr.write('shim: unexpected ' + argv.join(' ') + '\\n')
process.exit(64)
`
const bin = mkdtempSync(join(tmpdir(), 'land-many-bin-'))
writeFileSync(join(bin, 'shim.mjs'), shim)
writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexec node "$(dirname "$0")/shim.mjs" "$@"\n')
chmodSync(join(bin, 'gh'), 0o755)
writeFileSync(join(bin, 'gh.cmd'), '@node "%~dp0shim.mjs" %*\r\n')

const runner = (kind, script, args) => (kind === 'sh' ? ['bash', [join(scripts, `${script}.sh`), ...args]] : ['pwsh', ['-NoProfile', '-File', join(scripts, `${script}.ps1`), ...args]])
function exec(exe, argv, opts) {
  return new Promise((resolve) => {
    const child = spawn(exe, argv, { ...opts, timeout: 30000 })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => resolve({ code: null, out: stdout, err: stderr + e.message }))
    child.on('close', (code) => resolve({ code, out: stdout.replace(/\r\n/g, '\n'), err: stderr }))
  })
}

async function landMany(kind, scenario, args) {
  const dir = mkdtempSync(join(tmpdir(), 'land-many-'))
  const file = join(dir, 'scenario.json')
  writeFileSync(file, JSON.stringify({ required: ['check'], ...scenario }))
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, SHIM_SCENARIO: file, LAND_MANY_INTERVAL: '', LAND_MANY_TIMEOUT: '', LAND_MANY_REQUEUES: '' }
  const [exe, argv] = runner(kind, 'land-many', args ?? ['--interval', '1', '--timeout', '20', ...Object.keys(scenario.prs ?? { 1: 0 })])
  const r = await exec(exe, argv, { env })
  const log = existsSync(file + '.log') ? readFileSync(file + '.log', 'utf8').trim().split('\n') : []
  return { ...r, log }
}

const pending = { checks: { check: 'pending' } }
const green = { checks: { check: 'pass' } }
const queued = { ...green, queued: 'after-enqueue' }
const merged = { state: 'MERGED', merge: 'UNKNOWN' }

export function landManyTests(kind) {
  test(`${kind} land-many: ready PRs are all enqueued in the same poll, then each merges`, async () => {
    const r = await landMany(kind, { prs: { 11: [pending, queued, queued, merged], 12: [pending, queued, merged] } })
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^PR 12: MERGED sha12\nPR 11: MERGED sha11\n$/)
    const enq = r.log.filter((l) => l.startsWith('enqueue'))
    assert.deepEqual(enq, ['enqueue 11 head11', 'enqueue 12 head12'])
    assert.ok(r.log.indexOf('enqueue 12 head12') < r.log.lastIndexOf('poll 11'), 'the second PR waited for the first')
  })

  test(`${kind} land-many: a DIRTY PR is reported at once while the others go on`, async () => {
    const r = await landMany(kind, { prs: { 11: [{ merge: 'DIRTY' }], 12: [pending, pending, queued, merged] } })
    assert.equal(r.code, 1, r.err)
    assert.match(r.out, /^PR 11: DIRTY\nPR 12: MERGED sha12\n$/)
  })

  test(`${kind} land-many: any failed check on the head ends the PR with its name and link, required or not`, async () => {
    const r = await landMany(kind, { prs: { 11: [{ checks: { check: 'pass', lint: 'fail' } }], 12: [{ checks: { check: 'status-fail' } }] } })
    assert.equal(r.code, 1, r.err)
    assert.match(r.out, /PR 11: FAILED check lint https:\/\/ci\.example\/lint\n/)
    assert.match(r.out, /PR 12: FAILED check check https:\/\/ci\.example\/check\n/)
    assert.ok(!r.log.some((l) => l.startsWith('enqueue')))
  })

  test(`${kind} land-many: the required names come from rulesets and classic protection, and a missing one is pending`, async () => {
    const r = await landMany(kind, { required: ['build'], classic: ['ci'], prs: { 11: [
      { checks: { check: 'pending' } }, { checks: { check: 'pending', build: 'pass' } },
      { checks: { check: 'pending', build: 'pass', ci: 'pass' }, queued: 'after-enqueue' }, merged] } })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.log.filter((l) => l.startsWith('rules')), ['rules main'])
    assert.deepEqual(r.log.filter((l) => l.startsWith('poll') || l.startsWith('enqueue')).slice(0, 4), ['poll 11', 'poll 11', 'poll 11', 'enqueue 11 head11'])
  })

  test(`${kind} land-many: a PR that falls out of the queue is enqueued again, up to the limit`, async () => {
    const back = await landMany(kind, { prs: { 11: [green, { ...green, queued: true }, green, { ...green, queued: true }, merged] } })
    assert.equal(back.code, 0, back.err)
    assert.equal(back.log.filter((l) => l.startsWith('enqueue')).length, 2)
    const stuck = await landMany(kind, { prs: { 11: [green] } })
    assert.equal(stuck.code, 1, stuck.err)
    assert.match(stuck.out, /PR 11: FAILED left the merge queue 3 times/)
  })

  test(`${kind} land-many: with a queue BEHIND does not matter; without one it arms auto-merge on the head once, and BEHIND ends the PR`, async () => {
    const q = await landMany(kind, { prs: { 11: [{ ...queued, merge: 'BEHIND' }, merged] } })
    assert.equal(q.code, 0, q.err)
    assert.deepEqual(q.log.filter((l) => l.startsWith('enqueue')), ['enqueue 11 head11'])
    const r = await landMany(kind, { prs: { 11: [{ ...green, queue: false }, { ...green, queue: false }, merged], 12: [{ ...green, queue: false, merge: 'BEHIND' }] } })
    assert.equal(r.code, 1, r.err)
    assert.deepEqual(r.log.filter((l) => l.startsWith('merge')), ['merge 11 --auto --squash --match-head-commit head11'])
    assert.match(r.out, /PR 12: BEHIND\n/)
    assert.match(r.out, /PR 11: MERGED sha11\n/)
  })

  test(`${kind} land-many: where auto-merge is not allowed it merges directly once every check passed`, async () => {
    const r = await landMany(kind, { noAutoMerge: true, prs: { 11: [{ checks: { check: 'pass', e2e: 'pending' }, queue: false }, { checks: { check: 'pass', e2e: 'pass' }, queue: false }, merged] } })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.log.filter((l) => l.startsWith('merge')), ['merge 11 --squash --match-head-commit head11'])
  })

  test(`${kind} land-many: a workflow run still running on the head holds the enqueue, even with the required checks green`, async () => {
    const r = await landMany(kind, { prs: { 11: [{ ...green, runs: { e2e: 'IN_PROGRESS', ci: 'COMPLETED' } }, { ...green, runs: { deploy: 'WAITING' } }, queued, merged] } })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.log.filter((l) => l.startsWith('poll') || l.startsWith('enqueue')).slice(0, 4), ['poll 11', 'poll 11', 'poll 11', 'enqueue 11 head11'])
  })

  test(`${kind} land-many: without a queue it never arms or merges while a run is in progress, and TIMEOUT names the run`, async () => {
    const r = await landMany(kind, { prs: { 11: [{ ...green, queue: false, runs: { e2e: 'IN_PROGRESS', ci: 'COMPLETED' } }], 12: [{ ...green, queue: false, runs: { e2e: 'QUEUED' } }] } },
      ['--interval', '1', '--timeout', '2', '11', '12'])
    assert.equal(r.code, 1, r.err)
    assert.match(r.out, /PR 11: TIMEOUT after 2s, OPEN BLOCKED, running: e2e\n/)
    assert.match(r.out, /PR 12: TIMEOUT after 2s, OPEN BLOCKED, running: e2e\n/)
    assert.ok(!r.log.some((l) => l.startsWith('merge')))
  })

  test(`${kind} land-many: gh's "required check is expected" refusal waits like a pending check, and TIMEOUT names it`, async () => {
    const q = await landMany(kind, { expected: { 11: 3 }, prs: { 11: [queued, queued, queued, queued, queued, merged] } })
    assert.equal(q.code, 0, q.err + q.out)
    assert.equal(q.log.filter((l) => l.startsWith('refused')).length, 3)
    assert.deepEqual(q.log.filter((l) => l.startsWith('enqueue')), ['enqueue 11 head11'])
    const r = await landMany(kind, { expected: { 11: 99 }, prs: { 11: [{ ...green, queue: false }] } }, ['--interval', '1', '--timeout', '3', '11'])
    assert.equal(r.code, 1, r.err)
    assert.match(r.out, /^PR 11: TIMEOUT after 3s, OPEN BLOCKED, waiting: GraphQL: Required status check "check" is expected\. \(mergePullRequest\)\n$/)
    assert.ok(!r.log.some((l) => l.startsWith('merge')))
  })

  test(`${kind} land-many: a PR based on another branch is STACKED, never merged into it`, async () => {
    const r = await landMany(kind, { prs: { 11: [{ ...green, base: 'feat/schema', queue: false }] } })
    assert.equal(r.code, 1, r.err)
    assert.match(r.out, /^PR 11: STACKED on feat\/schema: land it with gh stack merge/)
    assert.ok(!r.log.some((l) => l.startsWith('merge') || l.startsWith('enqueue')))
  })

  test(`${kind} land-many: gh failing 3 polls in a row is an ERROR`, async () => {
    const r = await landMany(kind, { prs: { 12: ['error'] } })
    assert.equal(r.code, 1, r.err)
    assert.match(r.out, /^PR 12: ERROR HTTP 502: bad gateway\n$/)
  })

  test(`${kind} land-many: the timeout ends every open PR with its last state`, async () => {
    const r = await landMany(kind, { prs: { 11: [pending] } }, ['--interval', '1', '--timeout', '1', '11'])
    assert.equal(r.code, 1, r.err)
    assert.match(r.out, /^PR 11: TIMEOUT after 1s, OPEN BLOCKED, pending: check\n$/)
  })

  test(`${kind} land-many: bad arguments exit 2`, async () => {
    for (const args of [[], ['--interval'], ['--timeout', '0', '1'], ['abc'], ['1', '-x'], ['012']]) {
      assert.equal((await landMany(kind, {}, args)).code, 2, JSON.stringify(args))
    }
  })
}

// A repo with a bare origin: main gets the integration branch squash-merged (and one more commit), and
// `feature` was cut from the integration branch's last commit and moved on.
function repo(onFeature) {
  const dir = mkdtempSync(join(tmpdir(), 'resync-'))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: win ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
  const work = join(dir, 'work')
  const git = (...a) => execFileSync('git', a, { cwd: work, env, encoding: 'utf8' }).trim()
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')], { env })
  execFileSync('git', ['clone', '-q', join(dir, 'origin.git'), work], { env, stdio: 'ignore' })
  const put = (f, text, msg) => { writeFileSync(join(work, f), text); git('add', f); git('commit', '-q', '-m', msg) }
  git('checkout', '-q', '-b', 'main')
  put('a.txt', 'a0\n', 'base')
  git('push', '-q', '-u', 'origin', 'main')
  git('checkout', '-q', '-b', 'integration')
  put('a.txt', 'a1\n', 'i1')
  put('b.txt', 'b1\n', 'i2')
  const last = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-b', 'feature')
  put('c.txt', 'c1\n', 'f1')
  git('checkout', '-q', 'main')
  git('merge', '-q', '--squash', 'integration')
  git('commit', '-q', '-m', 'squash integration')
  put('d.txt', 'd1\n', 'main moves on')
  git('push', '-q', 'origin', 'main')
  git('remote', 'set-head', 'origin', 'main')
  git('checkout', '-q', 'feature')
  onFeature?.({ put, git, work })
  return { work, env, git, last }
}

export function resyncTests(kind) {
  const resync = (r, args) => { const [exe, argv] = runner(kind, 'resync-after-squash', args); return exec(exe, argv, { cwd: r.work, env: r.env }) }

  test(`${kind} resync-after-squash: merges only the base's changes and proves it`, async () => {
    const r = repo()
    const res = await resync(r, [r.last])
    assert.equal(res.code, 0, res.err + res.out)
    assert.match(res.out, /proven/)
    assert.match(res.out, /files changed by the merge.*\n {2}d\.txt\nfiles the base changed/)
    assert.equal(r.git('rev-parse', 'HEAD^2'), r.git('rev-parse', 'origin/main'))
    assert.equal(r.git('show', 'HEAD:c.txt'), 'c1')
    assert.equal(r.git('show', 'HEAD:d.txt'), 'd1')
    assert.equal(r.git('status', '--porcelain'), '')
    const again = await resync(r, [r.last, 'main'])
    assert.equal(again.code, 0, again.err)
    assert.match(again.out, /already up to date/)
  })

  test(`${kind} resync-after-squash: refuses a sha the branch lacks, a dirty tree and bad arguments`, async () => {
    const r = repo()
    const other = r.git('rev-parse', 'origin/main')
    const lacks = await resync(r, [other])
    assert.equal(lacks.code, 1)
    assert.match(lacks.err, /does not contain/)
    assert.equal((await resync(r, [])).code, 2)
    assert.equal((await resync(r, ['-h'])).code, 2)
    const inject = await resync(r, [r.last, '--upload-pack=touch X;false'])
    assert.equal(inject.code, 2)
    assert.equal(existsSync(join(r.work, 'X')), false)
    writeFileSync(join(r.work, 'c.txt'), 'dirty\n')
    const dirty = await resync(r, [r.last])
    assert.equal(dirty.code, 1)
    assert.match(dirty.err, /uncommitted changes/)
  })

  test(`${kind} resync-after-squash: a patch that does not apply aborts the merge`, async () => {
    const r = repo(({ put }) => put('d.txt', 'mine\n', 'branch adds d too'))
    const head = r.git('rev-parse', 'HEAD')
    const res = await resync(r, [r.last])
    assert.equal(res.code, 1, res.out)
    assert.match(res.err, /do not apply/)
    assert.equal(r.git('rev-parse', 'HEAD'), head)
    assert.equal(r.git('status', '--porcelain'), '')
    assert.equal(existsSync(join(r.work, '.git', 'MERGE_HEAD')), false)
  })

  test(`${kind} resync-after-squash: a failed file-list proof resets the merge commit away`, async () => {
    // A pre-commit hook slips another file into the merge commit, so the lists differ.
    const r = repo(({ work }) => {
      writeFileSync(join(work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho extra > e.txt && git add e.txt\n')
      chmodSync(join(work, '.git', 'hooks', 'pre-commit'), 0o755)
    })
    const head = r.git('rev-parse', 'HEAD')
    const res = await resync(r, [r.last])
    assert.equal(res.code, 1, res.out)
    assert.match(res.err, /the lists differ/)
    assert.equal(r.git('rev-parse', 'HEAD'), head)
  })
}
