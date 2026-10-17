// The in-process adapters (opencode, pi) over a fake harness API: the guard's decisions reach the harness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GuardPlugin } from './opencode.mjs'
import guardExtension from './pi.mjs'

// These tests expect the stop check to run; a developer's own GUARD_STOP_CHECK=off must not leak in.
delete process.env.GUARD_STOP_CHECK

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
  assert.deepEqual(bash.at(-1), ['less .env *', 'ask'])
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
  // Every yargs spelling of the flag (the re-review found `--auto=true` slipping through `includes`).
  for (const flag of [['--auto'], ['--auto=true'], ['--auto', 'true'], ['--auto=1']]) {
    const client = { session: { get: async () => ({ data: {} }) } }
    const hooks = await GuardPlugin({ client, directory: dir() }, { ...deps(), argv: ['bun', '/$bunfs/root/src/index.js', 'run', ...flag, 'go'] })
    await hooks.config({ permission: { bash: 'allow' } })
    await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'rm -rf build' } }), /cannot ask/, flag.join(' '))
  }
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

test('opencode and pi: a shell file edit gets the edit-tool reminder in the tool output, once', async () => {
  const hooks = await GuardPlugin({ client: {}, directory: dir() }, deps())
  const output = { args: { command: "sed -i 's/a/b/' f.txt" }, output: 'done' }
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'e', callID: 'c1' }, output)
  await hooks['tool.execute.after']({ tool: 'bash', callID: 'c1', args: output.args }, output)
  assert.match(output.output, /^done\n\nEdit files with the harness's edit tool/)
  const { handlers, api } = fakePi()
  guardExtension(api, deps())
  const ctx = { cwd: dir(), sessionManager: { getSessionId: () => 'e' } }
  const call = (id) => handlers.tool_call({ toolName: 'bash', toolCallId: id, input: { command: 'echo x > notes.md' } }, ctx)
  const result = (id) => handlers.tool_result({ toolName: 'bash', toolCallId: id, input: {}, content: [] }, ctx)
  await call('t1')
  assert.match((await result('t1')).content[0].text, /edit tool/)
  await call('t2')
  assert.equal(await result('t2'), undefined)
})

test('opencode: a failing make check on idle is sent back once', async () => {
  const sent = []
  const client = { session: { prompt: async (p) => sent.push(p) } }
  const hooks = await GuardPlugin({ client, directory: dir({ Makefile: 'check:\n\t@false\n' }) }, deps())
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
  const ctx = { cwd: dir({ Makefile: 'check:\n\t@false\n' }) }
  await handlers.agent_settled({ aborted: true }, ctx)
  await handlers.agent_settled({ aborted: false }, ctx)
  await handlers.agent_settled({ aborted: false }, ctx)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /make check failed/)
})

test('usage: opencode and pi report each assistant message once, as their own service', async () => {
  const sent = []
  const report = async (event, attrs) => sent.push([event, attrs.model, attrs.input_tokens, attrs.cache_read_tokens, attrs.cost_usd, attrs['session.id']])
  const hooks = await GuardPlugin({ client: {}, directory: dir() }, { ...deps(), report })
  const info = { id: 'm1', role: 'assistant', sessionID: 's1', modelID: 'gpt-6.1-sol', providerID: 'openai', time: { completed: 1 }, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 3, write: 0 } }, cost: 0.002 }
  await hooks.event({ event: { type: 'message.updated', properties: { info: { ...info, time: {} } } } }) // still streaming
  await hooks.event({ event: { type: 'message.updated', properties: { info } } })
  await hooks.event({ event: { type: 'message.updated', properties: { info } } }) // repeated update
  const handlers = {}
  guardExtension({ on: (name, fn) => (handlers[name] = fn) }, { ...deps(), report })
  const ctx = { cwd: dir(), sessionManager: { getSessionId: () => 'p1' } }
  await handlers.message_end({ message: { role: 'user' } }, ctx)
  await handlers.message_end({ message: { role: 'assistant', model: 'claude-sonnet-5-5', provider: 'anthropic', usage: { input: 7, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.0001 } } } }, ctx)
  assert.deepEqual(sent, [
    ['api_request', 'gpt-6.1-sol', 10, 3, 0.002, 's1'],
    ['api_request', 'claude-sonnet-5-5', 7, 1, 0.0001, 'p1'],
  ])
})
