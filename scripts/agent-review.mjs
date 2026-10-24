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

export function report(data, known, range) {
  const use = skillUse(data, known)
  const unused = Object.entries(use).filter(([, u]) => u.user + u.model + u.nested === 0).map(([s]) => s)
  const userOnly = Object.entries(use).filter(([, u]) => u.user + u.nested > 0 && u.model === 0).map(([s]) => s)
  const opusSub = data.costBySource.filter((r) => /^agent/.test(r.labels.query_source) && /opus|fable/.test(r.labels.model))
  const unnamed = data.subagentCost.filter((r) => !r.labels.agent_name)
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
    '## Subagent routing',
    `Subagent spend on Opus or Fable: ${usd(sum(opusSub))}. Lookups belong on Haiku, routine edits on Sonnet (subagent-orchestration).`,
    table(['agent', 'model', 'runs'], top(data.subagents).map((r) => [r.labels.agent_type, r.labels.model, r.value])),
    '',
    '### Subagent cost by agent',
    `Unattributed: ${usd(sum(unnamed))}, spent by spawns given a \`name\` (Claude Code drops their agent name from api_request).`,
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
