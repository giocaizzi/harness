#!/usr/bin/env node
// Weekly agent review without an agent: the agent-review skill's queries, run straight against Loki, printed as
// Markdown; with --evals <dir>, also writes skill-trigger eval stubs for `claude plugin eval`. Runbook:
// docs/agent-review.md.
//
// Loki access, read from the environment (never printed):
//   GRAFANA_URL + GRAFANA_TOKEN  query through Grafana's datasource proxy (LOKI_UID, default "loki")
//   LOKI_URL                     query Loki directly (plus LOKI_HEADERS, "Key=Value,Key2=Value2")
import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// The review's LogQL, shared with the repo's agent-review skill; `$r` is the review range (e.g. 7d).
import QUERIES from '../.agents/skills/agent-review/references/queries.json' with { type: 'json' }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export { QUERIES }

export function parsePairs(s = '') {
  return Object.fromEntries(s.split(',').map((p) => p.split('=')).filter(([k, v]) => k && v != null).map(([k, ...v]) => [k.trim(), v.join('=').trim()]))
}

export function endpoint(env) {
  if (env.GRAFANA_URL && env.GRAFANA_TOKEN) {
    return { base: `${env.GRAFANA_URL.replace(/\/$/, '')}/api/datasources/proxy/uid/${env.LOKI_UID || 'loki'}`, headers: { Authorization: `Bearer ${env.GRAFANA_TOKEN}` } }
  }
  if (env.LOKI_URL) return { base: env.LOKI_URL.replace(/\/$/, ''), headers: parsePairs(env.LOKI_HEADERS) }
  return null
}

async function query(ep, expr, fetchFn) {
  const res = await fetchFn(`${ep.base}/loki/api/v1/query?query=${encodeURIComponent(expr)}`, { headers: ep.headers })
  if (!res.ok) throw new Error(`Loki answered ${res.status} for ${expr.slice(0, 60)}...`)
  return (await res.json()).data.result.map((r) => ({ labels: r.metric, value: Number(r.value[1]) }))
}

export async function collect(ep, range, fetchFn = fetch) {
  const out = {}
  for (const [k, q] of Object.entries(QUERIES)) out[k] = await query(ep, q.replaceAll('$r', range), fetchFn)
  return out
}

// Skills shipped in this checkout, as `plugin:skill`.
export function knownSkills(root = ROOT) {
  const plugins = join(root, 'plugins')
  return readdirSync(plugins).flatMap((p) => {
    const dir = join(plugins, p, 'skills')
    return existsSync(dir) ? readdirSync(dir).map((s) => `${p}:${s}`) : []
  })
}

const sum = (rows) => rows.reduce((a, r) => a + r.value, 0)
const usd = (v) => `$${v.toFixed(2)}`
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n') : '_none_')
const top = (rows, n = 15) => [...rows].sort((a, b) => b.value - a.value).slice(0, n)

// model: the model picked the skill from its description (Claude Code's claude-proactive, the guard's via=tool);
// nested: another skill told it to; user: typed by the user.
const TRIGGER = { 'claude-proactive': 'model', 'nested-skill': 'nested' }
export function skillUse(data, known) {
  const use = Object.fromEntries(known.map((s) => [s, { user: 0, model: 0, nested: 0 }]))
  for (const r of data.skillsClaude) {
    const s = r.labels.skill_name
    if (!use[s]) continue
    use[s][TRIGGER[r.labels.invocation_trigger] || 'user'] += r.value
  }
  for (const r of data.skillsGuard) {
    const s = Object.keys(use).find((k) => k === r.labels.skill || k.endsWith(`:${r.labels.skill}`))
    if (s) use[s][r.labels.via === 'tool' ? 'model' : 'user'] += r.value
  }
  return use
}

