import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as mod from './opencode.mjs'

const client = (toasts) => ({
  config: { providers: async () => ({ data: { providers: [{ id: 'p', models: { m: { id: 'm', limit: { context: 1000 } } } }] } }) },
  tui: { showToast: async ({ body }) => toasts.push(body.message) },
})
const assistant = (sessionID, total) => ({
  type: 'message.updated',
  properties: { info: { role: 'assistant', sessionID, providerID: 'p', modelID: 'm', tokens: { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } },
})

test('the module exports only the plugin: opencode calls every exported function', () => {
  assert.deepEqual(Object.keys(mod), ['SoundsPlugin'])
})

test('idle plays done and toasts the context alert; an error plays error; a subagent ticks', async () => {
  const played = []
  const toasts = []
  let t = 0
  const hooks = await mod.SoundsPlugin({ client: client(toasts) }, { play: (c) => played.push(c), now: () => t })
  await hooks['chat.message']({ sessionID: 's' })
  await hooks.event({ event: assistant('s', 910) })
  t = 5000
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } })
  assert.deepEqual(played, ['done', 'alert'])
  assert.deepEqual(toasts, ['Context 91%: compact now'])

  played.length = 0
  await hooks['chat.message']({ sessionID: 's' })
  await hooks.event({ event: { type: 'session.error', properties: { sessionID: 's', error: { name: 'APIError' } } } })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } })
  assert.deepEqual(played, ['error'])

  played.length = 0
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'c', parentID: 's' } } } })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'c' } } })
  assert.deepEqual(played, ['tick'])
})
