// Shared by tests/land-scripts-sh.test.mjs and tests/land-scripts-ps1.test.mjs: the tests of
// plugins/dev-tools/skills/land/scripts/{land-many,resync-after-squash,verify-merge-only}.{sh,ps1}. land-many runs
// against a scripted `gh` on PATH; resync-after-squash and verify-merge-only against a temp repo with a bare origin. The .sh runs on
// macOS/Linux, the .ps1 on Windows (CI's windows-scripts job), like the scripts themselves.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
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
// enqueued. stacked: [n...] refuses those PRs' enqueues and merges as part of a stack; async: { <n>: [reply...] }
// answers that PR's merge-async request and then each poll of it (the last one repeats), a reply being 'pending',
// 'enqueued' (which counts as an enqueue), 'merged' or 'failed'. Calls go to <scenario>.log.
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
// stack(n): true (after logging it) when that PR is in a stack, which gh refuses to merge or enqueue.
const stack = (n) => {
  if (!(sc.stacked ?? []).includes(Number(n))) return false
  log('stack-refused ' + n)
  process.stderr.write('GraphQL: This pull request is part of a stack and must be enqueued using the asynchronous merge REST API (mergePullRequest)\\n')
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
  if (stack(argv[2])) process.exit(1)
  if (sc.noAutoMerge && argv.includes('--auto')) { process.stderr.write('GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)\\n'); process.exit(1) }
  if (refuse(argv[2])) process.exit(1)
  log('merge ' + argv.slice(2).join(' ')); process.exit(0)
}
if (argv[0] === 'api' && argv[1] === 'repos/acme/app/branches/main') out({ name: 'main', protection: { required_status_checks: { contexts: sc.classic ?? [] } } })
if (argv[0] === 'api' && argv[1].startsWith('repos/acme/app/rules/branches/')) {
  log('rules ' + argv[1].split('/').pop())
  out([{ type: 'deletion' }, { type: 'required_status_checks', parameters: { required_status_checks: sc.required.map((context) => ({ context, integration_id: 1 })) } }])
}
const asyncPath = argv[0] === 'api' && argv.map((a) => a.split('/')).find((p) => p.slice(0, 4).join('/') === 'repos/acme/app/pulls' && p[5] === 'merge-async')
if (asyncPath) {
  const [, , , , n, , id] = asyncPath
  const h = argv.indexOf('-H')
  const version = h >= 0 ? argv[h + 1] : 'no version'
  if (id) log('merge-async-poll ' + n + ' ' + id + ' ' + version)
  else log('merge-async ' + n + ' ' + argv.filter((a, i) => argv[i - 1] === '-f').join(' ') + ' ' + version)
  const counter = file + '.async-' + n
  const i = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  writeFileSync(counter, String(i + 1))
  const replies = sc.async[n]
  const r = replies[Math.min(i, replies.length - 1)]
  if (r === 'enqueued') appendFileSync(file + '.enq-' + n, 'x')
  out(r === 'pending' ? { status: 'pending', details: { message: 'Merge requested', uuid: 'u' + n, merge_method: 'squash', merge_action: 'default', expected_head_sha: 'head' + n } }
    : r === 'enqueued' ? { status: 'enqueued', details: { message: 'Added to the merge queue' } }
    : r === 'merged' ? { status: 'merged', details: { message: 'Merged', sha: 'sha' + n } }
    : { status: 'failed', details: { message: 'Required status check "check" is failing' } })
}
if (argv[0] === 'api' && argv[1] === 'graphql') {
  const q = field('query')
  if (q.startsWith('mutation')) {
    const n = field('id').replace('PR_', '')
    if (stack(n) || refuse(n)) process.exit(1)
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

  const v = 'X-GitHub-Api-Version: 2026-03-10'
  test(`${kind} land-many: a PR gh refuses as part of a stack goes through merge-async, enqueued with a queue, merged without one`, async () => {
    const r = await landMany(kind, { stacked: [11, 12], async: { 11: ['pending', 'enqueued'], 12: ['pending', 'pending', 'merged'] }, prs: {
      11: [queued, queued, queued, merged], 12: [{ ...green, queue: false }] } })
    assert.equal(r.code, 0, r.err + r.out)
    assert.match(r.out, /^PR 12: MERGED sha12\nPR 11: MERGED sha11\n$/)
    assert.deepEqual(r.log.filter((l) => /^(stack-refused|merge-async|enqueue|merge )/.test(l)), [
      'stack-refused 11', `merge-async 11 merge_action=merge_queue sha=head11 ${v}`,
      'stack-refused 12', `merge-async 12 merge_action=default merge_method=squash sha=head12 ${v}`,
      `merge-async-poll 11 u11 ${v}`, `merge-async-poll 12 u12 ${v}`, `merge-async-poll 12 u12 ${v}`])
  })

  test(`${kind} land-many: a failed merge-async request ends the PR with its message`, async () => {
    const r = await landMany(kind, { stacked: [11], async: { 11: ['pending', 'failed'] }, prs: { 11: [green] } })
    assert.equal(r.code, 1, r.err)
    assert.match(r.out, /^PR 11: FAILED merge-async: Required status check "check" is failing\n$/)
  })

  test(`${kind} land-many: a merge-async request still pending at the deadline is a TIMEOUT naming it, never an ERROR`, async () => {
    const r = await landMany(kind, { stacked: [11], async: { 11: ['pending'] }, prs: { 11: [green] } }, ['--interval', '1', '--timeout', '4', '11'])
    assert.equal(r.code, 1, r.err)
    assert.match(r.out, /^PR 11: TIMEOUT after 4s, OPEN BLOCKED, merge-async pending u11\n$/)
    assert.equal(r.log.filter((l) => l.startsWith('merge-async ')).length, 1)
  })

  test(`${kind} land-many: a PR outside a stack never calls merge-async`, async () => {
    const r = await landMany(kind, { stacked: [], async: {}, prs: { 11: [queued, merged], 12: [{ ...green, queue: false }, merged] } })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.log.filter((l) => /^(stack-refused|merge-async|enqueue|merge )/.test(l)), ['enqueue 11 head11', 'merge 12 --auto --squash --match-head-commit head12'])
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
  put('m.txt', 'm1\nm2\nm3\nm4\nm5\n', 'i3')
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
  const resync = (r, args, cwd = r.work) => { const [exe, argv] = runner(kind, 'resync-after-squash', args); return exec(exe, argv, { cwd, env: r.env }) }

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

  test(`${kind} resync-after-squash: diff.relative and a subdirectory do not drop the base's changes`, async () => {
    // From sub/ with diff.relative set, a diff run there would carry none of d.txt.
    const r = repo(({ git, work }) => {
      mkdirSync(join(work, 'sub'))
      writeFileSync(join(work, 'sub', 'x.txt'), 'x\n')
      git('add', 'sub/x.txt')
      git('commit', '-q', '-m', 'sub')
      git('config', 'diff.relative', 'true')
    })
    const res = await resync(r, [r.last], join(r.work, 'sub'))
    assert.equal(res.code, 0, res.err + res.out)
    assert.equal(r.git('show', 'HEAD:d.txt'), 'd1')
    assert.match(res.out, /files changed by the merge.*\n {2}d\.txt\nfiles the base changed/)
  })

  // onMain(git, put) adds one more commit to origin/main after the squash, from the feature branch's checkout.
  const baseMoves = (onMain, config) => ({ git, put }) => {
    git('checkout', '-q', 'main')
    onMain(git, put)
    git('push', '-q', 'origin', 'main')
    git('checkout', '-q', 'feature')
    for (const [k, v] of Object.entries(config)) git('config', k, v)
  }

  test(`${kind} resync-after-squash: diff.context=0 does not break the patch`, async () => {
    // m.txt is in the integration sha already, so the patch edits it mid-file: with no context git apply refuses it.
    const r = repo(baseMoves((git, put) => put('m.txt', 'm1\nm2\nM3\nm4\nm5\n', 'edit m'), { 'diff.context': '0' }))
    const res = await resync(r, [r.last])
    assert.equal(res.code, 0, res.err + res.out)
    assert.equal(r.git('show', 'HEAD:m.txt'), 'm1\nm2\nM3\nm4\nm5')
  })

  for (const [name, config] of [['diff.ignoreSubmodules=all', { 'diff.ignoreSubmodules': 'all' }], ['diff.submodule=log', { 'diff.submodule': 'log' }]]) {
    test(`${kind} resync-after-squash: ${name} does not drop a submodule pointer the base added`, async () => {
      const r = repo(baseMoves((git) => {
        git('update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},mod`)
        git('commit', '-q', '-m', 'add mod')
      }, config))
      const res = await resync(r, [r.last])
      assert.equal(res.code, 0, res.err + res.out)
      assert.equal(r.git('rev-parse', 'HEAD:mod'), 'a'.repeat(40))
    })
  }

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


// A repo with a bare origin. main commits `base` (plus a gitlink `mod` at `gitlink` when given) and is pushed with
// origin/HEAD set; `feature` then commits `pr` and is the approved head; main then commits `main` and is pushed.
// onFeature runs on feature after that, with origin/main fetched. Values are strings or Buffers; `pr` may instead be a
// function that makes the PR commit itself.
const gitmodules = (extra = '') => `[submodule "mod"]\n\tpath = mod\n\turl = ./mod\n${extra}`
const LINK_A = 'a'.repeat(40)
const LINK_B = 'b'.repeat(40)
function mergeRepo(onFeature, { base = {}, gitlink, pr = { 'pr.txt': 'one\ntwo\n' }, main = { 'd.txt': 'd1\n' } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-merge-'))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: win ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
  const work = join(dir, 'work')
  const git = (...a) => execFileSync('git', a, { cwd: work, env, encoding: 'utf8' }).trim()
  const write = (files) => {
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, f)), { recursive: true })
      writeFileSync(join(work, f), text)
      git('add', f)
    }
  }
  const put = (files, msg) => { write(files); git('commit', '-q', '-m', msg) }
  const link = (sha) => git('update-index', '--add', '--cacheinfo', `160000,${sha},mod`)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')], { env })
  execFileSync('git', ['clone', '-q', join(dir, 'origin.git'), work], { env, stdio: 'ignore' })
  git('checkout', '-q', '-b', 'main')
  write({ 'a.txt': 'a0\n', 'sub/s.txt': 's0\n', ...base })
  if (gitlink) link(gitlink)
  git('commit', '-q', '-m', 'base')
  git('push', '-q', '-u', 'origin', 'main')
  git('remote', 'set-head', 'origin', 'main')
  git('checkout', '-q', '-b', 'feature')
  if (typeof pr === 'function') pr({ git, put, work })
  else put(pr, 'the PR')
  const approved = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  put(main, 'main moves on')
  git('push', '-q', 'origin', 'main')
  git('checkout', '-q', 'feature')
  git('fetch', '-q', 'origin')
  // evil(files): a merge of origin/main that also writes these files (or swaps the gitlink when files is a sha).
  const evil = (files) => {
    git('merge', '-q', '--no-commit', 'origin/main')
    if (typeof files === 'string') link(files)
    else write(files)
    git('commit', '-q', '-m', 'Merge origin/main')
  }
  onFeature?.({ put, git, work, evil })
  return { work, env, git, approved, head: git('rev-parse', 'HEAD') }
}

// Two blocks with the same body: the PR adds `  allow` to the deploy block.
const ci = (build, deploy) => `job: build\n${build}\njob: deploy\n${deploy}\n`
const block = 'a\nb\nc\nd\ne\nf'
const allowed = 'a\nb\nc\n  allow\nd\ne\nf'

export function verifyMergeTests(kind) {
  const verify = (r, args, cwd = r.work, env = r.env) => { const [exe, argv] = runner(kind, 'verify-merge-only', args); return exec(exe, argv, { cwd, env }) }
  const refused = async (r, pattern, cwd, env) => {
    const res = await verify(r, [r.approved, r.head], cwd, env)
    assert.equal(res.code, 1, res.out + res.err)
    assert.match(res.err, pattern)
    assert.doesNotMatch(res.out, /Landing note/)
  }
  const differs = /differs from the merge git makes/

  test(`${kind} verify-merge-only: proves a pure base merge and prints the landing note`, async () => {
    const r = mergeRepo(({ git }) => git('merge', '-q', '--no-edit', 'origin/main'))
    const res = await verify(r, [r.approved, r.head])
    assert.equal(res.code, 0, res.err + res.out)
    assert.match(res.out, new RegExp(`Landing note: approved head ${r.approved}; merging head ${r.head}`))
    assert.match(res.out, /is a pure merge of origin\/main at [0-9a-f]{40}: .*git merge-tree --write-tree/)
  })

  test(`${kind} verify-merge-only: proves a pure merge run from a subdirectory, the base named`, async () => {
    const r = mergeRepo(({ git }) => git('merge', '-q', '--no-edit', 'origin/main'))
    const res = await verify(r, [r.approved, r.head, 'main'], join(r.work, 'sub'))
    assert.equal(res.code, 0, res.err + res.out)
  })

  test(`${kind} verify-merge-only: no commits since the approval`, async () => {
    const r = mergeRepo()
    const res = await verify(r, [r.approved, r.approved])
    assert.equal(res.code, 0, res.err + res.out)
    assert.match(res.out, /no commits since approval/)
    assert.match(res.out, /Landing note: approved head/)
  })

  test(`${kind} verify-merge-only: refuses a plain commit after the approval`, async () => {
    await refused(mergeRepo(({ put }) => put({ 'e.txt': 'e1\n' }, 'one more')), /not a two-parent merge whose first parent is the approved head/)
  })

  test(`${kind} verify-merge-only: refuses a merge whose first parent is another commit with the approved tree`, async () => {
    await refused(mergeRepo(({ git }) => {
      git('commit', '-q', '--allow-empty', '-m', 'unreviewed')
      git('merge', '-q', '--no-edit', 'origin/main')
    }), /first parent is the approved head/)
  })

  test(`${kind} verify-merge-only: refuses a merge that also edits a PR file`, async () => {
    await refused(mergeRepo(({ evil }) => evil({ 'pr.txt': 'one\nTWO\n' })), differs)
  })

  test(`${kind} verify-merge-only: refuses a whitespace-only edit slipped into the merge`, async () => {
    await refused(mergeRepo(({ evil }) => evil({ 'pr.txt': 'one  \ntwo\n' })), differs)
  })

  test(`${kind} verify-merge-only: refuses a merge that moves the PR's hunk to an identical block`, async () => {
    const opts = { base: { 'ci.txt': ci(block, block) }, pr: { 'ci.txt': ci(block, allowed) } }
    await refused(mergeRepo(({ evil }) => evil({ 'ci.txt': ci(allowed, block) }), opts), differs)
  })

  test(`${kind} verify-merge-only: refuses a binary edit and a rename slipped into the merge`, async () => {
    const opts = { pr: { 'pr.txt': 'one\ntwo\n', 'bin.dat': Buffer.from([0, 1, 2, 0, 255]) } }
    await refused(mergeRepo(({ evil }) => evil({ 'bin.dat': Buffer.from([0, 1, 3, 0, 255]) }), opts), differs)
    await refused(mergeRepo(({ git }) => {
      git('merge', '-q', '--no-commit', 'origin/main')
      git('mv', 'pr.txt', 'pr2.txt')
      git('commit', '-q', '-m', 'Merge origin/main')
    }), differs)
  })

  test(`${kind} verify-merge-only: refuses a merge that needed a conflict resolution`, async () => {
    const opts = { pr: { 'a.txt': 'pr\n' }, main: { 'a.txt': 'main\n' } }
    await refused(mergeRepo(({ git, work }) => {
      try { git('merge', '-q', '--no-edit', 'origin/main') } catch { /* the conflict is the point */ }
      writeFileSync(join(work, 'a.txt'), 'pr\n')
      git('add', 'a.txt')
      git('commit', '-q', '--no-edit')
    }, opts), /cannot redo the merge/)
  })

  test(`${kind} verify-merge-only: refuses a merge of a branch that is not on origin/main`, async () => {
    await refused(mergeRepo(({ git, put }) => {
      git('checkout', '-q', '-b', 'side', 'origin/main')
      put({ 'side.txt': 's1\n' }, 'unreviewed')
      git('checkout', '-q', 'feature')
      git('merge', '-q', '--no-edit', 'side')
    }), /not on origin\/main/)
  })

  // Repo config the script does not control must not hide a change: each case is an evil merge with that config set.
  test(`${kind} verify-merge-only: diff.context=0 does not hide a moved hunk`, async () => {
    const opts = { base: { 'ci.txt': ci(block, block) }, pr: { 'ci.txt': ci(block, allowed) } }
    await refused(mergeRepo(({ git, evil }) => { git('config', 'diff.context', '0'); evil({ 'ci.txt': ci(allowed, block) }) }, opts), differs)
  })

  test(`${kind} verify-merge-only: diff.relative from a subdirectory does not hide a change outside it`, async () => {
    const r = mergeRepo(({ git, evil }) => { git('config', 'diff.relative', 'true'); evil({ 'a.txt': 'evil\n' }) })
    await refused(r, differs, join(r.work, 'sub'))
  })

  for (const [name, setup] of [
    ['diff.submodule=log', (git) => git('config', 'diff.submodule', 'log')],
    ['diff.ignoreSubmodules=all', (git) => git('config', 'diff.ignoreSubmodules', 'all')],
    ['submodule.mod.ignore=all', (git) => git('config', 'submodule.mod.ignore', 'all')],
  ]) {
    test(`${kind} verify-merge-only: ${name} does not hide a submodule pointer swap`, async () => {
      const opts = { base: { '.gitmodules': gitmodules() }, gitlink: LINK_A }
      await refused(mergeRepo(({ git, evil }) => { setup(git); evil(LINK_B) }, opts), differs)
    })
  }

  test(`${kind} verify-merge-only: ignore = all in .gitmodules does not hide a submodule pointer swap`, async () => {
    const opts = { base: { '.gitmodules': gitmodules('\tignore = all\n') }, gitlink: LINK_A }
    await refused(mergeRepo(({ evil }) => evil(LINK_B), opts), differs)
  })

  test(`${kind} verify-merge-only: takes only full SHAs and the default branch`, async () => {
    const r = mergeRepo(({ git }) => git('merge', '-q', '--no-edit', 'origin/main'))
    for (const args of [[], ['-h'], [r.approved], ['-x', r.head], [r.approved, '-x'], ['feature', 'feature'], ['HEAD', 'HEAD'],
      [r.approved.slice(0, 12), r.head], [r.approved.toUpperCase(), r.head], [r.approved, r.head, 'main', 'x']]) {
      assert.equal((await verify(r, args)).code, 2, args.join(' '))
    }
    const other = await verify(r, [r.approved, r.head, 'other'])
    assert.equal(other.code, 1)
    assert.match(other.err, /must be origin's default branch \(main\)/)
    const inject = await verify(r, [r.approved, r.head, '--upload-pack=touch X;false'])
    assert.equal(inject.code, 1)
    assert.equal(existsSync(join(r.work, 'X')), false)
    const missing = await verify(r, ['c'.repeat(40), r.head])
    assert.equal(missing.code, 1)
    assert.match(missing.err, /is not a commit here/)
  })

  test(`${kind} verify-merge-only: refuses without origin/HEAD`, async () => {
    const r = mergeRepo(({ git }) => { git('merge', '-q', '--no-edit', 'origin/main'); git('remote', 'set-head', 'origin', '-d') })
    await refused(r, /origin\/HEAD is not set/)
  })

  test(`${kind} verify-merge-only: refuses an origin/HEAD that names an invalid branch`, async () => {
    const r = mergeRepo(({ git }) => { git('merge', '-q', '--no-edit', 'origin/main'); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/-x') })
    await refused(r, /origin\/HEAD names an invalid branch/)
  })

  test(`${kind} verify-merge-only: refuses a new SHA that is not a commit`, async () => {
    const r = mergeRepo(({ git }) => git('merge', '-q', '--no-edit', 'origin/main'))
    const blob = r.git('rev-parse', 'HEAD:pr.txt')
    const res = await verify(r, [r.approved, blob])
    assert.equal(res.code, 1, res.out)
    assert.match(res.err, new RegExp(`${blob} is not a commit here`))
  })

  test(`${kind} verify-merge-only: fetches the base before checking the merged commit, with hooks off`, async () => {
    // origin/main moves on after the local fetch; the merge takes it, then the local origin/main is set back.
    const r = mergeRepo(({ git, put }) => {
      const before = git('rev-parse', 'origin/main')
      git('checkout', '-q', '-b', 'tmp', 'origin/main')
      put({ 'f.txt': 'f1\n' }, 'main moves again')
      git('push', '-q', 'origin', 'tmp:main')
      git('checkout', '-q', 'feature')
      git('merge', '-q', '--no-edit', 'tmp')
      git('update-ref', 'refs/remotes/origin/main', before)
    })
    const marker = join(r.work, 'hook-ran')
    writeFileSync(join(r.work, '.git', 'hooks', 'reference-transaction'), `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`)
    chmodSync(join(r.work, '.git', 'hooks', 'reference-transaction'), 0o755)
    const res = await verify(r, [r.approved, r.head])
    assert.equal(res.code, 0, res.err + res.out)
    assert.equal(existsSync(marker), false, 'a hook ran during the verify')
  })

  // Conflicting merge: the PR and main both change a.txt. Each case makes the merge resolve on the verifier's side.
  const conflict = { pr: { 'a.txt': 'pr\n' }, main: { 'a.txt': 'main\n' } }
  const mergeWith = (git, ...cfg) => git(...cfg, 'merge', '-q', '--no-edit', 'origin/main')

  test(`${kind} verify-merge-only: attributes from the checkout do not resolve a conflict`, async () => {
    await refused(mergeRepo(({ git, work }) => {
      writeFileSync(join(work, '.gitattributes'), 'a.txt merge=union\n')
      mergeWith(git)
    }, conflict), /cannot redo the merge/)
  })

  test(`${kind} verify-merge-only: refuses attributes in .git/info/attributes`, async () => {
    await refused(mergeRepo(({ git, work }) => {
      writeFileSync(join(work, '.git', 'info', 'attributes'), '# local\na.txt merge=union\n')
      mergeWith(git)
    }, conflict), /info\/attributes sets attributes the merge would use/)
  })

  test(`${kind} verify-merge-only: refuses a merge driver in the repo config, without running it`, async () => {
    const opts = { ...conflict, base: { '.gitattributes': 'a.txt merge=mine\n' } }
    let marker
    const r = mergeRepo(({ git, work }) => {
      marker = join(work, 'driver-ran').replace(/\\/g, '/')
      git('config', 'merge.mine.driver', 'true')
      mergeWith(git)
      git('config', 'merge.mine.driver', `echo ran > "${marker}"; true`)
    }, opts)
    await refused(r, /a merge driver is configured/)
    assert.equal(existsSync(marker), false, 'the driver ran during the verify')
  })

  test(`${kind} verify-merge-only: core.attributesFile in the repo config does not resolve a conflict`, async () => {
    await refused(mergeRepo(({ git, work }) => {
      const file = join(work, '..', 'attributes')
      writeFileSync(file, 'a.txt merge=union\n')
      git('config', 'core.attributesFile', file)
      mergeWith(git)
    }, conflict), /cannot redo the merge/)
  })

  test(`${kind} verify-merge-only: refuses a shallow clone`, async () => {
    const r = mergeRepo(({ git, work }) => {
      git('merge', '-q', '--no-edit', 'origin/main')
      writeFileSync(join(work, '.git', 'shallow'), git('rev-parse', 'HEAD~1') + '\n')
    })
    await refused(r, /shallow clone: deepen it/)
  })

  // A git on PATH that refuses --attr-source, or merge-tree, the way git before 2.40, or 2.38, does.
  const oldGit = (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'old-git-'))
    const real = join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), win ? 'git.exe' : 'git')
    writeFileSync(join(dir, 'shim.mjs'), `import { spawnSync } from 'node:child_process'
const argv = process.argv.slice(2)
if (${JSON.stringify(mode)} === 'attr' ? argv.some((a) => a.startsWith('--attr-source')) : argv.includes('merge-tree')) {
  process.stderr.write('unknown option\\n'); process.exit(129)
}
process.exit(spawnSync(${JSON.stringify(real)}, argv, { stdio: 'inherit' }).status ?? 1)
`)
    writeFileSync(join(dir, 'git'), '#!/bin/sh\nexec node "$(dirname "$0")/shim.mjs" "$@"\n')
    chmodSync(join(dir, 'git'), 0o755)
    // pwsh finds git.ps1 before the real git later on PATH; a .cmd shim would let cmd.exe eat the ^ in rev^{tree}.
    const refuse = mode === 'attr' ? "$args | Where-Object { $_ -like '--attr-source*' }" : "$args -contains 'merge-tree'"
    writeFileSync(join(dir, 'git.ps1'), `if (${refuse}) { [Console]::Error.WriteLine('unknown option'); exit 129 }\r\n& '${real}' @args\r\nexit $LASTEXITCODE\r\n`)
    return dir
  }
  for (const mode of ['attr', 'merge-tree']) {
    test(`${kind} verify-merge-only: an old git (${mode}) is named as the reason`, async () => {
      const r = mergeRepo(({ git }) => git('merge', '-q', '--no-edit', 'origin/main'))
      await refused(r, /needs git 2\.40 or newer/, r.work, { ...r.env, PATH: oldGit(mode) + delimiter + r.env.PATH })
    })
  }

  // A rename-heavy pure merge: the PR moves x.txt and y.txt with an edit each, main edits x.txt.
  const renames = {
    base: { 'x.txt': Array.from({ length: 20 }, (_, i) => `x ${i}`).join('\n') + '\n', 'y.txt': Array.from({ length: 20 }, (_, i) => `y ${i}`).join('\n') + '\n' },
    main: { 'x.txt': Array.from({ length: 20 }, (_, i) => (i === 10 ? 'x TEN' : `x ${i}`)).join('\n') + '\n' },
  }
  const renamed = ({ git, work }) => {
    for (const f of ['x', 'y']) {
      git('mv', `${f}.txt`, `${f}.moved`)
      writeFileSync(join(work, `${f}.moved`), 'top\n' + readFileSync(join(work, `${f}.moved`), 'utf8'))
      git('add', `${f}.moved`)
    }
    git('commit', '-q', '-m', 'move x and y')
  }
  const renameRepo = () => mergeRepo(({ git }) => mergeWith(git), { ...renames, pr: renamed })
  const limit = (dir) => { const f = join(dir, 'limit.gitconfig'); writeFileSync(f, '[merge]\n\trenameLimit = 1\n'); return f }

  test(`${kind} verify-merge-only: a global merge.renameLimit does not refuse a pure merge across renames`, async () => {
    const r = renameRepo()
    const res = await verify(r, [r.approved, r.head], r.work, { ...r.env, GIT_CONFIG_GLOBAL: limit(join(r.work, '..')) })
    assert.equal(res.code, 0, res.err + res.out)
  })

  test(`${kind} verify-merge-only: a system merge.renameLimit does not refuse a pure merge across renames`, async () => {
    const r = renameRepo()
    const env = { ...r.env, GIT_CONFIG_SYSTEM: limit(join(r.work, '..')) }
    delete env.GIT_CONFIG_NOSYSTEM
    const res = await verify(r, [r.approved, r.head], r.work, env)
    assert.equal(res.code, 0, res.err + res.out)
  })

  test(`${kind} verify-merge-only: merge.renames=false in the repo config does not refuse a pure merge across renames`, async () => {
    const r = renameRepo()
    r.git('config', 'merge.renames', 'false')
    const res = await verify(r, [r.approved, r.head])
    assert.equal(res.code, 0, res.err + res.out)
  })

  test(`${kind} verify-merge-only: merge.directoryRenames=true in the repo config does not move a base file unreviewed`, async () => {
    // The PR renames d/ to e/; main adds d/new.txt; a merge made with directory renames moves it to e/new.txt.
    const opts = { base: { 'd/x.txt': '1\n', 'd/y.txt': '2\n' }, main: { 'd/new.txt': '3\n' } }
    const pr = ({ git }) => { git('mv', 'd', 'e'); git('commit', '-q', '-m', 'move d') }
    await refused(mergeRepo(({ git }) => {
      git('config', 'merge.directoryRenames', 'true')
      mergeWith(git)
    }, { ...opts, pr }), /cannot redo the merge/)
  })

  test(`${kind} verify-merge-only: merge.renormalize=true in the repo config does not resolve a conflict`, async () => {
    // The PR adds `f.txt text` and renormalizes CRLF to LF; main edits a line keeping CRLF.
    const opts = { base: { 'f.txt': 'a\r\nb\r\nc\r\n' }, pr: { '.gitattributes': 'f.txt text\n', 'f.txt': 'a\nb\nc\n' }, main: { 'f.txt': 'a\r\nb\r\nC\r\n' } }
    await refused(mergeRepo(({ git }) => {
      git('config', 'merge.renormalize', 'true')
      mergeWith(git)
    }, opts), /cannot redo the merge/)
  })
}
