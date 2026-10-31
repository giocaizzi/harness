import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emit, logRequest, otelOff, parsePairs, traceContext } from './otel.mjs'

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

test('logRequest: a harness reported by the guard owns service.name and service.namespace', () => {
  const r = logRequest({ endpoint: 'http://c', resource: 'service.namespace=claude-code,host.name=mac' }, 'api_request', {}, 1, 'pi')
  const attrs = Object.fromEntries(JSON.parse(r.body).resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue]))
  assert.deepEqual(attrs, { 'service.namespace': 'pi', 'host.name': 'mac', 'service.name': 'pi' })
})

test('emit: GUARD_OTEL=off sends nothing, even with an endpoint', async () => {
  const never = () => assert.fail('must not send')
  for (const off of ['off', 'OFF', '0', 'false']) await emit({ GUARD_OTEL: off, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://g' }, 'guard.decision', {}, never)
  assert.equal(otelOff({ GUARD_OTEL: 'on' }), false)
  assert.equal(otelOff({}), false)
})

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
const TRACE = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' }

test('traceContext: a well-formed GUARD_TRACEPARENT gives its trace and span ids', () => {
  assert.deepEqual(traceContext({ GUARD_TRACEPARENT: TP }), TRACE)
  assert.deepEqual(traceContext({ GUARD_TRACEPARENT: ` ${TP}\n` }), TRACE)
  assert.deepEqual(traceContext({ GUARD_TRACEPARENT: TP.replace(/01$/, '00') }), TRACE)
})

test('traceContext: absent, empty or malformed is no trace context', () => {
  const bad = [
    undefined,
    '',
    '   ',
    'garbage',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7', // flags missing
    '00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01', // trace id one short
    '00-4bf92f3577b34da6a3ce929d0e0e47360-00f067aa0ba902b7-01', // trace id one long
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01', // span id one short
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1', // flags one short
    '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01', // uppercase trace id
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00F067AA0BA902B7-01', // uppercase span id
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0A', // uppercase flags
    '00-00000000000000000000000000000000-00f067aa0ba902b7-01', // all-zero trace id
    '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01', // all-zero span id
    'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', // invalid version
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra', // version 00 takes no more fields
    '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01x', // a higher version: the 55 characters end in `-` or the value
    '0g-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', // version not hex
    '1-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', // version one short
    'FE-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', // uppercase version
    'fe-00000000000000000000000000000000-00f067aa0ba902b7-01', // all-zero trace id under a higher version
    '00_4bf92f3577b34da6a3ce929d0e0e4736_00f067aa0ba902b7_01', // wrong separator
    `${TP}-extra`,
  ]
  for (const v of bad) assert.equal(traceContext(v === undefined ? {} : { GUARD_TRACEPARENT: v }), null, String(v))
  assert.equal(traceContext(undefined), null)
})

test('traceContext: a higher version is read by its first 55 characters (W3C), ff never', () => {
  const ids = '4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  for (const v of [`01-${ids}`, `01-${ids}-future`, `fe-${ids}-a-b-c`, `cc-${ids}-`]) assert.deepEqual(traceContext({ GUARD_TRACEPARENT: v }), TRACE, v)
  for (const v of [`ff-${ids}`, `ff-${ids}-future`]) assert.equal(traceContext({ GUARD_TRACEPARENT: v }), null, v)
})

test('traceContext: only GUARD_TRACEPARENT, never TRACEPARENT or another source', () => {
  assert.equal(traceContext({ TRACEPARENT: TP, OTEL_TRACEPARENT: TP }), null)
})

test('logRequest: a trace context sets the record traceId and spanId, never as attributes; none leaves both out', () => {
  const rec = (trace) => JSON.parse(logRequest({ endpoint: 'http://c' }, 'guard.decision', { rule: 'r' }, 1, 'guard', trace).body).resourceLogs[0].scopeLogs[0].logRecords[0]
  const withTrace = rec(TRACE)
  assert.equal(withTrace.traceId, TRACE.traceId)
  assert.equal(withTrace.spanId, TRACE.spanId)
  assert.ok(!withTrace.attributes.some((a) => /trace|span/.test(a.key)))
  for (const none of [undefined, null]) {
    const r = rec(none)
    assert.ok(!('traceId' in r) && !('spanId' in r))
  }
})

test('emit: guard.decision carries a well-formed GUARD_TRACEPARENT, other events and malformed values do not', async () => {
  const sent = []
  const send = (env, event) => emit({ GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://g', ...env }, event, { rule: 'r' }, async (_, init) => sent.push(JSON.parse(init.body).resourceLogs[0].scopeLogs[0].logRecords[0]))
  await send({ GUARD_TRACEPARENT: TP }, 'guard.decision')
  await send({ GUARD_TRACEPARENT: TP.toUpperCase() }, 'guard.decision')
  await send({}, 'guard.decision')
  await send({ GUARD_TRACEPARENT: TP }, 'guard.stop')
  assert.equal(sent.length, 4)
  assert.deepEqual([sent[0].traceId, sent[0].spanId], [TRACE.traceId, TRACE.spanId])
  for (const r of sent.slice(1)) assert.ok(!('traceId' in r) && !('spanId' in r))
  // The raw value (version and flags) is never sent as such.
  assert.ok(!JSON.stringify(sent).includes(TP))
})
