import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alerts, battery, forecast, glyph, sparkCells, sparkRange, TTL_MS } from './weather.mjs'

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
  assert.equal(copilotWeather(status({ total_input_tokens: 31841, total_cache_read_tokens: 15897, total_cache_write_tokens: 15938, last_call_input_tokens: 15941 })), '\ue30d ctx 9% · cache 50%')
  assert.equal(copilotWeather(status({ total_input_tokens: 100, total_cache_read_tokens: 0, total_cache_write_tokens: 90, last_call_input_tokens: 100 })), '\ue30d ctx 9% · cache 0%')
  assert.equal(copilotWeather(status({ total_input_tokens: 200, total_cache_read_tokens: 20, total_cache_write_tokens: 170, last_call_input_tokens: 100 })), '\ue30d ctx 9% · cache 10% · cache cold')
  assert.equal(copilotWeather(status({ total_input_tokens: 0 })), '\ue30d ctx 9%')
  assert.equal(copilotWeather({ cost: { total_premium_requests: 3 }, ...status({ total_input_tokens: 0 }) }), '\ue30d ctx 9% · 3 req')
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

test('battery: full when unused, empty when spent', () => {
  assert.deepEqual([0, 30, 50, 75, 100].map(battery), ['\uf240', '\uf241', '\uf242', '\uf243', '\uf244'])
})

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

test('Claude status line: two lines of the session facts', async () => {
  const { claudeStatusline } = await import('./statusline.mjs')
  const status = {
    workspace: { current_dir: '/Users/me/code/app' },
    model: { display_name: 'Sonnet 5.5' },
    session_name: 'work',
    context_window: { used_percentage: 41.7 },
    rate_limits: { five_hour: { used_percentage: 62.2, resets_at: 1000 + 2 * 3600 + 15 * 60 }, seven_day: { used_percentage: 5, resets_at: 1000 + 3 * 86400 + 4 * 3600 } },
    cost: { total_cost_usd: 1.8449 },
  }
  const facts = { user: 'me', host: 'mac', git: { branch: 'main', dirty: true }, gcp: 'proj', now: 1000, home: '/Users/me' }
  assert.equal(
    plain(claudeStatusline(status, facts)),
    '┌[me from mac] [\ue725 main *] [proj] (work)\n└[~/code/app] Sonnet 5.5 ctx:41% \uf242 5h:62%/2h15m \uf240 7d:5%/3d4h $1.84\n',
  )
  assert.equal(plain(claudeStatusline({}, { user: 'me', host: 'mac', now: 0 })), '┌[me from mac]\n└[~]\n')
})

test('gcpProject reads the active gcloud configuration', async () => {
  const { gcpProject } = await import('./statusline.mjs')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'gcloud-'))
  mkdirSync(join(dir, 'configurations'))
  writeFileSync(join(dir, 'active_config'), 'work\n')
  writeFileSync(join(dir, 'configurations', 'config_work'), '[compute]\nregion = x\n\n[core]\naccount = a@b.c\nproject = my-proj\n')
  assert.equal(gcpProject({ CLOUDSDK_CONFIG: dir }, '/h', 'linux'), 'my-proj')
  assert.equal(gcpProject({ CLOUDSDK_CONFIG: dir, CLOUDSDK_CORE_PROJECT: 'env-proj' }, '/h', 'linux'), 'env-proj')
  assert.equal(gcpProject({ CLOUDSDK_CONFIG: join(dir, 'none') }, '/h', 'linux'), undefined)
})

test('alerts: a level is announced once, loud on the first 90 and on the 5h window', () => {
  const a = alerts(82, 10)
  assert.deepEqual(a.toasts, ['Context 82%: compact soon'])
  assert.equal(a.isLoud, false)
  assert.deepEqual(alerts(84, 10, a.now).toasts, [])
  const b = alerts(93, 95, a.now)
  assert.deepEqual(b.toasts, ['Context 93%: compact now', '5h window 95% used'])
  assert.equal(b.isLoud, true)
  assert.deepEqual(alerts(20, 95, b.now), { toasts: [], now: { ctx: 0, five: true }, isLoud: false }) // compacted: re-arms
  assert.deepEqual(alerts(85, 0, { ctx: 0, five: true }).toasts, ['Context 85%: compact soon'])
})
