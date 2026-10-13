import { test } from 'node:test'
import assert from 'node:assert/strict'
import hudExtension, { piStatus, readRepo } from './pi.mjs'

test('piStatus: context, model, PR with checks, sync and changes; missing parts left out', () => {
  const repo = { pr: { number: 7, state: 'open', ci: 'pass', passed: 3, total: 3 }, ahead: 2, behind: 0, changes: { files: 1, added: 4, removed: 1, untracked: 1 } }
  const s = piStatus({ pct: 42.4, model: 'gpt-x', repo })
  for (const part of ['ctx:42%', 'gpt-x', '#7 3/3', '↑2 ↓0', '2 +4 -1']) assert.ok(s.includes(part), part)
  assert.equal(piStatus({ pct: null, model: null, repo: null }), '')
  assert.match(piStatus({ repo: { pr: { number: 7, state: 'merged', ci: null, passed: 0, total: 0 } } }), /#7 merged/)
})

test('readRepo: the GitHub PR and git counts through the injected runner', async () => {
  const out = {
    'git remote get-url origin': 'git@github.com:o/r.git\n',
    'gh pr view --json number,url,state,statusCheckRollup': JSON.stringify({ number: 9, state: 'OPEN', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }),
    'git rev-list --left-right --count @{u}...HEAD': '0\t1\n',
  }
  const r = await readRepo('/x', async (argv) => out[argv.join(' ')] ?? null)
  assert.equal(r.pr.number, 9)
  assert.equal(r.pr.ci, 'pass')
  assert.equal(r.ahead, 1)
})

test('the footer is drawn at session start, and a dead context is ignored', async () => {
  const handlers = {}
  const set = []
  hudExtension({ on: (e, f) => (handlers[e] = f) }, { readRepo: async () => null })
  const ctx = { hasUI: true, getContextUsage: () => ({ percent: 10 }), model: { id: 'm' }, ui: { setStatus: (k, v) => set.push([k, v]) } }
  handlers.session_start({}, ctx)
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(set.at(-1)[0], 'hud')
  assert.match(set.at(-1)[1], /ctx:10%/)
  const dead = { get hasUI() { throw new Error('stale') } }
  assert.doesNotThrow(() => handlers.turn_end({}, dead))
})
