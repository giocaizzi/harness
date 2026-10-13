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
  mock.clock(on)
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
      stdout: e.argv[1] === 'remote' ? 'git@github.com:o/r.git\n' : e.argv[0] === 'gh' ? JSON.stringify({ number: 56, url: 'https://github.com/o/r/pull/56', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }) : e.argv[1] === 'rev-list' ? '0\t2' : e.argv[1] === 'diff' ? ' 3 files changed, 12 insertions(+), 4 deletions(-)' : '?? new.txt\n',
    },
  }))
  bottom(on)
  on('turn.complete', () => ({ text: 'ok' }))
  await $.session.start({ cwd: '/r' })
  await $.turn.complete(turn(900, 0, 100))
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Link' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\u2713 1\/1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /~3 \+12 -4 \?1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\u21912/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\[$/ })).toBeDefined()
  await ui.unmount()
})

test('the turn footer adds tokens, cache hit rate and cost after the engine line', async ($, on) => {
  mock.clock(on)
  let usd = 1
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 1000000, percent: 12 }, rateLimits: [], cost: { usd } } }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.render', { component: 'TurnDuration' }, ($$, e) => $$.ui.resolve(e).Text({ children: [`${e.props.word} for 3s`] }))
  await $.turn.complete({ ...turn(900, 0, 100), durationMs: 1000 })
  usd = 1.25
  await $.turn.complete({ ...turn(9000, 1000, 0), durationMs: 3000 })
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 3000 } })
  expect(await ui.find({ type: 'Text', text: /Baked for 3s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↑10\.0k ↓1 ↺90% \$0\.25/ })).toBeDefined()
  await ui.unmount()
})

test('a tool row gets a status icon, the edit size and the call time', async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', async () => {
    await clock.advance(1500)
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  on('ui.render', { component: 'ToolUse' }, ($$, e) => $$.ui.resolve(e).Text({ children: [`row ${e.props.tool}`] }))
  await $.tool.call({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' } as never)
  const props = { tool_use_id: 'tu1', tool: 'Edit', input: { old_string: 'a\nb', new_string: 'a\nb\nc' }, isRunning: false, isErrored: false, isInterrupted: false }
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'ToolUse', requestId: 'tu1', props })
  expect(await ui.find({ type: 'Text', text: /row Edit/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+3 -2 · 1\.5s/ })).toBeDefined()
  await ui.unmount()
})

test('/subagents lists each spawned subagent and how it ended', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('turn.complete', () => ({ text: 'ok' }))
  await $.agent.spawn({ prompt: 'x', description: 'find the bug', subagentType: 'scout' } as never)
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'Pane', requestId: 'subagents', props: {} })
  expect(await ui.find({ type: 'Text', text: /\u2026/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /find the bug · haiku/ })).toBeDefined()
  await ui.unmount()
  await $.turn.complete({ ...turn(10, 0, 10), agentId: 'a1' })
  const done = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'Pane', requestId: 'subagents', props: {} })
  expect(await done.find({ type: 'Text', text: /\u2713/ })).toBeDefined()
  await done.unmount()
})

test('a merged PR says merged instead of its checks', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => usage(10))
  on('settings.read', () => ({ value: {} }))
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', (_$, e) => ({
    value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: e.argv[1] === 'remote' ? 'git@github.com:o/r.git\n' : e.argv[0] === 'gh' ? JSON.stringify({ number: 62, url: 'https://x/62', state: 'MERGED', statusCheckRollup: [{ status: 'IN_PROGRESS' }] }) : '' },
  }))
  bottom(on)
  await $.session.start({ cwd: '/r' })
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /merged/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\uf252/ })).toBeUndefined()
  await ui.unmount()
})

test('/ctx draws the breakdown grid and one row per category', async ($, on) => {
  const square = (categoryName: string, isFilled: boolean) => ({ color: 'x', isFilled, categoryName, tokens: 1, percentage: 1, squareFullness: 1 })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        tokens: 30000,
        window: 200000,
        percent: 15,
        breakdown: {
          categories: [
            { name: 'System prompt', tokens: 20000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'Messages', tokens: 10000, color: 'x', isDeferred: false, kind: 'used' },
            { name: 'Free space', tokens: 170000, color: 'x', isDeferred: false, kind: 'free' },
          ],
          totalTokens: 30000,
          maxTokens: 200000,
          percentage: 15,
          gridRows: [[square('System prompt', true), square('Messages', true), square('Free space', false)]],
          model: 'opus',
        },
      },
    },
  }))
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'Pane', requestId: 'ctx', props: { bodyColumns: 80 } as never })
  expect(await ui.find({ type: 'Text', text: /opus · 30\.0k of 200\.0k \(15%\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /System prompt/ })).toBeDefined()
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  await ui.unmount()
})

// A reply's work-item references become links to the origin's forge, with the kind's glyph unless NO_COLOR is set.
const REPLY = { component: 'AssistantMessage', props: { text: 'Fixed in #12, see `#13`.', isFirstOfReply: true } } as const
const remote = (on) => {
  on('settings.read', () => ({ value: {} }))
  on('session.start', () => ({ cwd: '/r' }))
  on('command.register', () => ({ value: undefined }))
  // A fork: origin is mine, upstream the parent the references link to.
  const out = { 'git remote': 'origin\nupstream\n', 'git remote get-url origin': 'git@github.com:me/r.git\n', 'git remote get-url upstream': 'git@github.com:o/r.git\n' }
  on('process.run', (_$, e) => {
    const stdout = out[e.argv.join(' ')]
    return { value: { exitCode: stdout ? 0 : 1, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: stdout ?? '' } }
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => $.ui.resolve(e).Markdown({ text: e.props.text }))
}

// Under NO_COLOR the rewrite is plain markdown handed to the engine; in colour the reply is a tree of our own, its
// line with the reference a Text row holding a Link.
test("a reply's #N links to the issue as plain markdown under NO_COLOR", async ($, on) => {
  mock.clock(on)
  mock.env(on, { NO_COLOR: '1' })
  remote(on)
  await $.session.start({ cwd: '/r' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'hud', surface, ...REPLY })
    expect(await ui.find({ type: 'Markdown', text: 'Fixed in [#12](https://github.com/o/r/issues/12), see `#13`.' })).toBeDefined()
    await ui.unmount()
  }
})

test("a reply's #N is a coloured link with its glyph, and a secret is masked", async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  remote(on)
  await $.session.start({ cwd: '/r' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'hud', surface, component: 'AssistantMessage', props: { text: 'Fixed in #12, key ghp_abcdefghijklmnopqrstuvwx1234.', isFirstOfReply: true } })
    const link = await ui.find({ type: 'Link' })
    expect(link?.props.href).toBe('https://github.com/o/r/issues/12')
    expect(await ui.find({ type: 'Text', text: '\uf41b #12' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '••••••••' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ghp_abcdef/ })).toBeUndefined()
    await ui.unmount()
  }
})

const OFF = Object.fromEntries(['replyRefs', 'replyState', 'replySecrets', 'replyUrls', 'replyPaths', 'replyFileLinks', 'replyCommits', 'replyTimes', 'replyStatus'].map((k) => [k, 'off']))
test('with every reply feature off the reply is left to the engine', { options: OFF }, async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  remote(on)
  await $.session.start({ cwd: '/r' })
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...REPLY })
  expect(await ui.find({ type: 'Markdown', text: 'Fixed in #12, see `#13`.' })).toBeDefined()
  await ui.unmount()
})
