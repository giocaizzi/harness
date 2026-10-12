import { expect, mock, test } from 'claude-code/testing'

const usage = (percent: number) => ({
  value: {
    startedAt: 0,
    context: { tokens: 0, window: 1000000, percent: 12 },
    rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt: '2030-01-01T00:00:00Z' }],
  },
})

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// The engine's own band beneath the plugins: draws nothing of its own.
const bottom = (on) => on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))

const turn = (read: number, create: number, input: number) => ({
  answer: 'ok',
  durationMs: 1,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
  usage: { model: 'm', input_tokens: input, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: create },
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

test('the band draws its line on top of what plugins beneath draw', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => usage(10))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return Text({ children: ['next steps: run make check'] })
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'guard', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /ctx 12%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /next steps/ })).toBeDefined()
    await ui.unmount()
  }
})

test('turn one: cache line without "cache cold"; the TTL counts down, then expires', async ($, on) => {
  const clock = mock.clock(on)
  on('session.usage', () => usage(10))
  on('settings.read', () => ({ value: { promptCacheTtl: '5m' } }))
  bottom(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.start', () => ({ cwd: '/r' }))
  await $.session.start({ cwd: '/r' })
  await $.turn.complete(turn(0, 900, 100))
  const ui = await $.ui.mount({ plugin: 'guard', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /cache 0% · ttl 5:00$/ })).toBeDefined()
  await clock.advance(60_000)
  expect(await ui.find({ type: 'Text', text: /ttl 4:00/ })).toBeDefined()
  await clock.advance(240_000)
  expect(await ui.find({ type: 'Text', text: /cache expired/ })).toBeDefined()
  await ui.unmount()
})

test('/clear forgets the last turn', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => usage(10))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  bottom(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.turn.complete(turn(900, 0, 100))
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { sessionId: 's' } })
  const ui = await $.ui.mount({ plugin: 'guard', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /cache/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /ctx 12%/ })).toBeDefined()
  await ui.unmount()
})
