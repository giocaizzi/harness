import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emit, logRequest, parsePairs } from './otel.mjs'

test('parsePairs: comma pairs, percent-decoded, bad pairs skipped', () => {
  assert.deepEqual(parsePairs('Authorization=Bearer%20abc,x=1,junk,=no'), { Authorization: 'Bearer abc', x: '1' })
  assert.deepEqual(parsePairs(undefined), {})
})

test('logRequest: OTLP JSON record with the resource attributes and the event', () => {
  const r = logRequest({ endpoint: 'https://otel.example/', headers: 'Authorization=Bearer%20t', resource: 'service.namespace=claude-code,host.name=mac' }, 'guard.decision', { rule: 'pip-deny', action: 'deny', skipped: undefined }, 1000)
  assert.equal(r.url, 'https://otel.example/v1/logs')
  assert.equal(r.headers.Authorization, 'Bearer t')
  const rec = JSON.parse(r.body).resourceLogs[0]
  const keys = (list) => Object.fromEntries(list.map((a) => [a.key, a.value.stringValue]))
  assert.deepEqual(keys(rec.resource.attributes), { 'service.name': 'guard', 'service.namespace': 'claude-code', 'host.name': 'mac' })
  const log = rec.scopeLogs[0].logRecords[0]
  assert.equal(log.timeUnixNano, '1000000000')
  assert.deepEqual(keys(log.attributes), { 'event.name': 'guard.decision', rule: 'pip-deny', action: 'deny' })
})

test('emit: no request without an endpoint; failures are swallowed', async () => {
  const never = () => assert.fail('must not send')
  await emit({}, 'guard.decision', {}, never)
  let sent
  await emit({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' }, 'guard.decision', { rule: 'r' }, async (url, init) => (sent = { url, init }))
  assert.equal(sent.url, 'http://c/v1/logs')
  assert.equal(sent.init.method, 'POST')
  await emit({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' }, 'guard.decision', {}, async () => {
    throw new Error('down')
  })
})

test('emit: GUARD_-prefixed copies stand in for the OTEL_* the harness stripped', async () => {
  let sent
  await emit({ GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://g', GUARD_OTEL_EXPORTER_OTLP_HEADERS: 'k=v' }, 'guard.decision', {}, async (url, init) => (sent = { url, init }))
  assert.equal(sent.url, 'http://g/v1/logs')
  assert.equal(sent.init.headers.k, 'v')
  await emit({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://o', GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://g' }, 'guard.decision', {}, async (url) => (sent = { url }))
  assert.equal(sent.url, 'http://o/v1/logs')
})
