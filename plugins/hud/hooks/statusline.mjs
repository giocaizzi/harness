// Status lines for both CLIs (`statusLine.command`), one script: `node statusline.mjs claude` for Claude Code's two-line
// prompt (user, git, GCP, path, model, context, rate-limit windows, cost), `node statusline.mjs subagent` for Claude
// Code's agent-panel rows (`subagentStatusLine.command`), no argument for Copilot CLI's token-weather line and its running subagents. Each CLI pipes its session status as JSON on stdin. Copilot's token totals are cumulative and include cache
// reads and writes, so its hit rate is the session's, not the last turn's. No TTL: Copilot has none.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ICON, battery, forecast, glyph, tokens } from './weather.mjs'

export function copilotWeather(status) {
  const c = status?.context_window ?? {}
  const read = c.total_cache_read_tokens ?? 0
  const write = c.total_cache_write_tokens ?? 0
  const usage = c.total_input_tokens ? { cache_read_input_tokens: read, cache_creation_input_tokens: write, input_tokens: Math.max(0, c.total_input_tokens - read - write) } : undefined
  // More input than the last call means more than one call, so a low hit rate is worth a hint.
  const turns = c.total_input_tokens > (c.last_call_input_tokens ?? 0) ? 2 : 1
  const f = forecast({ percent: c.current_context_used_percentage ?? c.used_percentage ?? undefined, usage, turns })
  // Every part `[icon value]`, as Claude's status line and band draw theirs. Copilot bills premium requests, not dollars.
  const req = status?.cost?.total_premium_requests
  return [
    f.ctx == null ? null : `[${glyph(f.ctx)} ${f.ctx}%]`,
    ...f.segments.filter((x) => x.kind !== 'ctx').map((x) => `[${ICON[x.kind]} ${x.value}]`),
    req > 0 ? `[${ICON.cost} ${req} req]` : null,
  ]
    .filter(Boolean)
    .join(' ')
}

// Catppuccin Mocha, as 24-bit ANSI.
const rgb = (hex) => `\x1b[38;2;${(hex >> 16) & 255};${(hex >> 8) & 255};${hex & 255}m`
const C = { blue: rgb(0x89b4fa), pink: rgb(0xcba6f7), white: rgb(0xcdd6f4), red: rgb(0xf38ba8), yellow: rgb(0xf9e2af), grey: rgb(0x6c7086) }
const RESET = '\x1b[0m'
const paint = (color, text) => `${color}${text}${RESET}`
const tone = (pct) => (pct >= 80 ? C.red : pct >= 50 ? C.yellow : C.blue)

