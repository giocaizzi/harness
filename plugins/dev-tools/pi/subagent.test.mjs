import { test } from 'node:test'
import assert from 'node:assert/strict'
import subagentExtension, { childEnv, loadAgents, piArgs, MAX_DEPTH } from './subagent.mjs'

test('loadAgents: every plugin agent, with Claude tools mapped to pi tools', () => {
  const agents = Object.fromEntries(loadAgents().map((a) => [a.name, a]))
  for (const name of ['scout', 'escalate', 'api-reviewer']) assert.ok(agents[name], name)
  assert.deepEqual(agents.scout.tools, ['read', 'grep', 'find', 'ls', 'bash'])
  assert.equal(agents.escalate.tools, null)
  assert.equal(agents.scout.thinking, 'low')
  assert.match(agents.scout.prompt, /read-only scout/)
})

test('piArgs: session model, narrowed tools, the prompt file and the task', () => {
  assert.deepEqual(piArgs({ tools: ['read'] }, 'look', '/p.md', 'prov/m'), ['-p', '--no-session', '--model', 'prov/m', '--tools', 'read', '--append-system-prompt', '/p.md', 'Task: look'])
  assert.deepEqual(piArgs({ tools: null }, 'go', '/p.md'), ['-p', '--no-session', '--append-system-prompt', '/p.md', 'Task: go'])
  assert.deepEqual(piArgs({ tools: null, thinking: 'medium' }, 'go', '/p.md'), ['-p', '--no-session', '--thinking', 'medium', '--append-system-prompt', '/p.md', 'Task: go'])
})

test('the model and thinking level reach onUpdate before the child starts, for hud (#219)', async () => {
  let tool
  const events = []
  const agents = [{ name: 'scout', description: 'd', tools: null, thinking: 'low', prompt: 'p' }, { name: 'plain', description: 'd', tools: null, prompt: 'p' }]
  subagentExtension({ registerTool: (t) => (tool = t) }, { loadAgents: () => agents, run: async (argv) => (events.push(['run', argv]), { code: 0, out: 'ok', err: '' }) })
  const onUpdate = (u) => events.push(['update', u])
  await tool.execute('t1', { agent: 'scout', task: 'x' }, undefined, onUpdate, { cwd: '/', model: { provider: 'p', id: 'm' } })
  assert.deepEqual(events[0], ['update', { content: [], details: { model: 'p/m', thinking: 'low' } }])
  assert.equal(events[1][0], 'run')
  assert.ok(events[1][1].join(' ').includes('--model p/m --thinking low'))
  events.length = 0
  await tool.execute('t2', { agent: 'plain', task: 'x' }, undefined, onUpdate, { cwd: '/', model: { provider: 'p', id: 'm' } })
  assert.deepEqual(events[0], ['update', { content: [], details: { model: 'p/m' } }])
  assert.ok(!events[1][1].includes('--thinking'))
})

test('the tool runs the agent and returns its answer, or throws on failure', async () => {
  let tool
  const agents = [{ name: 'scout', description: 'd', tools: ['read'], prompt: 'p' }]
  subagentExtension({ registerTool: (t) => (tool = t) }, { loadAgents: () => agents, run: async (argv) => ({ code: 0, out: `ran ${argv.at(-1)}\n`, err: '' }) })
  assert.match(tool.description, /- scout: d/)
  const r = await tool.execute('id', { agent: 'scout', task: 'x' }, undefined, undefined, { cwd: '/', model: { provider: 'p', id: 'm' } })
  assert.equal(r.content[0].text, 'ran Task: x')
  await assert.rejects(tool.execute('id', { agent: 'nope', task: 'x' }, undefined, undefined, {}), /Unknown agent/)
  subagentExtension({ registerTool: (t) => (tool = t) }, { loadAgents: () => agents, run: async () => ({ code: 2, out: '', err: 'boom' }) })
  await assert.rejects(tool.execute('id', { agent: 'scout', task: 'x' }, undefined, undefined, {}), /exit 2.*boom/)
})

test("a subagent's pi runs without the guard's stop check and result gate: the parent's stop runs them", () => {
  assert.deepEqual(childEnv({ PATH: '/bin' }), { PATH: '/bin', GUARD_STOP_CHECK: 'off', GUARD_RESULT_GATE: 'off', PI_SUBAGENT_DEPTH: '1' })
})

test("the child names the parent session and itself, so the guard keeps its reminders apart and shares its skills (#172)", async () => {
  assert.deepEqual(childEnv({}, { session: 's1', agent: 'scout-t1' }), { GUARD_STOP_CHECK: 'off', GUARD_RESULT_GATE: 'off', PI_SUBAGENT_DEPTH: '1', GUARD_PARENT_SESSION: 's1', GUARD_AGENT_ID: 'scout-t1' })
  let tool
  let ids
  subagentExtension({ registerTool: (t) => (tool = t) }, { loadAgents: () => [{ name: 'scout', description: 'd', tools: null, prompt: 'p' }], run: async (_argv, _cwd, _signal, i) => ((ids = i), { code: 0, out: 'ok', err: '' }) })
  await tool.execute('t1', { agent: 'scout', task: 'x' }, undefined, undefined, { cwd: '/', sessionManager: { getSessionId: () => 's1' } })
  assert.deepEqual(ids, { session: 's1', agent: 'scout-t1' })
})

test('nesting is counted in the child and refused past MAX_DEPTH, so a driver can fan out but a loop cannot', async () => {
  assert.equal(childEnv({ PI_SUBAGENT_DEPTH: '1' }).PI_SUBAGENT_DEPTH, '2')
  let tool
  const agents = [{ name: 'worker', description: 'd', tools: ['read'], prompt: 'p' }]
  subagentExtension({ registerTool: (t) => (tool = t) }, { loadAgents: () => agents, run: async () => ({ code: 0, out: 'ok', err: '' }) })
  const saved = process.env.PI_SUBAGENT_DEPTH
  try {
    process.env.PI_SUBAGENT_DEPTH = String(MAX_DEPTH - 1)
    assert.equal((await tool.execute('id', { agent: 'worker', task: 'x' }, undefined, undefined, {})).content[0].text, 'ok')
    process.env.PI_SUBAGENT_DEPTH = String(MAX_DEPTH)
    await assert.rejects(tool.execute('id', { agent: 'worker', task: 'x' }, undefined, undefined, {}), /nest at most 3 deep; return the split/)
  } finally {
    if (saved === undefined) delete process.env.PI_SUBAGENT_DEPTH
    else process.env.PI_SUBAGENT_DEPTH = saved
  }
})
