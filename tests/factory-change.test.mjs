// A change run's unit brief and result: the checkers, their fixtures, and agreement with references/change.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(repo, rel), 'utf8')
const SCRIPTS = join(repo, 'plugins/factory/skills/ticket-run/scripts')
const FIXTURES = join(repo, 'tests/fixtures/factory/change')
const CHECK_CHANGE = join(SCRIPTS, 'check-change.mjs')
const WRITE = join(SCRIPTS, 'write-result.mjs')
const changeMod = () => import(pathToFileURL(CHECK_CHANGE).href)
const resultMod = () => import(pathToFileURL(join(SCRIPTS, 'check-result.mjs')).href)
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const fixtures = (prefix) => readdirSync(FIXTURES).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort()
const cleanEnv = (env = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FACTORY_'))), ...env })

const UNIT_EXPECTED = {
  'unit-invalid-no-approver-item.json': /at least one approver item/,
  'unit-invalid-check-with-author.json': /author: must be null for a check/,
  'unit-invalid-attempt-over-cap.json': /attempt: must be an integer from 1 to max_attempts/,
  'unit-invalid-pr-mismatch.json': /pr: .* is not the change/,
  'unit-invalid-extra-key.json': /unknown key/,
  'unit-invalid-duplicate-source.json': /appears twice/,
  'unit-invalid-issue-is-change.json': /must not include the change/,
  'unit-invalid-line-without-path.json': /line: needs a path/,
}
const RESULT_EXPECTED = {
  'result-invalid-cap-without-change.json': /fix_attempts needs change/,
  'result-invalid-done-not-pushed.json': /done needs a pushed commit/,
  'result-invalid-attempt-over-cap.json': /is over max_attempts/,
  'result-invalid-pr-mismatch.json': /pr must be the change's URL/,
  'result-invalid-issue-is-change.json': /must not include the change/,
  'result-invalid-bad-trigger.json': /trigger: must be one of/,
  'result-invalid-cap-not-parked.json': /fix_attempts needs end_state parked/,
}

test('unit fixtures: valid ones pass, each invalid one fails with its expected error', async () => {
  const { unitErrors } = await changeMod()
  const valid = fixtures('unit-valid-')
  assert.equal(valid.length, 3)
  for (const f of valid) assert.deepEqual(unitErrors(fixture(f)), [], f)
  const invalid = fixtures('unit-invalid-')
  assert.deepEqual(invalid, Object.keys(UNIT_EXPECTED).sort())
  for (const f of invalid) {
    const errors = unitErrors(fixture(f))
    assert.ok(errors.length > 0, f)
    assert.ok(errors.some((e) => UNIT_EXPECTED[f].test(e)), `${f}: ${errors.join(' | ')}`)
  }
  for (const bad of [null, 5, [], 'x']) assert.match(unitErrors(bad)[0], /must be a JSON object/)
})

test('result fixtures: valid ones pass resultErrors, each invalid one fails with its expected error', async () => {
  const { resultErrors } = await resultMod()
  const valid = fixtures('result-valid-')
  assert.equal(valid.length, 3)
  for (const f of valid) assert.deepEqual(resultErrors(fixture(f), {}), [], f)
  const invalid = fixtures('result-invalid-')
  assert.deepEqual(invalid, Object.keys(RESULT_EXPECTED).sort())
  for (const f of invalid) {
    const errors = resultErrors(fixture(f), {})
    assert.ok(errors.some((e) => RESULT_EXPECTED[f].test(e)), `${f}: ${errors.join(' | ')}`)
  }
})

test('unit: item text is capped at 4000 characters, items at 50', async () => {
  const { unitErrors, MAX_TEXT, MAX_ITEMS } = await changeMod()
  const unit = fixture('unit-valid-mention.json')
  const item = unit.items[0]
  assert.deepEqual(unitErrors({ ...unit, items: [{ ...item, text: 'x'.repeat(MAX_TEXT) }] }), [])
  assert.match(unitErrors({ ...unit, items: [{ ...item, text: 'x'.repeat(MAX_TEXT + 1) }] })[0], /at most 4000/)
  const items = (n) => Array.from({ length: n }, (_, i) => ({ ...item, source: `${item.source}-${i}` }))
  assert.deepEqual(unitErrors({ ...unit, items: items(MAX_ITEMS) }), [])
  assert.match(unitErrors({ ...unit, items: items(MAX_ITEMS + 1) })[0], /items: must be an array of 1 to 50/)
})

test('check-change: the CLI exits 0 valid, 1 invalid or missing, 2 without an argument', () => {
  const run = (...a) => spawnSync(process.execPath, [CHECK_CHANGE, ...a], { encoding: 'utf8', env: cleanEnv() })
  assert.equal(run(join(FIXTURES, 'unit-valid-changes-requested.json')).status, 0)
  const bad = run(join(FIXTURES, 'unit-invalid-extra-key.json'))
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /unknown key/)
  const missing = run(join(FIXTURES, 'none.json'))
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /none\.json: no such file/)
  const run2 = run()
  assert.equal(run2.status, 2)
  assert.match(run2.stderr, /usage:/)
})