// Routing shape: per-spawn rows joined on agent_id (subagent_completed names the type; tool_result and api_request
// carry the calling agent's id), reduced to aggregates. Ids never leave this function.
const isType = (name, t) => new RegExp(`(^|:)${t}$`).test(name ?? '') || (t === 'worker' && name === 'dev-tools-worker')
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0 }
export function routingShape(data) {
  const type = new Map(), model = new Map()
  for (const r of data.agentIds) if (!type.has(r.labels.agent_id)) { type.set(r.labels.agent_id, r.labels.agent_type); model.set(r.labels.agent_id, r.labels.model) }
  const ids = (t) => [...type.keys()].filter((id) => isType(type.get(id), t))
  const drivers = ids('driver'), workers = ids('worker'), reviewers = ids('reviewer')
  const nested = sum(data.agentSpawns.filter((r) => isType(r.labels.agent, 'worker') && isType(type.get(r.labels.agent_id), 'driver')))
  const edits = new Map(data.agentEdits.map((r) => [r.labels.agent_id, r.value]))
  const driverEdits = drivers.reduce((a, id) => a + (edits.get(id) ?? 0), 0)
  // The effort a spawn ran at: the one most of its spend went to.
  const effortOf = new Map(), spend = new Map()
  for (const r of data.agentCost) {
    const k = `${r.labels.agent_id}\u0000${r.labels.effort}`
    spend.set(k, (spend.get(k) ?? 0) + r.value)
    const cur = effortOf.get(r.labels.agent_id)
    if (!cur || spend.get(k) > spend.get(`${r.labels.agent_id}\u0000${cur}`)) effortOf.set(r.labels.agent_id, r.labels.effort)
  }
  const high = {}
  for (const [id, e] of effortOf) if (/high|max/.test(e ?? '')) { const t = type.get(id) ?? '(unknown)'; high[t] = (high[t] ?? 0) + 1 }
  const opusDriver = sum(data.agentCost.filter((r) => drivers.includes(r.labels.agent_id) && /opus/.test(r.labels.model)))
  const subagentSpend = sum(data.costBySource.filter((r) => /^agent/.test(r.labels.query_source)))
  const summary = sum(data.costBySource.filter((r) => r.labels.query_source === 'agent_summary'))
  const tracked = sum(data.agentCost.filter((r) => /^agent:/.test(r.labels.query_source)))
  const untracked = Math.max(0, sum(data.costBySource.filter((r) => /^agent:/.test(r.labels.query_source))) - tracked)
  return {
    drivers: drivers.length, workers: workers.length,
    workerPerDriver: drivers.length ? workers.length / drivers.length : 0,
    nestedShare: workers.length ? nested / workers.length : 0,
    driverEditShare: sum(data.agentEdits) ? driverEdits / sum(data.agentEdits) : 0,
    medianDriverEdits: median(drivers.map((id) => edits.get(id) ?? 0)),
    opusPerDriver: drivers.length ? opusDriver / drivers.length : 0,
    reviewers: reviewers.length,
    reviewerSonnetShare: reviewers.length ? reviewers.filter((id) => /sonnet/.test(model.get(id))).length / reviewers.length : 0,
    high, summaryShare: subagentSpend ? summary / subagentSpend : 0, untracked,
  }
}

// LSP share: LSP tool calls against grep searches (Grep tool plus Bash rg/grep), per agent type, joined on agent_id.
// An empty agent_id is the main session. Ids never leave this function.
export function lspShare(data) {
  const type = new Map()
  for (const r of data.agentIds) if (!type.has(r.labels.agent_id)) type.set(r.labels.agent_id, r.labels.agent_type)
  const typeOf = (id) => (id ? (type.has(id) ? type.get(id).replace(/^.*:/, '') : '(unknown)') : 'main')
  const by = {}
  const add = (id, k, v) => { const t = typeOf(id); by[t] ??= { lsp: 0, grep: 0 }; by[t][k] += v }
  for (const r of data.agentLsp) add(r.labels.agent_id, r.labels.tool_name === 'LSP' ? 'lsp' : 'grep', r.value)
  for (const r of data.agentGrep) add(r.labels.agent_id, 'grep', r.value)
  const types = Object.entries(by).map(([agent, c]) => ({ agent, ...c, share: c.lsp + c.grep ? c.lsp / (c.lsp + c.grep) : 0 }))
    .sort((a, b) => b.lsp + b.grep - (a.lsp + a.grep))
  const lsp = types.reduce((a, t) => a + t.lsp, 0), grep = types.reduce((a, t) => a + t.grep, 0)
  const ops = sum(data.lspOps)
  return { types, lsp, grep, share: lsp + grep ? lsp / (lsp + grep) : 0, ops, failureRate: ops ? sum(data.lspOps.filter((r) => r.labels.success === 'false')) / ops : 0 }
}

