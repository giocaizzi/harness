import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alerts, clock, turnSound } from './alerts.mjs'

test('alerts: each level is announced once, per context and per limit, and re-arms after it is left', () => {
  const a = alerts(82, { five_hour: 10 })
  assert.deepEqual(a.alerts, [{ key: 'soundContext', text: 'Context 82%: compact soon' }])
  assert.deepEqual(alerts(84, { five_hour: 10 }, a.now).alerts, [])
  const b = alerts(93, { five_hour: 95, seven_day: 81, spend_limit: 100 }, a.now)
  assert.deepEqual(b.alerts, [
    { key: 'soundContext', text: 'Context 93%: compact now' },
    { key: 'soundLimit5h', text: '5h window 95% used' },
    { key: 'soundLimit7d', text: '7d window 81% used' },
    { key: 'soundLimitSpend', text: 'Spend limit reached' },
  ])
  assert.deepEqual(alerts(20, { five_hour: 95 }, b.now).alerts, []) // compacted: nothing new, context re-armed
  assert.deepEqual(alerts(85, {}, alerts(20, {}, b.now).now).alerts, [{ key: 'soundContext', text: 'Context 85%: compact soon' }])
})

test('turnSound: one setting per way a turn can end', () => {
  assert.equal(turnSound({ reason: 'answer', durationMs: 5000 }, 0), 'soundDone')
  assert.equal(turnSound({ reason: 'answer', durationMs: 5000 }, 30), null)
  assert.equal(turnSound({ reason: 'answer', durationMs: 31_000 }, 30), 'soundDone')
  assert.equal(turnSound({ reason: 'aborted', durationMs: 1 }), 'soundAborted')
  assert.equal(turnSound({ reason: 'refusal', durationMs: 1 }), 'soundRefused')
  assert.equal(turnSound({ reason: 'error', durationMs: 1 }), 'soundError')
  assert.equal(turnSound({ reason: 'answer', durationMs: 1, agentId: 'a1' }), 'soundSubagent')
})

test('clock: minutes and seconds', () => {
  assert.equal(clock(65_000), '1:05')
})
