import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandHash, failedTarget, guardVersion, harnessName, recordAttrs, repoName, scrub } from './telemetry.mjs'

test('harnessName: the --harness flag wins, then the data dir each harness sets', () => {
  assert.equal(harnessName(['node', 'stop.mjs', '--harness=codex'], { CLAUDE_PLUGIN_DATA: '/d' }), 'codex')
  assert.equal(harnessName([], { CLAUDE_PLUGIN_DATA: '/d', CLAUDE_PLUGIN_ROOT: '/r' }), 'claude')
  assert.equal(harnessName([], { COPILOT_PLUGIN_DATA: '/d' }), 'copilot')
  assert.equal(harnessName([], { CLAUDE_PLUGIN_ROOT: '/r' }), 'vscode')
  assert.equal(harnessName([], {}), 'other')
})

test('recordAttrs: harness, guard version and repo only when a record will be sent', () => {
  assert.deepEqual(recordAttrs({ a: 1 }, '/', 'claude', {}), { a: 1 })
  assert.deepEqual(recordAttrs({ a: 1 }, '/', 'claude', { GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', GUARD_OTEL: 'off' }), { a: 1 })
  const r = recordAttrs({ a: 1 }, '/', 'claude', { GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' })
  assert.equal(r.harness, 'claude')
  assert.equal(r.guard_version, guardVersion())
  assert.match(r.guard_version, /^\d+\.\d+\.\d+$/)
})

test('repoName: the git top level basename, once per directory; null outside git', () => {
  let calls = 0
  const run = () => (calls++, '/Users/me/src/harness\n')
  assert.equal(repoName('/x/y', run), 'harness')
  assert.equal(repoName('/x/y', run), 'harness')
  assert.equal(calls, 1)
  assert.equal(repoName('/nowhere', () => { throw new Error('not a repo') }), null)
})

test('scrub: secrets and long tokens are masked, the line is capped', () => {
  assert.equal(scrub('error: TOKEN=abc123 failed'), 'error: TOKEN=*** failed')
  assert.equal(scrub('auth: Bearer x'), 'auth: *** x')
  assert.equal(scrub('got ghp_abcdefghijklmnopqrstuvwxyz0123'), 'got ***')
  assert.equal(scrub('x'.repeat(300)).length <= 200, true)
})

test('failedTarget: the innermost make target that failed', () => {
  assert.equal(failedTarget('ok\nmake[1]: *** [Makefile:12: test] Error 1\nmake: *** [check] Error 2'), 'test')
  assert.equal(failedTarget('make: *** [lint] Error 2'), 'lint')
  assert.equal(failedTarget('nothing'), null)
})

test('commandHash: whitespace does not change it, the command text never shows', () => {
  assert.equal(commandHash('rm  -rf   x'), commandHash(' rm -rf x '))
  assert.match(commandHash('rm -rf x'), /^[0-9a-f]{12}$/)
})