const pct = (v) => `${Math.round(v * 100)}%`

export function report(data, known, range) {
  const use = skillUse(data, known)
  const unused = Object.entries(use).filter(([, u]) => u.user + u.model + u.nested === 0).map(([s]) => s)
  const userOnly = Object.entries(use).filter(([, u]) => u.user + u.nested > 0 && u.model === 0).map(([s]) => s)
  const opusSub = data.costBySource.filter((r) => /^agent/.test(r.labels.query_source) && /opus|fable/.test(r.labels.model))
  const unnamed = data.subagentCost.filter((r) => !r.labels.agent_name)
  const shape = routingShape(data)
  const lspS = lspShare(data)
  return [
    `# Agent review (last ${range})`,
    '',
    `Total ${usd(sum(data.costByHarness))} at list price; ${sum(data.rateLimits)} rate-limit errors.`,
    '',
    '## Cost by harness and model',
    table(['harness', 'model', 'cost'], top(data.costByHarness).map((r) => [r.labels.service_name, r.labels.model, usd(r.value)])),
    '',
    '## Claude Code cost by source',
    'Background sources (hook_prompt, away_summary, prompt_suggestion) are spend no task asked for.',
    table(['source', 'model', 'cost'], top(data.costBySource).map((r) => [r.labels.query_source, r.labels.model, usd(r.value)])),
    '',
    '### hook_prompt by plugin',
    'A mod\'s session fork or prompt hook, on the session\'s model. No plugin: Claude Code before 2.1.310, which left it unlabelled.',
    table(['plugin', 'model', 'cost'], top(data.hookPromptCost).map((r) => [r.labels.plugin_name || '(unlabelled)', r.labels.model, usd(r.value)])),
    '',
    '## Subagent routing',
    `Subagent spend on Opus or Fable: ${usd(sum(opusSub))}. Lookups belong on Haiku, routine edits on Sonnet (subagent-orchestration).`,
    table(['agent', 'model', 'runs'], top(data.subagents).map((r) => [r.labels.agent_type, r.labels.model, r.value])),
    '',
    '### Routing shape',
    'Unique spawns joined on agent id (Claude Code). Targets: workers per driver >= 1.5, nested workers >= 50%, driver share of subagent edits <= 30%, median edits per driver <= 3, routine reviews on Sonnet >= 80%, agent_summary <= 10% of subagent spend.',
    table(['measure', 'value'], [
      ['drivers / workers (unique)', `${shape.drivers} / ${shape.workers}`],
      ['workers per driver', shape.workerPerDriver.toFixed(2)],
      ['workers spawned by a driver', pct(shape.nestedShare)],
      ['driver share of subagent Edit/Write', pct(shape.driverEditShare)],
      ['median edits per driver', shape.medianDriverEdits],
      ['Opus per driver (incl. agent_summary)', usd(shape.opusPerDriver)],
      ['reviewers on Sonnet', `${pct(shape.reviewerSonnetShare)} of ${shape.reviewers}`],
      ['agent_summary share of subagent spend', pct(shape.summaryShare)],
    ]),
    '',
    `Spawns at effort high or above, by agent (only the sensitive-review agents belong here): ${Object.entries(shape.high).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}.`,
    '',
    '### LSP share',
    'Target: LSP share >= 5% for main, driver, scout, worker and reviewer once at least 30 searches ran; LSP failures <= 10%.',
    table(['agent', 'LSP', 'grep searches', 'share'], [...lspS.types.map((t) => [t.agent, t.lsp, t.grep, pct(t.share)]), ['all', lspS.lsp, lspS.grep, pct(lspS.share)]]),
    '',
    `LSP operations: ${lspS.ops}; failure rate ${pct(lspS.failureRate)}.`,
    '',
    '### Subagent cost by agent',
    `Unattributed: ${usd(sum(unnamed))} without an agent name; ${usd(shape.untracked)} of it without an agent id either: agent-team teammates (a named spawn while agent teams are on), which telemetry cannot tie to an agent.`,
    table(['agent', 'model', 'cost'], top(data.subagentCost).map((r) => [r.labels.agent_name || '(named spawn)', r.labels.model, usd(r.value)])),
    '',
    '### Spawns with no model pinned',
    'Each ran on the session\'s model (subagent-orchestration: spawn a typed agent, such as dev-tools:worker for routine edits). web-fetch and claude-code-guide pick their own.',
    table(['agent', 'spawns'], top(data.unpinnedSpawns).map((r) => [r.labels.agent || 'general-purpose', r.value])),
    '',
    '### Model swaps',
    'A subagent that finished on another model than it started on (a fallback chain): record it as a routing deviation.',
    table(['agent', 'model', 'finished on', 'runs'], top(data.modelSwaps).map((r) => [r.labels.agent_type, r.labels.model, r.labels.final_model, r.value])),
    '',
    '## Skills',
    `Never loaded: ${unused.length ? unused.join(', ') : 'none'}.`,
    '',
    `Loaded, but never picked by the model from its description: ${userOnly.length ? userOnly.join(', ') : 'none'}. Their descriptions are the first suspects.`,
    '',
    table(['skill', 'by user', 'by another skill', 'by model'], Object.entries(use).filter(([, u]) => u.user + u.model + u.nested > 0).sort((a, b) => b[1].model - a[1].model).map(([s, u]) => [s, u.user, u.nested, u.model])),
    '',
    '## Guard reminders (a skill or a read tool was due and missing)',
    table(['rule', 'reminders'], top(data.reminders).map((r) => [r.labels.rule, r.value])),
    '',
    '## Guard decisions',
    'An ask the user always approves is a false positive; a deny burst is a misfiring rule.',
    table(['rule', 'action', 'via', 'count'], top(data.decisions).map((r) => [r.labels.rule, r.labels.action, r.labels.via ?? '', r.value])),
    '',
    '## Guard asks answered',
    'How each ask ended (Claude Code dialog, pi confirm): a high timeout share means asks land while the user is away; a high allow share on one rule is a false positive.',
    table(['harness', 'result', 'count'], top(data.askResults).map((r) => [r.labels.harness, r.labels.result, r.value])),
    '',
    '## Manual approvals by tool',
    table(['tool', 'approvals'], top(data.approvals).map((r) => [r.labels.tool_name, r.value])),
    '',
    '## Failing shell commands (first word)',
    table(['command', 'failures'], top(data.failing).map((r) => [`\`${r.labels.bash_command}\``, r.value])),
    '',
  ].join('\n')
}

