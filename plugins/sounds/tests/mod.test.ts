import { expect, mock, test } from 'claude-code/testing'

const usage = (percent: number) => ({
  value: {
    startedAt: 0,
    context: { tokens: 0, window: 1000000, percent: 12 },
    rateLimits: [{ kind: 'five_hour', percentUsed: percent, resetsAt: '2030-01-01T00:00:00Z' }],
  },
})

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

test('a turn ending at 90% context toasts once and plays the alert', { options: { soundDone: 'off' } }, async ($, on) => {
  mock.clock(on)
  on('session.usage', () => usageWith(91, 20))
  on('turn.complete', () => ({ text: 'ok' }))
  const toasts: string[] = []
  const clips: string[] = []
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }) as never)
  on('audio.play', (_$, e) => (clips.push(e.clip.asset ?? ''), { value: undefined }) as never)
  await $.turn.complete(turn(900, 0, 100))
  await $.turn.complete(turn(900, 0, 100))
  expect(toasts).toEqual(['Context 91%: compact now'])
  expect(clips).toEqual(['sounds/alert.wav'])
})

const sounds = (on) => {
  const clips: string[] = []
  on('audio.play', (_$, e) => (clips.push(e.clip.asset ?? ''), { value: undefined }) as never)
  return clips
}

test('each way a turn ends plays its own sound', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => usage(10))
  on('turn.complete', () => ({ text: 'ok' }))
  const clips = sounds(on)
  const base = { answer: '', durationMs: 5, turnId: 't' }
  await $.turn.complete({ ...base, reason: 'answer', isAborted: false })
  await $.turn.complete({ ...base, reason: 'aborted', isAborted: true })
  await $.turn.complete({ ...base, reason: 'error', isAborted: false })
  await $.turn.complete({ ...base, reason: 'answer', isAborted: false, agentId: 'a1' })
  expect(clips).toEqual(['sounds/done.wav', 'sounds/chime.wav', 'sounds/error.wav', 'sounds/tick.wav'])
})

test('a sound set to off plays nothing; a long-turn threshold skips short turns', { options: { soundDone: 'done', soundAborted: 'off', doneAfterSeconds: 30 } }, async ($, on) => {
  mock.clock(on)
  on('session.usage', () => usage(10))
  on('turn.complete', () => ({ text: 'ok' }))
  const clips = sounds(on)
  const base = { answer: '', turnId: 't', isAborted: false }
  await $.turn.complete({ ...base, reason: 'answer', durationMs: 5000 })
  await $.turn.complete({ ...base, reason: 'aborted', durationMs: 5000, isAborted: true })
  await $.turn.complete({ ...base, reason: 'answer', durationMs: 31_000 })
  expect(clips).toEqual(['sounds/done.wav'])
})
