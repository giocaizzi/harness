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

const usageWith = (ctx: number, five: number) => ({
  value: { startedAt: 0, context: { tokens: 0, window: 1000000, percent: ctx }, rateLimits: [{ kind: 'five_hour', percentUsed: five, resetsAt: '2030-01-01T00:00:00Z' }] },
})

const turn = (read: number, create: number, input: number) => ({
  answer: 'ok',
  durationMs: 1,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
  usage: { model: 'm', input_tokens: input, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: create },
})

test('the band draws its line under what plugins beneath draw', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => usage(10))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return Text({ children: ['next steps: run make check'] })
  })
  on('turn.complete', () => ({ text: 'ok' }))
  await $.turn.complete(turn(900, 0, 100))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'hud', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /\uf472 90%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined() // the status line has it
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
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: '/r' })
  await $.turn.complete(turn(0, 900, 100))
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /\uf520 5:00/ })).toBeDefined()
  await clock.advance(60_000)
  expect(await ui.find({ type: 'Text', text: /\uf520 4:00/ })).toBeDefined()
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
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /cache/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /\ue30d/ })).toBeUndefined() // nothing left to show
  await ui.unmount()
})

test('/weather opens a pane listing the turns', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => usage(10))
  on('settings.read', () => ({ value: { promptCacheTtl: '5m' } }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined }))
  await $.session.start({ cwd: '/r' })
  await $.turn.complete(turn(900, 0, 100))
  await $.turn.complete(turn(100, 800, 100))
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'Pane', requestId: 'weather', props: {} })
  expect(await ui.find({ type: 'Text', text: /turn 2 .* 12% {2}\uf472 10%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /last turn: 100 in · 100 read · 800 written · 1 out/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Close/ })).toBeDefined()
  await ui.unmount()
})

test('the pane shows the 5h window from the turns', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => usageWith(10, 40))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.turn.complete(turn(900, 0, 100))
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'Pane', requestId: 'weather', props: {} })
  expect(await ui.find({ type: 'Text', text: /5h 40%/ })).toBeDefined()
  await ui.unmount()
})

test('the spinner names the running tool while it runs', async ($, on) => {
  on('ui.render', { component: 'Spinner' }, ($$, e) => $$.ui.resolve(e).Text({ children: [`${e.props.message ?? e.props.word}`] }))
  const SPINNER = { component: 'Spinner', props: { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' } } as const
  let during = false
  on('tool.call', async () => {
    const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...SPINNER })
    during = (await ui.find({ type: 'Text', text: /\uf489 Running/ })) !== undefined
    await ui.unmount()
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  await $.tool.call({ tool: 'Bash', input: { command: 'ls' } } as never)
  expect(during).toBe(true)
  const after = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...SPINNER })
  expect(await after.find({ type: 'Text', text: /Sauteing/ })).toBeDefined()
  await after.unmount()
})

test('the band shows the PR with its checks and the unpushed work, in brackets', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => usage(10))
  on('settings.read', () => ({ value: {} }))
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', (_$, e) => ({
    value: {
      exitCode: 0,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
      stdout: e.argv[0] === 'gh' ? JSON.stringify({ number: 56, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }) : e.argv[1] === 'rev-list' ? '0\t2' : e.argv[1] === 'diff' ? ' 3 files changed, 12 insertions(+), 4 deletions(-)' : '?? new.txt\n',
    },
  }))
  bottom(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/r' })
  await $.turn.complete(turn(900, 0, 100))
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /\uf407 #56 \u2713 1\/1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /~3 \+12 -4 \?1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\u21912/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\[$/ })).toBeDefined()
  await ui.unmount()
})
