import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endpoint, parsePairs, collect, knownSkills, skillUse, report, evalStubs, routingShape, lspShare, QUERIES } from '../scripts/agent-review.mjs'

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
  data.askResults = [row({ harness: 'claude', result: 'timeout' }, 7)]
  data.decisions = [row({ rule: 'rm', action: 'deny', via: 'unattended' }, 2)]
  const asks = report(data, ['dev-tools:ship'], '7d')
  assert.match(asks, /\| claude \| timeout \| 7 \|/)
  assert.match(asks, /\| rm \| deny \| unattended \| 2 \|/)
})

test('report attributes subagent cost and lists unpinned spawns and model swaps', () => {
  const data = empty()
  data.subagentCost = [row({ agent_name: 'factory:verifier', model: 'claude-opus-5-5' }, 3), row({ model: 'claude-opus-5-5' }, 9)]
  data.unpinnedSpawns = [row({}, 4), row({ agent: 'dev-tools:scout' }, 1)]
  data.modelSwaps = [row({ agent_type: 'factory:verifier', model: 'claude-opus-5-5', final_model: 'claude-opus-4-8' }, 1)]
  const md = report(data, [], '7d')
  assert.match(md, /Unattributed: \$9\.00/)
  assert.match(md, /\| \(named spawn\) \| claude-opus-5-5 \| \$9\.00 \|/)
  assert.match(md, /\| general-purpose \| 4 \|/)
  assert.match(md, /\| factory:verifier \| claude-opus-5-5 \| claude-opus-4-8 \| 1 \|/)
})

test('report breaks hook_prompt down by plugin', () => {
  const data = empty()
  data.hookPromptCost = [row({ plugin_name: 'next-steps', model: 'claude-opus-5-5' }, 2), row({ model: 'claude-opus-5-5' }, 5)]
  const md = report(data, [], '7d')
  assert.match(md, /\| \(unlabelled\) \| claude-opus-5-5 \| \$5\.00 \|/)
  assert.match(md, /\| next-steps \| claude-opus-5-5 \| \$2\.00 \|/)
})

test('evalStubs targets skills the model never loads itself', () => {
  const data = empty()
  data.skillsClaude = [row({ skill_name: 'dev-tools:ship', invocation_trigger: 'claude-proactive' }, 1)]
  const stubs = evalStubs(data, ['dev-tools:ship', 'dev-tools:pr-fix'])
  assert.deepEqual(stubs.map((s) => s.dir), ['dev-tools/evals/pr-fix-trigger'])
  assert.match(stubs[0].files['graders/skill-fired.md'], /input_match: '"skill"\\s\*:\\s\*"\(\?:\[\\w-\]\+:\)\?pr-fix"'/)
})

test('routingShape joins spawns on agent id and reports aggregates only', () => {
  const data = empty()
  data.agentIds = [
    row({ agent_id: 'd1', agent_type: 'dev-tools:driver', model: 'claude-opus-5-5' }, 2), // resumed: counted once
    row({ agent_id: 'd2', agent_type: 'dev-tools:driver', model: 'claude-opus-5-5' }, 1),
    row({ agent_id: 'w1', agent_type: 'dev-tools:worker', model: 'claude-sonnet-5-5' }, 1),
    row({ agent_id: 'w2', agent_type: 'dev-tools:worker', model: 'claude-sonnet-5-5' }, 1),
    row({ agent_id: 'w3', agent_type: 'dev-tools:worker', model: 'claude-sonnet-5-5' }, 1),
    row({ agent_id: 'r1', agent_type: 'dev-tools:reviewer', model: 'claude-sonnet-5-5' }, 1),
    row({ agent_id: 'r2', agent_type: 'dev-tools:reviewer', model: 'claude-opus-5-5' }, 1),
  ]
  data.agentSpawns = [row({ agent_id: 'd1', agent: 'dev-tools:worker' }, 2), row({ agent_id: 'w1', agent: 'dev-tools:scout' }, 1)]
  data.agentEdits = [row({ agent_id: 'd1' }, 1), row({ agent_id: 'w1' }, 4), row({ agent_id: 'w2' }, 5)]
  data.agentCost = [
    row({ agent_id: 'd1', query_source: 'agent:custom', model: 'claude-opus-5-5', effort: 'medium' }, 6),
    row({ agent_id: 'd1', query_source: 'agent_summary', model: 'claude-opus-5-5', effort: 'medium' }, 2),
    row({ agent_id: 'r2', query_source: 'agent:custom', model: 'claude-opus-5-5', effort: 'high' }, 1),
  ]
  data.costBySource = [row({ query_source: 'agent:custom', model: 'claude-opus-5-5' }, 17), row({ query_source: 'agent_summary', model: 'claude-opus-5-5' }, 2), row({ query_source: 'repl_main_thread', model: 'claude-opus-5-5' }, 50)]
  const s = routingShape(data)
  assert.equal(s.drivers, 2)
  assert.equal(s.workerPerDriver, 1.5)
  assert.equal(s.nestedShare, 2 / 3)
  assert.equal(s.driverEditShare, 0.1)
  assert.equal(s.medianDriverEdits, 0.5)
  assert.equal(s.opusPerDriver, 4)
  assert.equal(s.reviewerSonnetShare, 0.5)
  assert.deepEqual(s.high, { 'dev-tools:reviewer': 1 })
  assert.equal(s.summaryShare, 2 / 19)
  assert.equal(s.untracked, 10)
  const md = report(data, [], '7d')
  assert.match(md, /\| workers per driver \| 1\.50 \|/)
  assert.match(md, /\| workers spawned by a driver \| 67% \|/)
  assert.match(md, /effort high or above, by agent .*: dev-tools:reviewer 1\./)
  assert.match(md, /\$10\.00 of it without an agent id either: agent-team teammates/)
  assert.ok(!/\b[dwr][12]\b/.test(md), 'no agent ids in the report')
})

test('lspShare joins on agent id, counts Bash greps and reports aggregates only', () => {
  const data = empty()
  data.agentIds = [row({ agent_id: 'd1', agent_type: 'dev-tools:driver', model: 'claude-opus-5-5' }, 1)]
  data.agentLsp = [
    row({ agent_id: '', tool_name: 'LSP' }, 2), row({ agent_id: '', tool_name: 'Grep' }, 8),
    row({ agent_id: 'd1', tool_name: 'LSP' }, 1), row({ agent_id: 'x9', tool_name: 'Grep' }, 3),
  ]
  data.agentGrep = [row({ agent_id: '' }, 10), row({ agent_id: 'd1' }, 3)]
  data.lspOps = [row({ op: 'goToDefinition', success: 'true' }, 3), row({ op: 'hover', success: 'false' }, 1)]
  const s = lspShare(data)
  const t = Object.fromEntries(s.types.map((x) => [x.agent, x]))
  assert.deepEqual([t.main.lsp, t.main.grep, t.main.share], [2, 18, 0.1])
  assert.deepEqual([t.driver.lsp, t.driver.grep, t.driver.share], [1, 3, 0.25])
  assert.equal(t['(unknown)'].grep, 3)
  assert.equal(s.types[0].agent, 'main')
  assert.equal(s.failureRate, 0.25)
  const md = report(data, [], '7d')
  assert.match(md, /### LSP share/)
  assert.match(md, /\| main \| 2 \| 18 \| 10% \|/)
  assert.match(md, /LSP operations: 4; failure rate 25%\./)
  assert.ok(!/\b(d1|x9)\b/.test(md), 'no agent ids in the report')
})
