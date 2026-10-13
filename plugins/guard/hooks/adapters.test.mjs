// The in-process adapters (opencode, pi) over a fake harness API: the guard's decisions reach the harness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GuardPlugin } from './opencode.mjs'
import guardExtension from './pi.mjs'

const dir = (files = {}) => {
  const d = mkdtempSync(join(tmpdir(), 'adapter-test-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content)
  return d
}
const deps = () => ({ hostFacts: async () => ({}), run: async () => null, emit: async () => {}, launch: () => null, dataDir: dir() })

test('opencode: a denied command throws, a risky one too (no ask), a plain one passes', async () => {
  const hooks = await GuardPlugin({ client: {}, directory: dir({ 'uv.lock': '' }) }, deps())
  const before = (command) => hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command } })
  await assert.rejects(before('pip install x'), /uses uv/)
  await assert.rejects(before('rm -rf ~/x'), /cannot ask/)
  await before('ls')
})

test('opencode: the config hook appends bash asks last, and a covered risky command is left to opencode', async () => {
  const sessionPermission = []
  const client = { session: { get: async () => ({ data: { permission: sessionPermission } }) } }
  const hooks = await GuardPlugin({ client, directory: dir() }, deps())
  const cfg = { permission: { bash: { 'rm -rf *': 'allow', '*': 'allow' }, '*': 'allow' }, agent: { scout: { permission: { edit: 'deny' } }, x: {} } }
  await hooks.config(cfg)
  assert.deepEqual(Object.keys(cfg.permission), ['*', 'bash'])
  const bash = Object.entries(cfg.permission.bash)
  assert.deepEqual(bash[0], ['*', 'allow'])
  assert.deepEqual(bash.at(-1), ['terraform destroy *', 'ask'])
  assert.equal(cfg.permission.bash['rm -rf *'], 'ask')
  assert.equal(cfg.agent.scout.permission.bash['git reset --hard *'], 'ask')
  assert.equal(cfg.agent.x.permission, undefined)
  const before = (command) => hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command } })
  await before('rm -rf build')
  await assert.rejects(before('cd . && rm -rf build'), /cannot ask/)
  await assert.rejects(before('rm -rf ~/x'), /cannot ask/) // `~` expands: not a plain word
  sessionPermission.push({ permission: 'bash', pattern: '*', action: 'allow' }) // an API caller's tools: { bash: true }
  await assert.rejects(before('rm -rf build'), /cannot ask/)
})

test('opencode: `run --auto` approves asks itself, so the guard denies', async () => {
  const client = { session: { get: async () => ({ data: {} }) } }
  const hooks = await GuardPlugin({ client, directory: dir() }, { ...deps(), argv: ['bun', '/$bunfs/root/src/index.js', 'run', '--auto', 'go'] })
  await hooks.config({ permission: { bash: 'allow' } })
  await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'rm -rf build' } }), /cannot ask/)
})

test('opencode: a user deny on bash skips the asks, so the guard keeps denying', async () => {
  for (const permission of ['deny', { bash: { 'rm *': 'deny' } }, { '*': 'deny' }]) {
    const client = { session: { get: async () => ({ data: {} }) } }
    const hooks = await GuardPlugin({ client, directory: dir() }, deps())
    const cfg = { permission }
    await hooks.config(cfg)
    assert.deepEqual(cfg.permission, permission)
    await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'rm -rf ~/x' } }), /cannot ask/)
  }
})

test('opencode: a failing make check on idle is sent back once', async () => {
  const sent = []
  const client = { session: { prompt: async (p) => sent.push(p) } }
  const hooks = await GuardPlugin({ client, directory: dir({ Makefile: 'check:\n\t@echo boom; exit 1\n' }) }, deps())
  const idle = () => hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } })
  await idle()
  await idle()
  assert.equal(sent.length, 1)
  assert.match(sent[0].body.parts[0].text, /make check failed/)
})

const fakePi = () => {
  const handlers = {}
  const sent = []
  return { handlers, sent, api: { on: (e, f) => (handlers[e] = f), sendUserMessage: async (m) => sent.push(m) } }
}

test('pi: deny blocks, ask confirms through the UI and blocks without one', async () => {
  const { handlers, api } = fakePi()
  guardExtension(api, deps())
  const cwd = dir({ 'uv.lock': '' })
  const ctx = (confirm) => ({ cwd, hasUI: confirm !== undefined, ui: { confirm: async () => confirm }, sessionManager: { getSessionId: () => 's' } })
  const call = (command, c) => handlers.tool_call({ toolName: 'bash', toolCallId: 't', input: { command } }, c)
  assert.match((await call('pip install x', ctx())).reason, /uses uv/)
  assert.equal(await call('rm -rf ~/x', ctx(true)), undefined)
  assert.equal((await call('rm -rf ~/x', ctx(false))).block, true)
  assert.equal((await call('rm -rf ~/x', ctx())).block, true)
})

test('pi: a failing make check on settle is sent back once, an aborted run is left alone', async () => {
  const { handlers, sent, api } = fakePi()
  guardExtension(api, deps())
  const ctx = { cwd: dir({ Makefile: 'check:\n\t@echo boom; exit 1\n' }) }
  await handlers.agent_settled({ aborted: true }, ctx)
  await handlers.agent_settled({ aborted: false }, ctx)
  await handlers.agent_settled({ aborted: false }, ctx)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /make check failed/)
})
