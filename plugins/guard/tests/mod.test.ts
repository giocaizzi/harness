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

// The test's tool.check hook stands for the engine: an ask from the guard's command hook. Scoped to Bash: since
// Claude Code 2.1.307 the kit checks the dialog's own AskUserQuestion call too, and an ask there refuses it.
const ask = () => ({ decision: 'ask' as const, reason: 'guard: recursive delete', hook: 'PreToolUse' })
const call = { tool: 'Bash', input: { command: 'rm -r build' }, tool_use_id: 't1' } as never

// The person picks `label` in the plugin's dialog.
function answer(on: Parameters<Parameters<typeof test>[1]>[1], label: string) {
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({ result: { questions: e.questions, answers: { [e.questions[0].question]: label } } }) as never)
}

test('an ask the person allows in the guard dialog runs', async ($, on) => {
  mock.clock(on)
  on('tool.check', { tool: 'Bash' }, ask)
  answer(on, 'Allow')
  expect((await $.tool.check(call)).decision).toBe('allow')
})

test('an ask the person denies is refused, and the agent is told not to retry', async ($, on) => {
  mock.clock(on)
  on('tool.check', { tool: 'Bash' }, ask)
  answer(on, 'Deny')
  const r = await $.tool.check(call)
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('The user denied')
  expect(r.reason).toContain('Do not retry')
})

test('an ask nobody answers is parked after the timeout, never called a user deny', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.check', { tool: 'Bash' }, ask)
  on('tool.call', { tool: 'AskUserQuestion' }, () => new Promise(() => {}))
  const pending = $.tool.check(call)
  await clock.advance(60_000)
  const r = await pending
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('No answer')
  expect(r.reason).toContain('not a refusal')
  expect(r.reason).not.toContain('denied')
})

test('an ask whose dialog cannot show (headless, dismissed) is parked, not called a user deny', async ($, on) => {
  on('tool.check', { tool: 'Bash' }, ask)
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    throw new Error('no dialog')
  })
  const r = await $.tool.check(call)
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('could not be shown')
  expect(r.reason).not.toContain('denied')
})

test('dontAsk mode leaves the ask to the engine', async ($, on) => {
  on('tool.check', { tool: 'Bash' }, ask)
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    throw new Error('must not ask')
  })
  on('classic.UserPromptSubmit', () => ({}))
  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'dontAsk' } as never)
  expect((await $.tool.check(call)).decision).toBe('ask')
})

// Records posted to the collector, by event name, with the attributes as a map.
function collector(on: Parameters<Parameters<typeof test>[1]>[1], env: Record<string, string>) {
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  const posted: Record<string, string>[] = []
  on('http.fetch', (_$, e) => {
    const rec = JSON.parse(String(e.init?.body)).resourceLogs[0].scopeLogs[0].logRecords[0]
    posted.push(Object.fromEntries(rec.attributes.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue])))
    return { value: { status: 200, ok: true, headers: {}, text: '' } }
  })
  return posted
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

test('every ask outcome is reported as guard.ask_result', async ($, on) => {
  const clock = mock.clock(on)
  const posted = collector(on, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' })
  on('tool.check', { tool: 'Bash' }, ask)
  answer(on, 'Allow')
  await $.tool.check(call)
  await clock.advance(1)
  await settle()
  expect(posted.map((p) => [p['event.name'], p.result, p.tool, p.harness])).toEqual([['guard.ask_result', 'allow', 'Bash', 'claude']])
  expect(posted[0]?.wait_ms).toBeDefined()
})

test('an ask_result carries the guard version, the repo as owner/name and the command class, never the command', async ($, on) => {
  const clock = mock.clock(on)
  const posted = collector(on, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' })
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('plugin.json') ? '{"version":"9.9.9"}' : '' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'https://token@example.com/acme/widgets.git\n', stderr: '' } }))
  on('tool.check', { tool: 'Bash' }, ask)
  answer(on, 'Allow')
  await $.tool.check(call)
  await clock.advance(1)
  await settle()
  expect(posted.map((p) => [p.guard_version, p.repo, p.cmd_class])).toEqual([['9.9.9', 'acme/widgets', 'files']])
  expect(JSON.stringify(posted)).not.toContain('rm -r')
  expect(JSON.stringify(posted)).not.toContain('token')
})

