import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityLabel, azurePr, battery, forgeOf, githubPr, gitlabMr, duration, editStat, footerText, fullAt, repoState, tokens, when, forecast, glyph, sparkCells, sparkRange, TTL_MS } from './weather.mjs'

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

test('Copilot status line: bracketed parts from its cumulative totals and premium requests', async () => {
  const { copilotWeather } = await import('./statusline.mjs')
  const status = (o) => ({ context_window: { current_context_used_percentage: 9, displayed_context_limit: 200000, ...o } })
  // Real 1.0.95 payload after two calls: input includes cache reads and writes.
  assert.equal(copilotWeather(status({ total_input_tokens: 31841, total_cache_read_tokens: 15897, total_cache_write_tokens: 15938, last_call_input_tokens: 15941 })), '[ 9%] [ 50%]')
  assert.equal(copilotWeather(status({ total_input_tokens: 200, total_cache_read_tokens: 20, total_cache_write_tokens: 170, last_call_input_tokens: 100 })), '[ 9%] [ 10%] [ cache cold]')
  assert.equal(copilotWeather({ cost: { total_premium_requests: 3 }, ...status({ total_input_tokens: 0 }) }), '[ 9%] [ 3 req]')
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


test('Claude status line: two lines of `[icon value]` parts', async () => {
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
    '┌[ me@mac] [ main *] [ proj] [ work]\n└[ ~/code/app] [ Sonnet 5.5] [ 41%] [ 5h 62% 2h15m] [ 7d 5% 3d4h] [ 1.84]\n',
  )
  assert.equal(plain(claudeStatusline({}, { user: 'me', host: 'mac', now: 0 })), '┌[ me@mac]\n└[ ~]\n')
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

test('spinner activity: an icon and a verb per tool, nothing for the rest', () => {
  assert.equal(activityLabel('Bash'), '\uf489 Running')
  assert.equal(activityLabel('Grep'), '\uf422 Searching')
  assert.equal(activityLabel('mcp__x__y'), '\uf1e6 Calling')
  assert.equal(activityLabel('TodoWrite'), null)
  assert.equal(activityLabel(null), null)
})

test('forges: the remote names one, and each CLI\'s answer reads as the same PR', () => {
  assert.equal(forgeOf('git@github.com:o/r.git'), 'github')
  assert.equal(forgeOf('https://dev.azure.com/org/proj/_git/r'), 'azure')
  assert.equal(forgeOf('https://org.visualstudio.com/proj/_git/r'), 'azure')
  assert.equal(forgeOf('git@gitlab.example.com:g/r.git'), 'gitlab')
  assert.equal(forgeOf('https://example.com/r.git'), null)
  const run = (conclusion, status = 'COMPLETED') => ({ conclusion, status })
  assert.deepEqual(githubPr({ number: 7, url: 'u', state: 'OPEN', statusCheckRollup: [run('SUCCESS'), run(null, 'IN_PROGRESS'), run('FAILURE'), { state: 'PENDING' }] }), { number: 7, url: 'u', state: 'open', checks: ['pass', 'pending', 'fail', 'pending'] })
  assert.deepEqual(gitlabMr({ iid: 4, web_url: 'w', state: 'merged', head_pipeline: { status: 'running' } }), { number: 4, url: 'w', state: 'merged', checks: ['pending'] })
  assert.deepEqual(gitlabMr({ iid: 4, web_url: 'w', state: 'opened', head_pipeline: null }).checks, [])
  assert.deepEqual(azurePr([{ pullRequestId: 9, status: 'active', repository: { webUrl: 'https://dev.azure.com/o/p/_git/r' } }], [{ status: 'approved' }, { status: 'rejected' }, { status: 'running' }]), {
    number: 9,
    url: 'https://dev.azure.com/o/p/_git/r/pullrequest/9',
    state: 'open',
    checks: ['pass', 'fail', 'pending'],
  })
  assert.equal(azurePr([], []), null)
  assert.equal(githubPr(null), null)
})

test('repoState: the PR and its checks, unpushed work and uncommitted changes', () => {
  const pr = (checks, state = 'open') => ({ number: 7, url: null, state, checks })
  assert.deepEqual(repoState(pr(['pass', 'pass']), '0\t2'), {
    pr: { number: 7, url: null, state: 'open', ci: 'pass', passed: 2, total: 2 },
    ahead: 2,
    behind: 0,
    changes: { files: 0, added: 0, removed: 0, untracked: 0 },
  })
  assert.equal(repoState(pr(['pass', 'fail']), null).pr.ci, 'fail')
  assert.equal(repoState(pr(['pending', 'pass']), null).pr.ci, 'pending')
  assert.equal(repoState(pr([]), null).pr.ci, null)
  assert.equal(repoState(pr([], 'merged'), null).pr.state, 'merged')
  assert.equal(repoState(null, '3\t0').behind, 3)
  assert.deepEqual(repoState(null, null, ' 3 files changed, 120 insertions(+), 30 deletions(-)\n', '?? a\n?? b\n M c\n').changes, { files: 3, added: 120, removed: 30, untracked: 2 })
  assert.deepEqual(repoState(null, null, ' 1 file changed, 1 insertion(+)\n', '').changes, { files: 1, added: 1, removed: 0, untracked: 0 })
})

test('footer text, durations and token counts', () => {
  assert.equal(footerText({ usage: { input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 900, output_tokens: 1200 }, cost: 0.041 }), '10.0k in · 1.2k out · 90% cached · $0.04')
  assert.equal(footerText({ usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 }, cost: null }), '0 in · 5 out')
  assert.deepEqual([850, 4200, 64_000].map(duration), ['850ms', '4.2s', '1m 4s'])
  assert.deepEqual([950, 12_300, 1_200_000].map(tokens), ['950', '12.3k', '1.2M'])
})

test('editStat: lines an edit adds and removes', () => {
  assert.equal(editStat('Edit', { old_string: 'a\nb', new_string: 'a\nb\nc' }), '+3 -2')
  assert.equal(editStat('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: 'd', new_string: '' }] }), '+2 -2')
  assert.equal(editStat('Write', { content: 'x\ny' }), '+2')
  assert.equal(editStat('Bash', { command: 'ls' }), null)
})

test('fullAt: the pace of the samples since the last reset, only when it beats the reset', () => {
  const h = 3_600_000
  // 10% an hour from 50% at t=0 to 60% at 1h: full at 5h.
  assert.equal(fullAt([{ at: 0, pct: 50 }, { at: h, pct: 60 }], 10 * h), 5 * h)
  assert.equal(fullAt([{ at: 0, pct: 50 }, { at: h, pct: 60 }], 2 * h), null) // resets first
  assert.equal(fullAt([{ at: 0, pct: 90 }, { at: h, pct: 5 }, { at: 2 * h, pct: 15 }], 100 * h), 2 * h + 8.5 * h) // after a reset
  assert.equal(fullAt([{ at: 0, pct: 50 }, { at: h, pct: 50 }], null), null) // no pace
  assert.equal(fullAt([{ at: 0, pct: 50 }], null), null)
})

test('when: the time today, the weekday and time later', () => {
  const now = new Date(2026, 9, 13, 10, 0).getTime()
  assert.equal(when(new Date(2026, 9, 13, 16, 40).getTime(), now), '16:40')
  assert.equal(when(new Date(2026, 9, 15, 9, 5).getTime(), now), 'Thu 09:05')
})
