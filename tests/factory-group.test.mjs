// A group run's result: `tasks` (schema 3) checked by check-result and written by write-result.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(repo, 'plugins/factory/skills/ticket-run/scripts')
const WRITE = join(SCRIPTS, 'write-result.mjs')
const FIXTURES = join(repo, 'tests/fixtures/factory/result')
const checker = () => import(pathToFileURL(join(SCRIPTS, 'check-result.mjs')).href)
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()
const validFiles = files.filter((f) => f.startsWith('valid-'))
const invalidFiles = files.filter((f) => f.startsWith('invalid-'))

// The first error each invalid fixture must raise.
const EXPECTED = {
  'tasks-schema2': /tasks needs schema 3/,
  'schema3-no-tasks': /schema 3 needs tasks/,
  'empty-tasks': /tasks must be a non-empty array/,
  'lead-not-first': /tasks\[0\].*lead.*first/,
  'duplicate-ticket': /tasks\[1\].*listed twice/,
  'unknown-outcome': /tasks\[1\].*outcome must be one of/,
  'extra-key': /tasks\[1\].*"note" not allowed/,
  'done-with-reason': /tasks\[1\].*reason must be "" when done/,
  'parked-no-code': /tasks\[1\].*reason_code must be .*when parked/,
  'released-no-reason': /tasks\[1\].*reason must be a non-empty string when released/,
  'link-mismatch': /tasks\[1\].*pr_link must be "closes"/,
  'released-with-link': /tasks\[2\]: pr_link must be null when released/,
  'link-without-pr': /tasks\[0\].*pr_link must be null when parked without a pr/,
  'no-done-with-pr': /tasks: no done entry, so pr must be null/,
  'no-done-end-done': /tasks: no done entry, so end_state must not be done/,
  'turns-negative': /tasks\[1\]: turns must be a non-negative integer, got -1/,
  'turns-fraction': /tasks\[1\]: turns must be a non-negative integer, got 2.5/,
  'turns-string': /tasks\[1\]: turns must be a non-negative integer/,
  'done-without-pr': /tasks: a done entry needs pr/,
}

test('group result: the valid fixtures pass the checker', async () => {
  const { resultErrors } = await checker()
  assert.equal(validFiles.length, 4)
  for (const f of validFiles) assert.deepEqual(resultErrors(fixture(f), {}), [], f)
})

test('group result: every invalid fixture fails with its own error, and the map covers exactly the files', async () => {
  const { resultErrors } = await checker()
  assert.deepEqual(invalidFiles.map((f) => f.slice('invalid-'.length, -'.json'.length)).sort(), Object.keys(EXPECTED).sort())
  for (const f of invalidFiles) {
    const errors = resultErrors(fixture(f), {})
    const slug = f.slice('invalid-'.length, -'.json'.length)
    assert.ok(errors.some((e) => EXPECTED[slug].test(e)), `${f}: ${JSON.stringify(errors)}`)
  }
})

test('group result: schema 2 or 3 only, and handoff is a reason code', async () => {
  const { coreErrors, REASON_CODES, OUTCOMES, PR_LINKS } = await checker()
  const result = fixture('valid-single.json')
  assert.deepEqual(coreErrors({ ...result, schema: 3 }, {}), [])
  assert.match(coreErrors({ ...result, schema: 4 }, {})[0], /schema must be 2, or 3 with tasks, got 4/)
  assert.deepEqual(REASON_CODES.slice(-2), ['handoff', 'takeover'])
  // handoff is a member's park code: never the run's own.
  for (const schema of [2, 3]) assert.match(coreErrors({ ...result, schema, end_state: 'parked', reason: 'x', reason_code: 'handoff' }, {})[0], /handoff belongs only in a tasks entry/)
  assert.deepEqual([OUTCOMES, PR_LINKS], [['done', 'parked', 'released'], ['closes', 'refs']])
})

const cleanEnv = (env = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FACTORY_'))), ...env })
const scratchRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'group-result-'))
  const main = join(dir, 'main')
  spawnSync('git', ['init', '-q', main])
  const c = spawnSync('git', ['-c', 'user.email=a@example.test', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main })
  assert.equal(c.status, 0)
  return { main, done: () => rmSync(dir, { recursive: true, force: true }) }
}
const write = (cwd, args) => {
  const run = spawnSync(process.execPath, [WRITE, ...args], { cwd, env: cleanEnv({ FACTORY_RUN_ID: 'rt-1', FACTORY_TICKET: 'acme/app#12' }), encoding: 'utf8' })
  return { status: run.status, stderr: run.stderr }
}
// A fixture as write-result input: the keys the script fills itself are dropped.
const input = (name) => {
  const { schema, ticket, run_id, mode, finished_at, ...rest } = fixture(name)
  return rest
}
const resultFile = (main) => join(main, '.factory', 'runs', '12', 'result.json')

test('group result: the writer writes schema 3 with tasks, schema 2 without', () => {
  const r = scratchRepo()
  writeFileSync(join(r.main, 'group.json'), JSON.stringify(input('valid-group-all-outcomes.json')))
  assert.equal(write(r.main, ['group.json']).status, 0)
  const group = JSON.parse(readFileSync(resultFile(r.main), 'utf8'))
  assert.equal(group.schema, 3)
  assert.deepEqual(group.tasks, fixture('valid-group-all-outcomes.json').tasks)
  const keys = Object.keys(group)
  assert.ok(keys.indexOf('pr') < keys.indexOf('tasks') && keys.indexOf('tasks') < keys.indexOf('decisions'))
  writeFileSync(join(r.main, 'single.json'), JSON.stringify(input('valid-single.json')))
  assert.equal(write(r.main, ['single.json']).status, 0)
  const single = JSON.parse(readFileSync(resultFile(r.main), 'utf8'))
  assert.equal(single.schema, 2)
  assert.equal('tasks' in single, false)
  r.done()
})

test('group result: the writer refuses tasks that break a rule and writes nothing', () => {
  const r = scratchRepo()
  writeFileSync(join(r.main, 'bad.json'), JSON.stringify(input('invalid-link-mismatch.json')))
  const out = write(r.main, ['bad.json'])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /pr_link must be "closes"/)
  assert.equal(existsSync(resultFile(r.main)), false)
  const takeover = input('valid-group-all-outcomes.json')
  takeover.tasks = takeover.tasks.map((t) => (t.outcome === 'parked' ? { ...t, reason_code: 'takeover' } : t))
  writeFileSync(join(r.main, 'takeover.json'), JSON.stringify(takeover))
  const refused = write(r.main, ['takeover.json'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /tasks: reason_code takeover is written only by a runtime/)
  assert.equal(existsSync(resultFile(r.main)), false)
  r.done()
})
