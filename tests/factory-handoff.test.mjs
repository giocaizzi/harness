// Group-run member handoffs: scripts/check-handoff.mjs against fixtures and against the tables in group.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRIEF_KEYS, RESULT_KEYS, RUN_KEYS, briefErrors, memberResultErrors, memberTask, runFileErrors } from '../plugins/factory/skills/ticket-run/scripts/check-handoff.mjs'

// The runtime's variables never reach these tests: each case sets the ones it needs.
for (const k of ['FACTORY_RUN_ID', 'FACTORY_TICKET', 'FACTORY_RUN_FILE']) delete process.env[k]

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(repo, 'plugins/factory/skills/ticket-run/scripts/check-handoff.mjs')
const fixtures = join(repo, 'tests/fixtures/factory/handoff')
const fixture = (name) => JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8'))
const group = readFileSync(join(repo, 'plugins/factory/skills/ticket-run/references/group.md'), 'utf8')
const brief = fixture('brief-valid')

const invalidBriefs = {
  'relative-worktree': /worktree/,
  'bad-base': /base/,
  'empty-brief': /brief must be a non-empty/,
  kind: /handoff/,
  'extra-key': /unknown key "priority"/,
}
const invalidResults = {
  'done-no-head': /head/,
  'done-failing-check': /failing check/,
  'parked-no-code': /reason_code/,
  'ticket-mismatch': /ticket .* differs/,
  'branch-mismatch': /branch .* differs/,
  'run-mismatch': /run_id .* differs/,
  'extra-key': /unknown key "notes"/,
  'done-with-reason': /reason must be empty/,
  'member-handoff': /reason_code "handoff" is not for a member/,
  'done-no-pass': /at least one passed check/,
  'member-takeover': /reason_code "takeover" is not for a member to report/,
}

const invalidRuns = {
  'lead-not-first': /members\[0\] must be the lead/,
  duplicate: /duplicate ticket/,
  'lead-missing': /members\[0\] must be the lead/,
  'empty-members': /members must be a non-empty array/,
  'bad-ticket': /members\[1\]: ticket must be/,
  'extra-key': /unknown key "priority"/,
  schema: /schema must be 1/,
  'cross-repo': /members\[1\]: ticket .* is not in the lead's repo/,
  'case-duplicate': /members\[1\]: duplicate ticket/,
}

const on = (prefix) => readdirSync(fixtures).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length, -'.json'.length)).sort()

test('handoff: the invalid-fixture maps cover exactly the invalid files on disk', () => {
  assert.deepEqual(on('brief-invalid-'), Object.keys(invalidBriefs).sort())
  assert.deepEqual(on('result-invalid-'), Object.keys(invalidResults).sort())
  assert.deepEqual(on('run-invalid-'), Object.keys(invalidRuns).sort())
})

test('handoff: the run file fixture is valid and each invalid one names its fault', () => {
  assert.deepEqual(runFileErrors(fixture('run-valid'), {}), [])
  for (const [slug, re] of Object.entries(invalidRuns)) {
    const errors = runFileErrors(fixture(`run-invalid-${slug}`), {})
    assert.ok(errors.some((e) => re.test(e)), `${slug}: ${errors.join(' | ')}`)
  }
  assert.equal(runFileErrors(null, {}).length, 1)
})

test('handoff: the run file must match FACTORY_RUN_ID and FACTORY_TICKET when set', () => {
  const valid = fixture('run-valid')
  assert.deepEqual(runFileErrors(valid, { FACTORY_RUN_ID: 'r-1', FACTORY_TICKET: 'acme/app#12' }), [])
  assert.ok(runFileErrors(valid, { FACTORY_RUN_ID: 'r-2' }).some((e) => /differs from FACTORY_RUN_ID/.test(e)))
  assert.ok(runFileErrors(valid, { FACTORY_TICKET: 'acme/app#13' }).some((e) => /differs from FACTORY_TICKET/.test(e)))
  assert.deepEqual(runFileErrors(valid, { FACTORY_RUN_ID: 'r-1\n', FACTORY_TICKET: ' acme/app#12 ' }), [])
})

test('handoff: valid fixtures have no errors', () => {
  assert.deepEqual(briefErrors(brief), [])
  for (const name of ['done', 'parked', 'released']) assert.deepEqual(memberResultErrors(fixture(`result-valid-${name}`), brief), [], name)
})

