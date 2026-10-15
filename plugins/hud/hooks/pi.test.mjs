import { test } from 'node:test'
import assert from 'node:assert/strict'
import hudExtension, { PI_DEFAULTS, piFacts, piOptions, piStatus, readRepo, rewriteMessage } from './pi.mjs'
import { repoOf } from './links.mjs'
import { createFacts } from './rewrite.mjs'

test('rewriteMessage: text blocks of an assistant message are rewritten; other roles and blocks are left alone', () => {
  const msg = { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'fixed x' }] }
  const out = rewriteMessage(msg, (t) => t.replace(/x$/, 'y'))
  assert.equal(out.content[0], msg.content[0])
  assert.equal(out.content[1].text, 'fixed y')
  assert.equal(rewriteMessage({ role: 'user', content: [{ type: 'text', text: 'x' }] }, () => 'y'), null)
  assert.equal(rewriteMessage({ role: 'assistant', content: [{ type: 'text', text: 'none' }] }, (t) => t), null)
})

test('piOptions: hud.json in the config dir over the pi defaults; none or broken JSON gives the defaults', () => {
  const seen = []
  const read = (p) => (seen.push(p), '{"editor":"zed","replyTimes":"on"}')
  assert.deepEqual(piOptions({ PI_CODING_AGENT_DIR: '/cfg' }, read), { replyTimes: 'on', editor: 'zed' })
  assert.match(seen[0], /cfg[/\\]hud\.json$/)
  piOptions({ HOME: '/h' }, read)
  assert.match(seen[1], /h[/\\]\.pi[/\\]agent[/\\]hud\.json$/)
  assert.deepEqual(piOptions({ HOME: '/h' }, () => 'not json'), PI_DEFAULTS)
  assert.deepEqual(piOptions({ HOME: '/h' }, () => { throw new Error('ENOENT') }), PI_DEFAULTS)
})

test('piFacts: stat, commit and state through node and the runner', async () => {
  const calls = []
  const f = piFacts('/repo', async (argv, cwd) => (calls.push([argv.join(' '), cwd]), argv[1] === 'cat-file' && argv[3] === 'abc1234^{commit}' ? '' : null))
  f.stat(import.meta.dirname)
  f.stat('/no/such/path/here')
  f.commit('abc1234')
  f.commit('def5678')
  await f.settle()
  assert.equal(f.stat(import.meta.dirname), 'dir')
  assert.equal(f.stat('/no/such/path/here'), null)
  assert.equal(f.commit('abc1234'), true)
  assert.equal(f.commit('def5678'), false)
  assert.deepEqual(calls[0], ['git cat-file -e abc1234^{commit}', '/repo'])
})

test('message_end rewrites the reply once the repo is read; without a UI that takes links only secrets are masked', async () => {
  const handlers = {}
  const origin = repoOf('git@github.com:o/r.git')
  let links = true
  const facts = () => createFacts({ state: async () => ({ kind: 'pr', state: 'merged' }) })
  hudExtension({ on: (e, f) => (handlers[e] = f) }, { readRepo: async () => ({ links: origin }), hyperlinks: async () => links, options: {}, facts })
  const ctx = { hasUI: true, cwd: '/r', getContextUsage: () => null, ui: { setStatus: () => {} } }
  handlers.session_start({}, ctx)
  await new Promise((r) => setTimeout(r, 0))
  const e = { message: { role: 'assistant', content: [{ type: 'text', text: 'see #3, key ghp_abcdefghijklmnopqrstuvwx1234' }] } }
  // The state lookup is waited for (the message is stored once): the merged glyph is there at once, no colour marks.
  const text = (await handlers.message_end(e, ctx)).message.content[0].text
  assert.match(text, /\[ #3\]\(https:\/\/github\.com\/o\/r\/issues\/3\)/)
  assert.match(text, / ghp_••••••••/)
  assert.doesNotMatch(text, /[﷐-﷒]/)
  const plain = (await handlers.message_end(e, { ...ctx, hasUI: false })).message.content[0].text
  assert.equal(plain, 'see #3, key ghp_••••••••')
  links = false
  assert.equal((await handlers.message_end(e, ctx)).message.content[0].text, plain)
  assert.equal(await handlers.message_end({ message: { role: 'assistant', content: [{ type: 'text', text: 'see #3' }] } }, { ...ctx, hasUI: false }), undefined)
})

test('before_agent_start adds the rule for references of other repositories once, after the repo is read', async () => {
  const handlers = {}
  hudExtension({ on: (e, f) => (handlers[e] = f) }, { readRepo: async () => ({ links: repoOf('git@github.com:o/r.git') }), options: {} })
  const e = { systemPromptOptions: {} }
  handlers.before_agent_start(e)
  assert.equal(e.systemPromptOptions.promptGuidelines, undefined) // no repository yet
  handlers.session_start({}, { hasUI: false, cwd: '/r' })
  await new Promise((r) => setTimeout(r, 0))
  handlers.before_agent_start(e)
  handlers.before_agent_start(e)
  assert.equal(e.systemPromptOptions.promptGuidelines.length, 1)
  assert.match(e.systemPromptOptions.promptGuidelines[0], /bare `#N` means an issue or pull request of o\/r.*write `owner\/repo#N`/)
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
