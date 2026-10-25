// Tests for plugins/dev-tools/skills/land/scripts/wait-pr.{sh,ps1} against a scripted `gh` on PATH.
// The .sh runs on macOS/Linux, the .ps1 wherever pwsh is installed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = fileURLToPath(new URL('../plugins/dev-tools/skills/land/scripts/', import.meta.url))
const win = process.platform === 'win32'

// The shim: each `gh pr view` takes the next step (the last one repeats); `gh pr checks` answers from the same step.
// A step is { view: {state, mergeStateStatus} | 'error', checks?: [{name, bucket, link}] }; no checks means none reported.
// `--jq` goes through jq, as gh would apply it.
const shim = `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const [, , cmd, sub, ...rest] = process.argv
const steps = JSON.parse(readFileSync(process.env.SHIM_STEPS, 'utf8'))
const counter = process.env.SHIM_STEPS + '.n'
let n = 0
try { n = Number(readFileSync(counter, 'utf8')) } catch {}
appendFileSync(process.env.SHIM_STEPS + '.log', sub + '\\n')
if (sub === 'view') writeFileSync(counter, String(++n))
const step = steps[Math.min(Math.max(n, 1), steps.length) - 1]
const jq = rest.indexOf('--jq')
const out = (data, code) => {
  let text = JSON.stringify(data)
  if (jq >= 0) text = spawnSync('jq', ['-r', rest[jq + 1]], { input: text, encoding: 'utf8' }).stdout.replace(/\\n$/, '')
  if (text) process.stdout.write(text + '\\n')
  process.exit(code)
}
if (cmd !== 'pr') process.exit(64)
if (sub === 'view') {
  if (step.view === 'error') { process.stderr.write('GraphQL: Could not resolve to a PullRequest\\n'); process.exit(1) }
  out(step.view, 0)
}
if (sub === 'checks') {
  if (!step.checks) { process.stderr.write("no checks reported on the 'x' branch\\n"); process.exit(1) }
  const b = step.checks.map((c) => c.bucket)
  out(step.checks, b.includes('fail') || b.includes('cancel') ? 1 : b.includes('pending') ? 8 : 0)
}
process.exit(64)
`

const bin = mkdtempSync(join(tmpdir(), 'wait-pr-bin-'))
writeFileSync(join(bin, 'shim.mjs'), shim)
writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec node "$(dirname "$0")/shim.mjs" "$@"\n`)
chmodSync(join(bin, 'gh'), 0o755)
writeFileSync(join(bin, 'gh.cmd'), '@node "%~dp0shim.mjs" %*\r\n')

const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0
const runners = [
  ...(win ? [] : [['sh', (args) => ['bash', [join(scripts, 'wait-pr.sh'), ...args]]]]),
  ...(pwsh ? [['ps1', (args) => ['pwsh', ['-NoProfile', '-File', join(scripts, 'wait-pr.ps1'), ...args]]]] : []),
]

const open = (mergeStateStatus = 'BLOCKED', checks) => ({ view: { state: 'OPEN', mergeStateStatus }, checks })
const check = (name, bucket) => ({ name, bucket, link: `https://ci.example/${name.replace(/ /g, '-')}` })

function run(kind, steps, args = ['--interval', '0']) {
  const dir = mkdtempSync(join(tmpdir(), 'wait-pr-'))
  const file = join(dir, 'steps.json')
  writeFileSync(file, JSON.stringify(steps))
  const [exe, argv] = runners.find(([k]) => k === kind)[1](['12', ...args])
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, SHIM_STEPS: file, WAIT_PR_INTERVAL: '', WAIT_PR_TIMEOUT: '' }
  const r = spawnSync(exe, argv, { env, encoding: 'utf8', timeout: 30000 })
  let calls = []
  try { calls = readFileSync(file + '.log', 'utf8').trim().split('\n') } catch {}
  return { code: r.status, out: r.stdout, err: r.stderr, calls }
}

for (const [kind] of runners) {
  test(`${kind}: merged exits 0 after the open polls`, () => {
    const r = run(kind, [open('BLOCKED', [check('check', 'pending')]), { view: { state: 'MERGED', mergeStateStatus: 'UNKNOWN' } }])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /PR 12 merged/)
  })

  test(`${kind}: closed without merging exits 1`, () => {
    const r = run(kind, [open(), { view: { state: 'CLOSED', mergeStateStatus: 'UNKNOWN' } }])
    assert.equal(r.code, 1, r.err)
    assert.match(r.out, /closed without merging/)
  })

  test(`${kind}: a failed required check exits 3 with its name and link`, () => {
    const r = run(kind, [open('BLOCKED', [check('lint', 'pass'), check('e2e tests', 'fail'), check('build', 'pending')])])
    assert.equal(r.code, 3, r.err)
    assert.match(r.out, /required check failed\n {2}e2e tests https:\/\/ci\.example\/e2e-tests\n$/)
  })

  test(`${kind}: a cancelled required check exits 3`, () => {
    const r = run(kind, [open('BLOCKED', [check('check', 'cancel')])])
    assert.equal(r.code, 3, r.err)
    assert.match(r.out, /check https:\/\/ci\.example\/check/)
  })

  test(`${kind}: BEHIND and DIRTY exit 4`, () => {
    const behind = run(kind, [open('BEHIND', [check('check', 'pass')])])
    assert.equal(behind.code, 4, behind.err)
    assert.match(behind.out, /behind its base/)
    const dirty = run(kind, [open('DIRTY')])
    assert.equal(dirty.code, 4, dirty.err)
    assert.match(dirty.out, /merge conflict/)
  })

  test(`${kind}: no outcome exits 124 at the timeout with the state, one call pair per poll`, () => {
    const r = run(kind, [open('BLOCKED', [check('check', 'pending'), check('Validate PR title', 'pending')])], ['--interval', '1', '--timeout', '2'])
    assert.equal(r.code, 124, r.err)
    assert.match(r.out, /timed out after 2s, state OPEN, mergeStateStatus BLOCKED, pending required checks: check,Validate PR title/)
    const views = r.calls.filter((c) => c === 'view').length
    assert.ok(views >= 2 && views <= 4, `views: ${views}`)
    assert.deepEqual(r.calls, Array(views).fill(['view', 'checks']).flat())
  })

  test(`${kind}: gh failing 3 polls in a row exits 5 with its error`, () => {
    const r = run(kind, [{ view: 'error' }])
    assert.equal(r.code, 5)
    assert.match(r.err, /failed 3 times in a row/)
    assert.match(r.err, /Could not resolve/)
  })

  test(`${kind}: a transient gh error and a PR without checks keep waiting`, () => {
    const r = run(kind, [{ view: 'error' }, open('BLOCKED'), { view: 'error' }, { view: { state: 'MERGED', mergeStateStatus: 'UNKNOWN' } }])
    assert.equal(r.code, 0, r.err)
  })

  test(`${kind}: bad arguments exit 2`, () => {
    assert.equal(run(kind, [open()], ['--interval']).code, 2)
    assert.equal(run(kind, [open()], ['--timeout', 'soon']).code, 2)
    assert.equal(run(kind, [open()], ['13']).code, 2)
  })
}
