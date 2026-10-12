// Status lines for both CLIs (`statusLine.command`), one script: `node statusline.mjs claude` for Claude Code's two-line
// prompt (user, git, GCP, path, model, context, rate-limit windows, cost), no argument for Copilot CLI's token-weather
// line. Each CLI pipes its session status as JSON on stdin. Copilot's token totals are cumulative and include cache
// reads and writes, so its hit rate is the session's, not the last turn's. No TTL: Copilot has none.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { battery, forecast, glyph } from './weather.mjs'

export function copilotWeather(status) {
  const c = status?.context_window ?? {}
  const read = c.total_cache_read_tokens ?? 0
  const write = c.total_cache_write_tokens ?? 0
  const usage = c.total_input_tokens ? { cache_read_input_tokens: read, cache_creation_input_tokens: write, input_tokens: Math.max(0, c.total_input_tokens - read - write) } : undefined
  // More input than the last call means more than one call, so a low hit rate is worth a hint.
  const turns = c.total_input_tokens > (c.last_call_input_tokens ?? 0) ? 2 : 1
  const f = forecast({ percent: c.current_context_used_percentage ?? c.used_percentage ?? undefined, usage, turns })
  // Copilot bills premium requests, not dollars.
  const req = status?.cost?.total_premium_requests
  const text = req > 0 ? `${f.text} · ${req} req` : f.text
  return glyph(f.ctx) ? `${glyph(f.ctx)} ${text}` : text
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
  const line1 = [paint(C.blue, '┌') + `[${paint(C.white, facts.user)} from ${paint(C.white, facts.host)}]`]
  if (facts.git?.branch) line1.push(paint(C.red, `[ ${facts.git.branch}${facts.git.dirty ? ' *' : ''}]`))
  if (facts.gcp) line1.push(paint(C.yellow, `[${facts.gcp}]`))
  if (status.session_name) line1.push(paint(C.blue, `(${status.session_name})`))

  const line2 = [paint(C.blue, '└') + paint(C.pink, `[${path}]`)]
  if (status.model?.display_name) line2.push(paint(C.white, status.model.display_name))
  const ctx = status.context_window?.used_percentage
  // The weather glyph is the context's: sunny while roomy, a storm near full.
  if (ctx != null) line2.push(paint(tone(ctx), `${glyph(ctx) ? `${glyph(ctx)} ` : ''}ctx:${Math.trunc(ctx)}%`))
  for (const [label, w] of [['5h', status.rate_limits?.five_hour], ['7d', status.rate_limits?.seven_day]]) {
    if (w?.used_percentage == null) continue
    const pct = Math.trunc(w.used_percentage)
    const reset = w.resets_at ? paint(C.grey, `/${remaining(w.resets_at, facts.now)}`) : ''
    line2.push(paint(tone(pct), `${battery(pct)} ${label}:${pct}%`) + reset)
  }
  const usd = status.cost?.total_cost_usd
  if (usd != null) line2.push(paint(C.grey, `$${usd.toFixed(2)}`))
  return `${line1.join(' ')}\n${line2.join(' ')}\n`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const status = JSON.parse(readFileSync(0, 'utf8') || '{}')
    if (process.argv[2] === 'claude') {
      const cwd = status.workspace?.current_dir ?? status.cwd
      const home = homedir()
      process.stdout.write(
        claudeStatusline(status, { user: userInfo().username, host: hostname().split('.')[0], git: cwd ? gitState(cwd) : undefined, gcp: gcpProject(), now: Math.floor(Date.now() / 1000), home }),
      )
    } else {
      process.stdout.write(copilotWeather(status))
    }
  } catch {
    // unreadable status: print nothing
  }
}
