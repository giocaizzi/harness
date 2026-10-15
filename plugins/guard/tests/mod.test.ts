import { expect, mock, test } from 'claude-code/testing'

const usage = (percent: number) => ({
  value: {
    startedAt: 0,
    context: { tokens: 0, window: 1000000, percent: 12 },
    rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt: '2030-01-01T00:00:00Z' }],
  },
})

test('subagents are refused at the throttle level', async ($, on) => {
  on('session.usage', () => usage(95))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  const r = await $.agent.spawn({ prompt: 'x' })
  expect(r.deny).toContain('95%')
})

test('subagents are allowed below the throttle level', async ($, on) => {
  on('session.usage', () => usage(40))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  const r = await $.agent.spawn({ prompt: 'x' })
  expect(r.deny).toBeUndefined()
})

test('a throttle denial posts a record to the collector when the session exports to one', async ($, on) => {
  on('session.usage', () => usage(95))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('env.get', (_$, e) => ({ value: e.name === 'OTEL_EXPORTER_OTLP_ENDPOINT' ? 'http://collector' : undefined }))
  const posted: string[] = []
  on('http.fetch', (_$, e) => {
    posted.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  const r = await $.agent.spawn({ prompt: 'x' })
  expect(r.deny).toContain('95%')
  expect(posted).toEqual(['http://collector/v1/logs'])
})

test('without an endpoint a throttle denial posts nothing', async ($, on) => {
  on('session.usage', () => usage(95))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('env.get', () => ({ value: undefined }))
  on('http.fetch', () => {
    throw new Error('must not post')
  })
  expect((await $.agent.spawn({ prompt: 'x' })).deny).toContain('95%')
})

// The test's tool.check hook stands for the engine: an ask from the guard's command hook.
const ask = () => ({ decision: 'ask' as const, reason: 'guard: recursive delete', hook: 'PreToolUse' })
const call = { tool: 'Bash', input: { command: 'rm -r build' }, tool_use_id: 't1' } as never

// The person picks `label` in the plugin's dialog.
function answer(on: Parameters<Parameters<typeof test>[1]>[1], label: string) {
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({ result: { questions: e.questions, answers: { [e.questions[0].question]: label } } }) as never)
}

test('an ask the person allows in the guard dialog runs', async ($, on) => {
  on('tool.check', ask)
  answer(on, 'Allow')
  expect((await $.tool.check(call)).decision).toBe('allow')
})

test('an ask the person denies is refused', async ($, on) => {
  on('tool.check', ask)
  answer(on, 'Deny')
  const r = await $.tool.check(call)
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('denied')
})

test('an ask nobody answers is denied after the timeout', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.check', ask)
  on('tool.call', { tool: 'AskUserQuestion' }, () => new Promise(() => {}))
  const pending = $.tool.check(call)
  await clock.advance(60_000)
  const r = await pending
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain("isn't there")
})

test('a query, a non-ask and a question are left to the engine', async ($, on) => {
  on('tool.check', (_$, e) => (e.tool === 'Read' ? { decision: 'allow' as const } : ask()))
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    throw new Error('must not ask')
  })
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -r build' } })).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: 'a' }, tool_use_id: 't2' } as never)).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'ExitPlanMode', input: {}, tool_use_id: 't3' } as never)).decision).toBe('ask')
})

test("auto mode's own asks stay with its classifier", async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' as const, reason: 'core' }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    throw new Error('must not ask')
  })
  on('classic.UserPromptSubmit', () => ({}))
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'auto' } as never)
  expect((await $.tool.check(call)).decision).toBe('ask')
})