// Eval stubs for skills the model should load on its own but does not. The prompt is a placeholder: write a
// realistic request (no private values) before running `claude plugin eval`.
export function evalStubs(data, known) {
  const use = skillUse(data, known)
  return Object.entries(use).filter(([, u]) => u.model === 0).map(([skill]) => ({
    dir: `${skill.split(':')[0]}/evals/${skill.split(':')[1]}-trigger`,
    files: {
      'prompt.md': `---\nmax_turns: 10\nallowed_tools: [Read, Glob, Grep, Skill]\ntags: [trigger]\n---\n\nTODO: a request that should make the model load ${skill} on its own, phrased as a user would, without naming it.\n`,
      'graders/skill-fired.md': `---\ntype: tool_used\ntool: Skill\ninput_match: '"skill"\\s*:\\s*"(?:[\\w-]+:)?${skill.split(':')[1]}"'\n---\n`,
    },
  }))
}

async function main(argv) {
  const range = argv.includes('--range') ? argv[argv.indexOf('--range') + 1] : '7d'
  const evals = argv.includes('--evals') ? argv[argv.indexOf('--evals') + 1] : null
  const ep = endpoint(process.env)
  if (!ep) {
    console.error('Set GRAFANA_URL and GRAFANA_TOKEN, or LOKI_URL (docs/agent-review.md).')
    process.exit(2)
  }
  const data = await collect(ep, range)
  const known = knownSkills()
  process.stdout.write(report(data, known, range))
  if (evals) {
    for (const s of evalStubs(data, known)) {
      for (const [f, body] of Object.entries(s.files)) {
        const path = join(evals, s.dir, f)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, body)
      }
    }
    console.error(`Eval stubs written under ${evals}`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
