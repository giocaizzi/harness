// The factory contract is prose plus two templates; these keep them in step with docs/factory.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(repo, rel), 'utf8')
const doc = read('docs/factory.md')
// Rows of the docs table under a heading, keyed by the first cell's backticked name.
const tableKeys = (heading) => {
  const section = doc.split(`## ${heading}`)[1].split('\n## ')[0]
  return section.split('\n').filter((l) => l.startsWith('| `')).map((l) => l.match(/^\| `([^`]+)`/)[1])
}

test('result.json template: valid JSON whose keys are exactly the documented contract', () => {
  const result = JSON.parse(read('plugins/factory/template/result.json'))
  assert.deepEqual(Object.keys(result).sort(), tableKeys('Result contract').sort())
  assert.ok(['done', 'parked', 'failed'].includes(result.end_state))
  assert.equal(result.schema, 1)
})

test('config.yaml template: top-level keys are exactly the documented ones', () => {
  const keys = read('plugins/factory/template/config.yaml').split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0])
  assert.deepEqual(keys.sort(), tableKeys('Config: `.factory/config.yaml`').sort())
})

test('config.yaml template: placeholders only, no real logins, projects or hosts', () => {
  const text = read('plugins/factory/template/config.yaml')
  assert.match(text, /approvers:\n {2}- <github-login>/)
  assert.doesNotMatch(text, /https?:\/\//)
})