test('a throttle record carries the guard version, the repo from the first remote without origin, and cmd_class spawn', async ($, on) => {
  on('session.usage', () => usage(95))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  const posted = collector(on, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' })
  on('fs.read', () => ({ value: '{"version":"9.9.9"}' }))
  on('process.run', (_$, e) => {
    const a = e.argv.join(' ')
    if (a === 'git remote get-url origin') return { value: { exitCode: 2, stdout: '', stderr: '' } }
    if (a === 'git remote') return { value: { exitCode: 0, stdout: 'upstream\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: 'git@example.com:acme/tools.git\n', stderr: '' } }
  })
  await $.agent.spawn({ prompt: 'x' })
  await settle()
  expect(posted.map((p) => [p['event.name'], p.guard_version, p.repo, p.cmd_class])).toEqual([['guard.throttle', '9.9.9', 'acme/tools', 'spawn']])
})

test('a lookup that throws leaves the record without repo, and later records still go out', async ($, on) => {
  const clock = mock.clock(on)
  const posted = collector(on, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' })
  on('process.run', () => {
    throw new Error('no git')
  })
  on('tool.check', { tool: 'Bash' }, ask)
  answer(on, 'Allow')
  await $.tool.check(call)
  await $.tool.check(call)
  await clock.advance(1)
  await settle()
  expect(posted.map((p) => [p['event.name'], p.repo])).toEqual([['guard.ask_result', undefined], ['guard.ask_result', undefined]])
})

test('a timeout is reported as guard.ask_result timeout', async ($, on) => {
  const clock = mock.clock(on)
  const posted = collector(on, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' })
  on('tool.check', { tool: 'Bash' }, ask)
  on('tool.call', { tool: 'AskUserQuestion' }, () => new Promise(() => {}))
  const pending = $.tool.check(call)
  await clock.advance(60_000)
  await pending
  await settle()
  expect(posted.map((p) => p.result)).toEqual(['timeout'])
})

test('the mod falls back to the GUARD_-prefixed endpoint, and GUARD_OTEL=off sends nothing', async ($, on) => {
  on('session.usage', () => usage(95))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  const env: Record<string, string> = { GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://guard-collector' }
  const posted = collector(on, env)
  await $.agent.spawn({ prompt: 'x' })
  expect(posted.map((p) => p['event.name'])).toEqual(['guard.throttle'])
  env.GUARD_OTEL = 'off'
  await $.agent.spawn({ prompt: 'x' })
  expect(posted.length).toBe(1)
})

test('GUARD_ASK_TIMEOUT_MS sets the timeout', async ($, on) => {
  const clock = mock.clock(on)
  on('env.get', (_$, e) => ({ value: e.name === 'GUARD_ASK_TIMEOUT_MS' ? '5000' : undefined }))
  on('tool.check', { tool: 'Bash' }, ask)
  on('tool.call', { tool: 'AskUserQuestion' }, () => new Promise(() => {}))
  const pending = $.tool.check(call)
  await clock.advance(5000)
  const r = await pending
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('5 seconds')
})

test('GUARD_UNATTENDED parks an ask at once, without showing the dialog', async ($, on) => {
  const clock = mock.clock(on)
  const posted = collector(on, { GUARD_UNATTENDED: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector' })
  on('tool.check', { tool: 'Bash' }, ask)
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    throw new Error('must not ask')
  })
  const r = await $.tool.check(call)
  expect(r.decision).toBe('deny')
  expect(r.reason).toContain('unattended run')
  expect(r.reason).toContain('not a refusal')
  await clock.advance(1)
  await settle()
  expect(posted.map((p) => [p.result, p.via])).toEqual([['unavailable', 'unattended']])
})

test('GUARD_ASK_TIMEOUT_MS=0 leaves the ask to the engine', async ($, on) => {
  on('env.get', (_$, e) => ({ value: e.name === 'GUARD_ASK_TIMEOUT_MS' ? '0' : undefined }))
  on('tool.check', { tool: 'Bash' }, ask)
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    throw new Error('must not ask')
  })
  expect((await $.tool.check(call)).decision).toBe('ask')
})

test('an invalid GUARD_ASK_TIMEOUT_MS keeps the default', async ($, on) => {
  const clock = mock.clock(on)
  on('env.get', (_$, e) => ({ value: e.name === 'GUARD_ASK_TIMEOUT_MS' ? '1m' : undefined }))
  on('tool.check', { tool: 'Bash' }, ask)
  on('tool.call', { tool: 'AskUserQuestion' }, () => new Promise(() => {}))
  const pending = $.tool.check(call)
  await clock.advance(60_000)
  expect((await pending).reason).toContain('60 seconds')
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
