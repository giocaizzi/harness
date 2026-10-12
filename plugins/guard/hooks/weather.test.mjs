import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forecast, TTL_MS } from './weather.mjs'

const usage = (read, create, input) => ({ cache_read_input_tokens: read, cache_creation_input_tokens: create, input_tokens: input })

test('warm cache and roomy context: plain line with the TTL countdown', () => {
  const f = forecast({ percent: 34.4, usage: usage(900, 50, 50), turns: 3, ttlMs: TTL_MS['5m'], sinceMs: 55_000 })
  assert.equal(f.text, 'ctx 34% · cache 90% · ttl 4:05')
  assert.deepEqual(f.hints, [])
})

test('full context and cold cache add hints after the first turn', () => {
  const f = forecast({ percent: 85, usage: usage(100, 800, 100), turns: 2 })
  assert.equal(f.text, 'ctx 85% · cache 10% · compact soon · cache cold')
})

test('turn one writes the cache: no false "cache cold"', () => {
  assert.deepEqual(forecast({ percent: 5, usage: usage(0, 900, 100), turns: 1 }).hints, [])
})

test('past the TTL the cache is expired', () => {
  const f = forecast({ usage: usage(900, 0, 100), turns: 4, ttlMs: TTL_MS['1h'], sinceMs: 3_600_000 })
  assert.equal(f.text, 'cache 90% · cache expired')
})

test('missing facts are left out', () => {
  assert.equal(forecast({ percent: undefined, usage: usage(1, 0, 0), turns: 2 }).text, 'cache 100%')
  assert.equal(forecast({ percent: 10, usage: undefined, ttlMs: TTL_MS['5m'], sinceMs: 0 }).text, 'ctx 10%')
  assert.equal(forecast({}).text, '')
})
