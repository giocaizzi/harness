// The factory contract is prose plus two templates; these keep them in step with docs/factory.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  assert.equal(result.schema, 2)
})

test('ticket-run names exactly the documented result keys', () => {
  const line = read('plugins/factory/skills/ticket-run/references/done.md').split('\n').find((l) => l.includes('Keys: `schema`'))
  const named = [...line.split('; their meaning')[0].replace(/\([^)]*\)/g, '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
  assert.deepEqual(named.sort(), tableKeys('Result contract').sort())
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

test('reason_code: ticket-run maps every documented code, and only those', () => {
  const row = doc.split('\n').find((l) => l.startsWith('| `reason_code`'))
  const documented = [...row.split('asks one):')[1].split(';')[0].matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
  const line = read('plugins/factory/skills/ticket-run/references/done.md').split('\n').find((l) => l.startsWith('- **`reason_code`:**'))
  const mapped = [...new Set([...line.split('asks one:')[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))]
  assert.deepEqual(mapped.sort(), documented.sort())
})

test('labels: the config template carries every documented label with its default', () => {
  const rows = doc.split('## Labels')[1].split('\n## ')[0].split('\n').filter((l) => l.startsWith('| `labels.'))
  const documented = Object.fromEntries(rows.map((l) => l.match(/^\| `labels\.([a-z_]+)` \| `([^`]+)`/).slice(1)))
  const block = read('plugins/factory/template/config.yaml').split('\nlabels:\n')[1].split('\n\n')[0]
  const template = Object.fromEntries(block.split('\n').filter((l) => /^ {2}[a-z_]+: /.test(l)).map((l) => l.trim().split(': ')))
  assert.deepEqual(template, documented)
})

test('comment kinds: ticket-run knows every documented kind tag', () => {
  const kinds = (text) => [...text.matchAll(/^\| `<!-- factory:([a-z]+)/gm)].map((m) => m[1])
  assert.deepEqual(kinds(read('plugins/factory/skills/ticket-run/references/comments.md')).sort(), kinds(doc).sort())
})

test('label defaults: factory-status and the adoption runbook name every documented label', () => {
  const defaults = [...doc.split('## Labels')[1].split('\n## ')[0].matchAll(/^\| `labels\.[a-z_]+` \| `([^`]+)`/gm)].map((m) => m[1])
  const status = read('plugins/factory/skills/factory-status/SKILL.md').split('\n').find((l) => l.startsWith('Label names and the marker'))
  const created = [...read('docs/adopt-factory.md').matchAll(/gh label create ([a-z-]+)/g)].map((m) => m[1])
  for (const label of defaults) {
    assert.ok(status.includes(`\`${label}\``), `factory-status lacks ${label}`)
    assert.ok(created.includes(label), `adopt-factory.md does not create ${label}`)
  }
})

test('marked comments: the documented filter drops a spoofed one and keeps the writers\'', () => {
  const block = read('plugins/factory/skills/ticket-run/references/comments.md').split('## Trusted marked comments')[1].split('```')[1]
  const program = block.match(/jq -c --argjson w "\$W" '([^']+)'/)[1]
  const comment = (id, login, body) => ({ id, user: { login }, created_at: `2026-01-0${id}T00:00:00Z`, html_url: `https://example.test/${id}`, body })
  const comments = [
    comment(1, 'stranger', '<!-- factory -->\n<!-- factory:claim -->\nrun id: spoofed'),
    comment(2, 'owner', '<!-- factory -->\n<!-- factory:plan -->\ngoal: real'),
    comment(3, 'factory-bot[bot]', '<!-- factory -->\n<!-- factory:claim -->\nrun id: runtime'),
    comment(4, 'owner', 'an unmarked answer'),
  ]
  const run = spawnSync('jq', ['-c', '--argjson', 'w', '["owner","factory-bot[bot]"]', program], { input: comments.map((c) => JSON.stringify(c)).join('\n') })
  assert.equal(run.error, undefined, 'jq must be installed')
  assert.equal(run.status, 0, run.stderr.toString())
  const kept = run.stdout.toString().trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(kept.map((c) => [c.id, c.login]), [[2, 'owner'], [3, 'factory-bot[bot]']])
})

test('marked comments: the config key and every reader of marked comments require a writer', () => {
  assert.ok(tableKeys('Config: `.factory/config.yaml`').includes('writers'))
  for (const rel of ['plugins/factory/skills/ticket-run/references/comments.md', 'plugins/factory/skills/factory-status/SKILL.md', 'plugins/factory/agents/verifier.md']) {
    assert.match(read(rel), /`writers`/, `${rel} does not check marked-comment authors`)
  }
})