// "2h15m", "3d4h", "12m" until an epoch-seconds reset.
export function remaining(resetsAt, now) {
  const s = resetsAt - now
  if (s <= 0) return 'now'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}d${h}h` : h ? `${h}h${m}m` : `${m}m`
}

// The active gcloud project, read from its config files (no `gcloud` process, which takes a second).
export function gcpProject(env = process.env, home = homedir(), platform = process.platform) {
  if (env.CLOUDSDK_CORE_PROJECT) return env.CLOUDSDK_CORE_PROJECT
  const dir = env.CLOUDSDK_CONFIG || (platform === 'win32' ? join(env.APPDATA ?? '', 'gcloud') : join(home, '.config', 'gcloud'))
  try {
    const name = env.CLOUDSDK_ACTIVE_CONFIG_NAME || readFileSync(join(dir, 'active_config'), 'utf8').trim() || 'default'
    return /^\[core\][^[]*?^project\s*=\s*(\S+)/ms.exec(readFileSync(join(dir, 'configurations', `config_${name}`), 'utf8'))?.[1]
  } catch {
    return undefined // no gcloud config
  }
}

// Branch and whether tracked files changed (untracked files do not count), from one `git status`.
export function gitState(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain=v2', '--branch', '-uno'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] })
    const lines = out.split('\n').filter(Boolean)
    const head = lines.find((l) => l.startsWith('# branch.head '))?.slice(14)
    const oid = lines.find((l) => l.startsWith('# branch.oid '))?.slice(13, 20)
    return { branch: head === '(detached)' ? oid : head, dirty: lines.some((l) => !l.startsWith('#')) }
  } catch {
    return undefined // not a repository, or git is missing
  }
}

// facts: what the status JSON does not carry (user, host, git, gcp, now in epoch seconds, home).
export function claudeStatusline(status, facts) {
  const cwd = status.workspace?.current_dir ?? status.cwd
  const path = cwd ? (facts.home && cwd.startsWith(facts.home) ? `~${cwd.slice(facts.home.length)}` : cwd) : '~'
  // Every part `[icon value]`: brackets dim, the value coloured by what it says.
  const part = (icon, value, color) => `${paint(C.grey, '[')}${paint(color, `${icon} ${value}`)}${paint(C.grey, ']')}`
  const line1 = [part(ICON.user, `${facts.user}@${facts.host}`, C.white)]
  if (facts.git?.branch) line1.push(part(ICON.branch, `${facts.git.branch}${facts.git.dirty ? ' *' : ''}`, C.red))
  if (facts.gcp) line1.push(part(ICON.cloud, facts.gcp, C.yellow))
  if (status.session_name) line1.push(part(ICON.session, status.session_name, C.blue))

  const line2 = [part(ICON.path, path, C.pink)]
  if (status.model?.display_name) line2.push(part(ICON.model, status.model.display_name, C.white))
  const ctx = status.context_window?.used_percentage
  // The weather glyph is the context's: sunny while roomy, a storm near full.
  if (ctx != null) line2.push(part(glyph(ctx), `${Math.trunc(ctx)}%`, tone(ctx)))
  for (const [label, w] of [['5h', status.rate_limits?.five_hour], ['7d', status.rate_limits?.seven_day]]) {
    if (w?.used_percentage == null) continue
    const pct = Math.trunc(w.used_percentage)
    line2.push(part(battery(pct), `${label} ${pct}%${w.resets_at ? ` ${remaining(w.resets_at, facts.now)}` : ''}`, tone(pct)))
  }
  const usd = status.cost?.total_cost_usd
  if (usd != null) line2.push(part(ICON.cost, usd.toFixed(2), C.grey))
  return `${paint(C.blue, '┌')}${line1.join(' ')}\n${paint(C.blue, '└')}${line2.join(' ')}\n`
}

// "Opus 5.5" from "claude-opus-5-5" (a date suffix dropped); any other id as it is.
export function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}

// "34s", "3m 49s", "1h 12m", as the default agent-panel row counts.
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

// The agent panel's rows (`subagentStatusLine`): the default `name  label  time · ↓ tokens` with the subagent's model
// and effort put before the time, dim. One JSON line per row; the time only while the task runs (no end time is given).
// A task carries the effort set for it, or none; `effort` fills in the one it runs at: `forced` from
// CLAUDE_CODE_EFFORT_LEVEL, which beats any, else `session`, the session's own, which an unset subagent inherits.
export function subagentRows(input, now, effort = {}) {
  const tasks = input?.tasks ?? []
  const width = Math.max(0, ...tasks.map((t) => (t.name ?? t.agentType ?? '').length))
  return tasks
    .map((t) => {
      const name = (t.name ?? t.agentType ?? '').padEnd(width + 2)
      const right = [
        t.model ? modelName(t.model) : null,
        effort.forced ?? (typeof t.effort === 'number' ? tokens(t.effort) : t.effort) ?? effort.session,
        t.status === 'running' && t.startTime ? elapsed(now - t.startTime) : null,
        `↓ ${tokens(t.tokenCount ?? 0)} tokens`,
      ]
        .filter(Boolean)
        .join(' · ')
      let label = t.label ?? t.description ?? ''
      const room = input.columns ? input.columns - name.length - right.length - 2 : Infinity
      if (label.length > room) label = room > 1 ? `${label.slice(0, room - 1)}…` : ''
      const gap = input.columns ? Math.max(2, input.columns - name.length - label.length - right.length) : 2
      return JSON.stringify({ id: t.id, content: `${name}${label}${' '.repeat(gap)}${paint(C.grey, right)}` })
    })
    .map((line) => `${line}\n`)
    .join('')
}

// Copilot's running subagents as `[icon name · model · effort · time]` parts. Its status JSON has none, so they come from
// the session's events (`events.jsonl` in `transcript_path`): a `subagent.started` (name, the model it starts on, when
// known) until its `subagent.completed` or `.failed`. The effort is the one set for the agent in `subagents.agents`
// (`/subagents`, user settings); "inherit" or none is the session's, from its last `session.start`, `.resume` or
// `.model_change`. A resume ends every subagent, since none is resumable.
export function copilotAgents(events, settings, now) {
  const running = new Map()
  let session
  for (const line of events.split('\n')) {
    if (!line.includes('"type":"subagent.') && !line.includes('"type":"session.')) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue // a line still being written
    }
    if (['session.start', 'session.resume', 'session.model_change'].includes(e.type)) session = e.data?.reasoningEffort ?? session
    if (e.type === 'session.resume') running.clear()
    if (e.type === 'subagent.started') running.set(e.data?.toolCallId, e)
    if (e.type === 'subagent.completed' || e.type === 'subagent.failed') running.delete(e.data?.toolCallId)
  }
  return [...running.values()].map(({ data, timestamp }) => {
    const set = settings?.subagents?.agents?.[data.agentName]?.effortLevel
    const at = Date.parse(timestamp)
    const parts = [data.agentDisplayName ?? data.agentName, data.model ? modelName(data.model) : null, set && set !== 'inherit' ? set : session, Number.isNaN(at) ? null : elapsed(now - at)]
    return `[${ICON.agents} ${parts.filter(Boolean).join(' · ')}]`
  })
}

// The session's effort, as the main status line last saw it, for the agent-panel rows (their input has none).
const effortFile = (session) => join(tmpdir(), `hud-effort-${String(session).replace(/[^\w-]/g, '')}`)

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const status = JSON.parse(readFileSync(0, 'utf8') || '{}')
    if (process.argv[2] === 'claude') {
      const cwd = status.workspace?.current_dir ?? status.cwd
      const home = homedir()
      if (status.session_id && status.effort?.level) writeFileSync(effortFile(status.session_id), status.effort.level)
      process.stdout.write(
        claudeStatusline(status, { user: userInfo().username, host: hostname().split('.')[0], git: cwd ? gitState(cwd) : undefined, gcp: gcpProject(), now: Math.floor(Date.now() / 1000), home }),
      )
    } else if (process.argv[2] === 'subagent') {
      let session
      try {
        session = status.session_id ? readFileSync(effortFile(status.session_id), 'utf8') : undefined
      } catch {
        // no main status line drawn yet in this session
      }
      process.stdout.write(subagentRows(status, Date.now(), { forced: process.env.CLAUDE_CODE_EFFORT_LEVEL || undefined, session: status.effort?.level ?? session }))
    } else {
      // transcript_path is the session's state directory, under the config directory that holds settings.json.
      const read = (...p) => {
        try {
          return readFileSync(join(status.transcript_path, ...p), 'utf8')
        } catch {
          return '' // no events yet, no settings
        }
      }
      let settings
      try {
        settings = JSON.parse(read('..', '..', 'settings.json'))
      } catch {
        // none, or not JSON
      }
      const agents = status.transcript_path ? copilotAgents(read('events.jsonl'), settings, Date.now()) : []
      process.stdout.write([copilotWeather(status), ...agents].filter(Boolean).join(' '))
    }
  } catch {
    // unreadable status: print nothing
  }
}
