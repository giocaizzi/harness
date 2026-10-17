import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endpoint, parsePairs, collect, knownSkills, skillUse, report, evalStubs, QUERIES } from '../scripts/agent-review.mjs'

const empty = () => Object.fromEntries(Object.keys(QUERIES).map((k) => [k, []]))
const row = (labels, value) => ({ labels, value })

test('endpoint prefers the Grafana proxy, falls back to Loki, else null', () => {
  assert.deepEqual(endpoint({ GRAFANA_URL: 'https://g/', GRAFANA_TOKEN: 't' }), { base: 'https://g/api/datasources/proxy/uid/loki', headers: { Authorization: 'Bearer t' } })
  assert.deepEqual(endpoint({ LOKI_URL: 'http://l:3100', LOKI_HEADERS: 'X-Scope-OrgID=a,Authorization=Basic x=' }), { base: 'http://l:3100', headers: { 'X-Scope-OrgID': 'a', Authorization: 'Basic x=' } })
  assert.equal(endpoint({}), null)
  assert.deepEqual(parsePairs(''), {})
})

test('collect substitutes the range and reads vector results', async () => {
  const seen = []
  const fetchFn = async (url) => {
    seen.push(decodeURIComponent(url))
    return { ok: true, json: async () => ({ data: { result: [{ metric: { rule: 'rm' }, value: [0, '3'] }] } }) }
  }
  const data = await collect({ base: 'http://l', headers: {} }, '7d', fetchFn)
  assert.equal(seen.length, Object.keys(QUERIES).length)
  assert.ok(seen.every((u) => !u.includes('$r') && u.includes('[7d]')))
  assert.deepEqual(data.reminders, [{ labels: { rule: 'rm' }, value: 3 }])
})

test('collect fails on a Loki error', async () => {
  await assert.rejects(collect({ base: 'http://l', headers: {} }, '7d', async () => ({ ok: false, status: 401 })), /401/)
})

test('knownSkills reads this checkout', () => {
  const skills = knownSkills()
  assert.ok(skills.includes('dev-tools:subagent-orchestration'))
  assert.ok(skills.every((s) => /^[a-z-]+:[a-z0-9-]+$/.test(s)))
})

test('skillUse splits user and model loads across Claude Code and the guard', () => {
  const data = empty()
  data.skillsClaude = [row({ skill_name: 'dev-tools:ship', invocation_trigger: 'user-slash' }, 4), row({ skill_name: 'dev-tools:ship', invocation_trigger: 'claude-proactive' }, 1), row({ skill_name: 'dev-tools:ship', invocation_trigger: 'nested-skill' }, 3)]
  data.skillsGuard = [row({ skill: 'land', via: 'tool' }, 2), row({ skill: 'unknown', via: 'tool' }, 9)]
  const use = skillUse(data, ['dev-tools:ship', 'dev-tools:land', 'dev-tools:wt'])
  assert.deepEqual(use, { 'dev-tools:ship': { user: 4, model: 1, nested: 3 }, 'dev-tools:land': { user: 0, model: 2, nested: 0 }, 'dev-tools:wt': { user: 0, model: 0, nested: 0 } })
})

test('report lists unused and user-only skills and subagent spend on Opus', () => {
  const data = empty()
  data.costByHarness = [row({ service_name: 'claude-code', model: 'claude-opus-5-5' }, 10), row({ service_name: 'codex', model: 'gpt-6.1-sol' }, 2.5)]
  data.costBySource = [row({ query_source: 'agent:builtin:general-purpose', model: 'claude-opus-5-5' }, 4)]
  data.skillsClaude = [row({ skill_name: 'dev-tools:ship', invocation_trigger: 'user-slash' }, 1)]
  const md = report(data, ['dev-tools:ship', 'dev-tools:wt'], '7d')
  assert.match(md, /Total \$12\.50/)
  assert.match(md, /Never loaded: dev-tools:wt\./)
  assert.match(md, /from its description: dev-tools:ship\./)
  assert.match(md, /Opus or Fable: \$4\.00/)
})

test('evalStubs targets skills the model never loads itself', () => {
  const data = empty()
  data.skillsClaude = [row({ skill_name: 'dev-tools:ship', invocation_trigger: 'claude-proactive' }, 1)]
  const stubs = evalStubs(data, ['dev-tools:ship', 'dev-tools:pr-fix'])
  assert.deepEqual(stubs.map((s) => s.dir), ['dev-tools/evals/pr-fix-trigger'])
  assert.match(stubs[0].files['graders/skill-fired.md'], /input_match: '"skill"\\s\*:\\s\*"\(\?:\[\\w-\]\+:\)\?pr-fix"'/)
})
