import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settle } from './alerts.mjs'
import soundsExtension from './pi.mjs'

test('settle: a finished run plays done; a long one also notifies; an abort plays nothing', () => {
  assert.deepEqual(settle({ durationMs: 1000, pct: 10, before: {} }).clips, ['done'])
  assert.deepEqual(settle({ durationMs: 1000, pct: 10, before: {} }).notices, [])
  assert.match(settle({ durationMs: 90_000, pct: 10, before: {} }).notices[0], /Turn finished in 1m 30s/)
  assert.deepEqual(settle({ durationMs: 1000, aborted: true, pct: 10, before: {} }).clips, [])
  assert.deepEqual(settle({ durationMs: 1000, error: true, pct: 10, before: {} }).clips, ['error'])
  const sub = settle({ durationMs: 90_000, agentId: 'a', pct: 10, before: {} })
  assert.deepEqual([sub.clips, sub.notices], [['tick'], []])
})

test('settle: the context crossing 80% alerts once until it drops', () => {
  const first = settle({ durationMs: 1000, pct: 85, before: {} })
  assert.deepEqual(first.clips, ['done', 'alert'])
  assert.match(first.notices[0], /Context 85%/)
  assert.deepEqual(settle({ durationMs: 1000, pct: 86, before: first.now }).clips, ['done'])
})

test('the extension plays and notifies on agent_settled', () => {
  const handlers = {}
  const played = []
  const shown = []
  soundsExtension({ on: (e, f) => (handlers[e] = f) }, { play: (c) => played.push(c) })
  handlers.agent_start()
  handlers.agent_settled({ aborted: false }, { hasUI: true, getContextUsage: () => ({ percent: 91 }), ui: { notify: (t) => shown.push(t) } })
  assert.deepEqual(played, ['done', 'alert'])
  assert.match(shown[0], /Context 91%: compact now/)
})
