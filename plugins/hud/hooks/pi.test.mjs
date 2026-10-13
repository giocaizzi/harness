import { test } from 'node:test'
import assert from 'node:assert/strict'
import hudExtension, { linkMessage, piStatus, readRepo } from './pi.mjs'
import { repoOf } from './links.mjs'

test('linkMessage: text blocks of an assistant message get links; other roles and blocks are left alone', () => {
  const origin = repoOf('git@github.com:o/r.git')
  const msg = { role: 'assistant', content: [{ type: 'thinking', thinking: '#1' }, { type: 'text', text: 'fixed #2' }] }
  const out = linkMessage(msg, origin, false)
  assert.equal(out.content[0], msg.content[0])
  assert.equal(out.content[1].text, 'fixed [#2](https://github.com/o/r/issues/2)')
  assert.equal(linkMessage({ role: 'user', content: [{ type: 'text', text: '#2' }] }, origin, false), null)
  assert.equal(linkMessage({ role: 'assistant', content: [{ type: 'text', text: 'none' }] }, origin, false), null)
  assert.equal(linkMessage(msg, null, false), null)
})

test('message_end links the reply once the repo is read, only with a UI that takes links', async () => {
  const handlers = {}
  const origin = repoOf('git@github.com:o/r.git')
  let links = true
  hudExtension({ on: (e, f) => (handlers[e] = f) }, { readRepo: async () => ({ links: origin }), hyperlinks: async () => links })
  const ctx = { hasUI: true, getContextUsage: () => null, ui: { setStatus: () => {} } }
  handlers.session_start({}, ctx)
  await new Promise((r) => setTimeout(r, 0))
  const e = { message: { role: 'assistant', content: [{ type: 'text', text: 'see #3' }] } }
  assert.match((await handlers.message_end(e, ctx)).message.content[0].text, /\[.*#3\]\(https:\/\/github\.com\/o\/r\/issues\/3\)/)
  assert.equal(await handlers.message_end(e, { ...ctx, hasUI: false }), undefined)
  links = false
  assert.equal(await handlers.message_end(e, ctx), undefined)
})

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