test('write-result: a change object lands right after pr; fix_attempts without change is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'write-change-'))
  const main = join(dir, 'main')
  spawnSync('git', ['init', '-q', main])
  assert.equal(spawnSync('git', ['-c', 'user.email=a@example.test', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main }).status, 0)
  const { change, ticket, run_id, schema, host, finished_at, ...judgment } = fixture('result-valid-fix-done.json')
  void [ticket, run_id, schema, host, finished_at]
  const env = { FACTORY_TICKET: 'acme/app#14', FACTORY_RUN_ID: 'rt-14-1' }
  const write = (input) => spawnSync(process.execPath, [WRITE, '-'], { cwd: main, env: cleanEnv(env), encoding: 'utf8', input: JSON.stringify(input) })
  const file = join(main, '.factory', 'runs', '14', 'result.json')
  const out = write({ ...judgment, change })
  assert.equal(out.status, 0, out.stderr)
  const keys = Object.keys(JSON.parse(readFileSync(file, 'utf8')))
  assert.equal(keys[keys.indexOf('pr') + 1], 'change')
  rmSync(file)
  const refused = write({ ...judgment, end_state: 'parked', reason: 'cap', reason_code: 'fix_attempts' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /fix_attempts needs change/)
  assert.equal(existsSync(file), false)
  rmSync(dir, { recursive: true, force: true })
})

test('change.md agrees with the checkers: unit keys, item keys, triggers; the scripts import only node: modules and check-result', async () => {
  const { UNIT_KEYS, ITEM_KEYS } = await changeMod()
  const { CHANGE_TRIGGERS } = await resultMod()
  const doc = read('plugins/factory/skills/ticket-run/references/change.md')
  const section = doc.split('## Unit brief')[1].split('\n## ')[0]
  const [unitTable, itemTable] = section.split('Each item:')
  const keys = (text) => text.split('\n').filter((l) => l.startsWith('| `')).flatMap((l) => [...l.split('|')[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))
  assert.deepEqual(keys(unitTable), UNIT_KEYS)
  assert.deepEqual(keys(itemTable), ITEM_KEYS)
  const triggers = doc.split('## Triggers')[1].split('\n## ')[0]
  assert.deepEqual([...triggers.matchAll(/^- \*\*`([a-z_]+)`:\*\*/gm)].map((m) => m[1]), CHANGE_TRIGGERS)
  for (const f of ['check-change.mjs', 'check-result.mjs']) {
    const imports = [...read(`plugins/factory/skills/ticket-run/scripts/${f}`).matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    assert.ok(imports.length > 0)
    for (const m of imports) assert.ok(m.startsWith('node:') || m === './check-result.mjs', `${f} imports ${m}`)
  }
})