test('handoff: each invalid fixture gives an error that names its fault', () => {
  for (const [slug, re] of Object.entries(invalidBriefs)) {
    const errors = briefErrors(fixture(`brief-invalid-${slug}`))
    assert.ok(errors.some((e) => re.test(e)), `${slug}: ${errors.join(' | ')}`)
  }
  for (const [slug, re] of Object.entries(invalidResults)) {
    const errors = memberResultErrors(fixture(`result-invalid-${slug}`), brief)
    assert.ok(errors.some((e) => re.test(e)), `${slug}: ${errors.join(' | ')}`)
  }
})

test('handoff: a non-object brief or result is one error', () => {
  assert.equal(briefErrors(null).length, 1)
  assert.equal(briefErrors([]).length, 1)
  assert.equal(memberResultErrors('x', brief).length, 1)
})

test('handoff: a not_run check needs a note', () => {
  const result = { ...fixture('result-valid-done'), checks: [{ command: 'make e2e', result: 'not_run' }] }
  assert.ok(memberResultErrors(result, brief).some((e) => /note/.test(e)))
})

const tableKeys = (heading) =>
  group.split(`## ${heading}`)[1].split('\n## ')[0].split('\n').filter((l) => l.startsWith('| `')).map((l) => l.match(/^\| `([^`]+)`/)[1])

test('handoff: the keys in the code equal the key columns of the tables in group.md', () => {
  assert.deepEqual([...BRIEF_KEYS].sort(), tableKeys('Member brief').sort())
  assert.deepEqual([...RESULT_KEYS].sort(), tableKeys('Member result').sort())
  assert.deepEqual([...RUN_KEYS].sort(), tableKeys('Run file').sort())
})

test('handoff: memberTask parks a malformed or missing handoff and keeps a valid one', () => {
  const task = (ticket, b, r) => memberTask(ticket, { ...b, ticket }, r, 'r-1')
  const done = memberTask('acme/app#13', brief, fixture('result-valid-done'), 'r-1')
  assert.deepEqual(done, { ticket: 'acme/app#13', outcome: 'done', reason: '', reason_code: null, pr_link: null })
  const bad = task('acme/app#14', brief, fixture('result-invalid-done-no-head'))
  assert.equal(bad.outcome, 'parked')
  assert.equal(bad.reason_code, 'handoff')
  assert.match(bad.reason, /^malformed handoff: /)
  assert.equal(bad.ticket, 'acme/app#14')
  const none = task('acme/app#15', brief, undefined)
  assert.deepEqual([none.outcome, none.reason_code, none.pr_link], ['parked', 'handoff', null])
  assert.match(none.reason, /no member result/)
  assert.equal(task('acme/app#16', fixture('brief-invalid-bad-base'), fixture('result-valid-done')).reason_code, 'handoff')
  assert.ok(task('acme/app#14', brief, { ...fixture('result-invalid-extra-key'), [`k${'x'.repeat(1000)}`]: 1 }).reason.length <= 300)
  const parked = memberTask('acme/app#13', brief, fixture('result-valid-parked'), 'r-1')
  assert.deepEqual([parked.outcome, parked.reason_code], ['parked', 'question'])
  const released = memberTask('acme/app#13', brief, fixture('result-valid-released'), 'r-1')
  assert.deepEqual([released.outcome, released.reason, released.reason_code], ['released', 'ticket already fixed upstream', null])
})

test('handoff: memberTask parks a brief for another ticket or another run, and skips the run check when no run id is set', () => {
  const result = fixture('result-valid-done')
  const wrongTicket = memberTask('acme/app#99', brief, result, 'r-1')
  assert.deepEqual([wrongTicket.ticket, wrongTicket.outcome, wrongTicket.reason_code], ['acme/app#99', 'parked', 'handoff'])
  assert.match(wrongTicket.reason, /brief ticket .* differs/)
  const wrongRun = memberTask('acme/app#13', brief, result, 'r-2')
  assert.deepEqual([wrongRun.outcome, wrongRun.reason_code], ['parked', 'handoff'])
  assert.match(wrongRun.reason, /brief run_id .* differs/)
  assert.equal(memberTask('ACME/app#13', brief, result, ' r-1\n').outcome, 'done')
  assert.equal(memberTask('acme/app#13', brief, result, '').outcome, 'done')
})

test('handoff: the tasks memberTask builds pass the result checker, a malformed member parked and a no-done group with no PR', async () => {
  const { resultErrors } = await import('../plugins/factory/skills/ticket-run/scripts/check-result.mjs')
  const base = JSON.parse(readFileSync(join(repo, 'tests/fixtures/factory/result/valid-group-no-done.json'), 'utf8'))
  const withPr = (tasks, pr) => tasks.map((t) => ({ ...t, pr_link: pr === null ? null : t.outcome === 'done' ? 'closes' : t.outcome === 'parked' ? 'refs' : null }))
  const lead = { ...brief, ticket: 'acme/app#12' }
  const shipped = [memberTask('acme/app#12', lead, { ...fixture('result-valid-done'), ticket: 'acme/app#12' }, 'r-1'), memberTask('acme/app#13', brief, fixture('result-invalid-done-no-head'), 'r-1')]
  const pr = 'https://github.com/acme/app/pull/20'
  // One member shipped, one parked on its handoff: the run is parked, the PR still carries the done member.
  assert.deepEqual(resultErrors({ ...base, end_state: 'parked', reason: 'acme/app#13 parked: its handoff was malformed', reason_code: null, pr, tasks: withPr(shipped, pr) }, {}), [])
  const none = [memberTask('acme/app#12', lead, undefined, 'r-1'), memberTask('acme/app#13', brief, fixture('result-invalid-extra-key'), 'r-1')]
  assert.deepEqual(none.map((t) => t.reason_code), ['handoff', 'handoff'])
  assert.deepEqual(resultErrors({ ...base, end_state: 'parked', reason: 'no member finished: both handoffs were malformed', reason_code: null, pr: null, tasks: withPr(none, null) }, {}), [])
})

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['FACTORY_RUN_ID', 'FACTORY_TICKET', 'FACTORY_RUN_FILE'].includes(k)))
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: cleanEnv })
const runWith = (extra, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...cleanEnv, ...extra } })
const at = (name) => join(fixtures, `${name}.json`)

test('handoff: the CLI exits 0 for valid files, 1 for invalid or unreadable, 2 for usage', () => {
  assert.equal(run('brief', at('brief-valid')).status, 0)
  assert.equal(run('result', at('brief-valid'), at('result-valid-done')).status, 0)
  const invalid = run('result', at('brief-valid'), at('result-invalid-done-no-head'))
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /head/)
  assert.equal(run('brief', at('brief-invalid-bad-base')).status, 1)
  const missing = run('brief', at('nope'))
  assert.equal(missing.status, 1)
  assert.equal(missing.stderr.trim().split('\n').length, 1)
  const dir = mkdtempSync(join(tmpdir(), 'handoff-'))
  try {
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{')
    const r = run('brief', broken)
    assert.equal(r.status, 1)
    assert.equal(r.stderr.trim().split('\n').length, 1)
    assert.match(r.stderr, /not valid JSON/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(run().status, 2)
  assert.equal(run('brief').status, 2)
  assert.equal(run('result', at('brief-valid')).status, 2)
  assert.equal(run('other', 'x').status, 2)
})

test('handoff: the CLI brief and result modes reject a brief whose run_id differs from FACTORY_RUN_ID', () => {
  for (const args of [['brief', at('brief-valid')], ['result', at('brief-valid'), at('result-valid-done')]]) {
    const other = runWith({ FACTORY_RUN_ID: 'r-2' }, ...args)
    assert.equal(other.status, 1, args[0])
    assert.match(other.stderr, /brief run_id "r-1" differs from the run's "r-2"/)
    assert.equal(runWith({ FACTORY_RUN_ID: 'r-1' }, ...args).status, 0, args[0])
    assert.equal(run(...args).status, 0, args[0])
  }
})

test('handoff: the run file checks ignore case in the repo and in the lead-first comparison', () => {
  const runFile = { schema: 1, run_id: 'r-1', lead: 'acme/app#12', members: [{ ticket: 'ACME/app#12' }, { ticket: 'Acme/App#13' }] }
  assert.deepEqual(runFileErrors(runFile, {}), [], 'pins repoOf lowercasing (Acme/App#13 is in the lead repo) and members[0] equal to the lead ignoring case (ACME/app#12)')
})

test('handoff: the CLI checks a run file from its argument or from FACTORY_RUN_FILE', () => {
  const env = cleanEnv
  const go = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...env, ...extra } })
  assert.equal(go(['run', at('run-valid')]).status, 0)
  const invalid = go(['run', at('run-invalid-duplicate')])
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /duplicate/)
  assert.equal(go(['run'], { FACTORY_RUN_FILE: at('run-valid') }).status, 0)
  assert.equal(go(['run'], { FACTORY_RUN_FILE: at('run-invalid-schema') }).status, 1)
  assert.equal(go(['run']).status, 2)
})

test('handoff: check-handoff.mjs imports only node: modules and ./check-result.mjs', () => {
  const imports = [...readFileSync(script, 'utf8').matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.ok(imports.length > 0)
  for (const spec of imports) assert.ok(spec.startsWith('node:') || spec === './check-result.mjs', spec)
})
