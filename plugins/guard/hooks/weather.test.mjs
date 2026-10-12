import { test } from 'node:test'
import assert from 'node:assert/strict'
import { forecast, glyph, sparkCells, sparkRange, TTL_MS } from './weather.mjs'

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

test('Copilot status line: context % and the session cache hit rate from its cumulative totals', async () => {
  const { copilotWeather } = await import('./statusline.mjs')
  const status = (o) => ({ context_window: { current_context_used_percentage: 9, displayed_context_limit: 200000, ...o } })
  // Real 1.0.95 payload after two calls: input includes cache reads and writes.
  assert.equal(copilotWeather(status({ total_input_tokens: 31841, total_cache_read_tokens: 15897, total_cache_write_tokens: 15938, last_call_input_tokens: 15941 })), 'ctx 9% · cache 50%')
  assert.equal(copilotWeather(status({ total_input_tokens: 100, total_cache_read_tokens: 0, total_cache_write_tokens: 90, last_call_input_tokens: 100 })), 'ctx 9% · cache 0%')
  assert.equal(copilotWeather(status({ total_input_tokens: 200, total_cache_read_tokens: 20, total_cache_write_tokens: 170, last_call_input_tokens: 100 })), 'ctx 9% · cache 10% · cache cold')
  assert.equal(copilotWeather(status({ total_input_tokens: 0 })), 'ctx 9%')
  assert.equal(copilotWeather({}), '')
})

test('showCtx false leaves the context out; segments carry the tone', () => {
  const f = forecast({ percent: 85, usage: usage(100, 800, 100), turns: 2, showCtx: false })
  assert.equal(f.text, 'cache 10% · compact soon · cache cold')
  assert.deepEqual(f.segments.map((x) => x.tone), ['bad', 'warn', 'bad'])
})

test('glyph by context fullness', () => {
  assert.deepEqual([10, 30, 60, 80, 95].map(glyph), ['\ue30d', '\ue302', '\ue319', '\ue31d', '\ue315'])
  assert.equal(glyph(null), '')
})

test('sparkCells: one column per value, the bar filling the rows from the bottom', () => {
  const cells = sparkCells([100, 0], 2)
  assert.equal(cells.length, 2 * 2 * 3)
  assert.equal(cells[0], 0x2588) // top row, full value: full block
  assert.equal(cells[3], 32) // top row, empty value: space
  assert.equal(cells[6], 0x2588) // bottom row, full value
  assert.equal(sparkCells([50], 1)[0], 0x2584) // half of one row: ▄
})

test('sparkline range: the history\'s spread, at least 10 points; the lowest bar still shows', () => {
  assert.deepEqual(sparkRange([13, 20, 34]), [11, 34])
  assert.deepEqual(sparkRange([30, 31]), [28, 38])
  const [lo, hi] = sparkRange([13, 34])
  assert.equal(sparkCells([13, 34], 1, lo, hi)[0], 0x2581) // lowest: ▁, not a blank
  assert.equal(sparkCells([13, 34], 1, lo, hi)[3], 0x2588) // highest: █
})
