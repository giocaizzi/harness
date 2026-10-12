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
