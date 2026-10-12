// Token weather facts, free of engine imports so node can test them. Pure: facts in, one display line out.
// percent: context fullness; usage: the last main-loop turn's token counts; turns: main-loop turns since the
// session (or /clear) began; ttlMs / sinceMs: the prompt-cache TTL and the time since that turn ended.
export const TTL_MS = { '5m': 300_000, '1h': 3_600_000 }

export const clock = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

const BLOCKS = '▁▂▃▄▅▆▇█'

// Nerd Font icons (BMP private use, so a Raster could take them too), checked present in JetBrainsMono Nerd Font,
// which chezmoi installs and sets in Ghostty, VS Code and Windows Terminal. Each is drawn followed by a space:
// Ghostty then draws the icon at full size instead of squeezing it into one cell.
// One icon per part, the same in the status line and the band: every part is drawn `[icon value]`.
export const ICON = {
  user: '\uf007', // nf-fa-user
  branch: '\ue725', // nf-dev-git_branch
  cloud: '\uf0c2', // nf-fa-cloud (the GCP project)
  session: '\uf02b', // nf-fa-tag
  path: '\uf07c', // nf-fa-folder_open
  model: '\uf2db', // nf-fa-microchip
  cost: '\uf155', // nf-fa-usd
  pr: '\uf407', // nf-oct-git_pull_request
  merged: '\uf419', // nf-oct-git_merge
  pending: '\uf252', // nf-fa-hourglass_half
  sync: '\uf47f', // nf-oct-git_compare (ahead and behind)
  changes: '\uf448', // nf-oct-pencil
  agents: '\uf0c0', // nf-fa-users
  forecast: '\uf244', // nf-fa-battery_empty
  cache: '\uf472', // nf-oct-database
  ttl: '\uf520', // nf-oct-stopwatch
  trend: '\uf201', // nf-fa-line_chart
  hint: '\uf071', // nf-fa-warning
}

// A weather icon for how full the context is: sunny, cloudy, showers, thunderstorm, lightning (nf-weather-*).
export const glyph = (ctx) => (ctx == null ? '' : ctx < 25 ? '\ue30d' : ctx < 50 ? '\ue302' : ctx < 75 ? '\ue319' : ctx < 90 ? '\ue31d' : '\ue315')

// A battery for how much of a rate-limit window is left (nf-fa-battery_0..4, full to empty as `used` rises).
export const battery = (used) => String.fromCharCode(0xf244 - Math.min(4, Math.max(0, Math.round((100 - used) / 25))))

// The spinner's word while a tool runs: a Nerd Font icon and a verb, null for a tool with no personality.
export const ACTIVITY = {
  Bash: ['\uf489', 'Running'],
  Read: ['\uf4a5', 'Reading'],
  Grep: ['\uf422', 'Searching'],
  Glob: ['\uf422', 'Searching'],
  Edit: ['\uf448', 'Editing'],
  Write: ['\uf448', 'Editing'],
  NotebookEdit: ['\uf448', 'Editing'],
  WebFetch: ['\uf0ac', 'Browsing'],
  WebSearch: ['\uf0ac', 'Browsing'],
  Agent: ['\uf0c0', 'Delegating'],
}
export function activityLabel(tool) {
  const a = ACTIVITY[tool] ?? (String(tool).startsWith('mcp__') ? ['\uf1e6', 'Calling'] : null)
  return a ? `${a[0]} ${a[1]}` : null
}

// The forge a remote URL belongs to: github, gitlab, azure, or null for any other.
export function forgeOf(url) {
  if (!url) return null
  if (/github\.com[:/]/.test(url)) return 'github'
  if (/dev\.azure\.com|visualstudio\.com/.test(url)) return 'azure'
  if (/gitlab/.test(url)) return 'gitlab'
  return null
}

// A pull request as every forge's reader returns it: number, url, state (open | merged | closed) and one entry per
// check (pass | fail | pending).
// GitHub: `gh pr view --json number,url,state,statusCheckRollup`.
export function githubPr(j) {
  if (!j) return null
  const check = (c) =>
    ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].includes(c.conclusion ?? c.state)
      ? 'fail'
      : (c.status ? c.status !== 'COMPLETED' : c.state === 'PENDING')
        ? 'pending'
        : 'pass'
  return { number: j.number, url: j.url ?? null, state: (j.state ?? 'OPEN').toLowerCase(), checks: (j.statusCheckRollup ?? []).map(check) }
}

// GitLab: `glab mr view --output json` (the API's merge request): its head pipeline is its one check.
export function gitlabMr(j) {
  if (!j) return null
  const p = (j.head_pipeline ?? j.pipeline)?.status
  const check = !p ? [] : p === 'success' || p === 'skipped' ? ['pass'] : ['failed', 'canceled'].includes(p) ? ['fail'] : ['pending']
  return { number: j.iid, url: j.web_url ?? null, state: j.state === 'opened' ? 'open' : j.state === 'merged' ? 'merged' : 'closed', checks: check }
}

// Azure DevOps: `az repos pr list --source-branch <branch> --status all --top 1` and `az repos pr policy list --id <n>`:
// each policy evaluation is a check.
export function azurePr(list, policies) {
  const j = list?.[0]
  if (!j) return null
  const check = (p) => (p.status === 'rejected' || p.status === 'broken' ? 'fail' : p.status === 'running' || p.status === 'queued' ? 'pending' : 'pass')
  const state = j.status === 'completed' ? 'merged' : j.status === 'abandoned' ? 'closed' : 'open'
  return { number: j.pullRequestId, url: j.repository?.webUrl ? `${j.repository.webUrl}/pullrequest/${j.pullRequestId}` : null, state, checks: (policies ?? []).map(check) }
}

// The branch's pull request (from githubPr, gitlabMr or azurePr; null: none), unpushed work from
// `git rev-list --left-right --count @{u}...HEAD` ("behind<TAB>ahead", null: no upstream) and uncommitted changes from
// `git diff --shortstat HEAD` and `git status --porcelain`. ci: fail | pending | pass; passed of total checks.
export function repoState(pr, counts, shortstat = null, porcelain = null) {
  const [behind = 0, ahead = 0] = (counts ?? '').trim().split(/\s+/).map(Number)
  const checks = pr?.checks ?? []
  const ci = checks.includes('fail') ? 'fail' : checks.includes('pending') ? 'pending' : checks.length ? 'pass' : null
  const n = (re) => Number(re.exec(shortstat ?? '')?.[1] ?? 0)
  const untracked = (porcelain ?? '').split('\n').filter((l) => l.startsWith('??')).length
  return {
    pr: pr ? { number: pr.number, url: pr.url, state: pr.state, ci, passed: checks.filter((c) => c === 'pass').length, total: checks.length } : null,
    ahead: ahead || 0,
    behind: behind || 0,
    changes: { files: n(/(\d+) files? changed/), added: n(/(\d+) insertions?/), removed: n(/(\d+) deletions?/), untracked },
  }
}

// Token counts as the footer and pane write them: 950, 12.3k, 1.2M.
export const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

// A duration as the transcript writes one: 850ms, 4.2s, 1m 4s.
export const duration = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)

// The turn footer's tail after the engine's `Baked for 3s`: tokens in and out, cache hit rate, and what the turn cost.
export function footerText(t) {
  const u = t.usage
  const input = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  const hit = input ? Math.round((100 * u.cache_read_input_tokens) / input) : null
  return [`${tokens(input)} in`, `${tokens(u.output_tokens)} out`, hit == null ? null : `${hit}% cached`, t.cost == null ? null : `$${t.cost.toFixed(2)}`].filter(Boolean).join(' · ')
}

// Lines an edit adds and removes, read off the call's input: `+12 -4` (Edit, MultiEdit), `+40` (Write), else null.
export function editStat(tool, input) {
  const lines = (x) => (typeof x === 'string' && x ? x.split('\n').length : 0)
  if (tool === 'Write') return `+${lines(input?.content)}`
  const edits = tool === 'Edit' ? [input ?? {}] : tool === 'MultiEdit' ? (input?.edits ?? []) : null
  if (!edits) return null
  return `+${edits.reduce((n, x) => n + lines(x.new_string), 0)} -${edits.reduce((n, x) => n + lines(x.old_string), 0)}`
}

// When a rate-limit window fills at the pace of its recent samples, if that comes before it resets; else null.
// samples: [{ at, pct }] oldest first; a drop in pct is a reset, so only the samples after the last drop count.
export function fullAt(samples, resetsAt) {
  let s = samples.filter((x) => x.pct != null)
  const drop = s.findLastIndex((x, i) => i && x.pct < s[i - 1].pct)
  if (drop > 0) s = s.slice(drop)
  if (s.length < 2) return null
  const [a, b] = [s[0], s.at(-1)]
  const rate = (b.pct - a.pct) / (b.at - a.at)
  if (!(rate > 0) || b.pct >= 100) return null
  const at = b.at + (100 - b.pct) / rate
  return resetsAt != null && at >= resetsAt ? null : at
}

// A moment as the band writes it: 16:40 today, Thu 16:40 later.
export function when(ms, now) {
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return new Date(now).toDateString() === d.toDateString() ? hm : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${hm}`
}

// Cells of a bar chart, row-major [codePoint, color, background] triplets, one column per value (0-100). Heights
// span lo..hi (the tallest bar fills `rows`, the lowest keeps one eighth so it shows); colours are 0xRRGGBB by the
// value itself. 0x01000000 is the default background.
export const TONE_RGB = { ok: 0xa6e3a1, warn: 0xf9e2af, bad: 0xf38ba8 }
export function sparkCells(values, rows, lo = 0, hi = 100) {
  const out = []
  for (let r = 0; r < rows; r++) {
    for (const v of values) {
      const share = (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo || 1)
      const eighths = Math.max(1, Math.round(share * rows * 8)) - (rows - 1 - r) * 8
      const level = Math.min(8, Math.max(0, eighths))
      out.push(level ? BLOCKS.codePointAt(level - 1) : 32, v >= 80 ? TONE_RGB.bad : v >= 50 ? TONE_RGB.warn : TONE_RGB.ok, 0x01000000)
    }
  }
  return out
}

// The band's sparkline range: the history's own spread, at least 10 points, so a steady context still shows a shape.
export function sparkRange(values) {
  const lo = Math.max(0, Math.min(...values) - 2)
  return [lo, Math.min(100, Math.max(lo + 10, Math.max(...values)))]
}

// showCtx false leaves the context % out of `text` and `segments` (the Claude status line already shows it);
// `segments` are the same parts with their kind, bare value and a tone (ok | warn | bad) for a drawing to colour.
export function forecast({ percent, usage, turns = 0, ttlMs, sinceMs, showCtx = true }) {
  const ctx = percent == null ? null : Math.round(percent)
  const total = usage ? usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.input_tokens : 0
  const hit = total > 0 ? Math.round((100 * usage.cache_read_input_tokens) / total) : null
  const left = usage && ttlMs != null && sinceMs != null ? ttlMs - sinceMs : null
  const hints = []
  if (ctx != null && ctx >= 80) hints.push('compact soon')
  // The first turn always writes the cache, so a low hit rate there says nothing.
  const cold = hit != null && hit < 50 && turns > 1
  if (cold) hints.push('cache cold')
  if (left != null && left <= 0) hints.push('cache expired')
  const segments = [
    showCtx && ctx != null ? { kind: 'ctx', value: `${ctx}%`, text: `ctx ${ctx}%`, tone: ctx >= 80 ? 'bad' : ctx >= 50 ? 'warn' : 'ok' } : null,
    hit == null ? null : { kind: 'cache', value: `${hit}%`, text: `cache ${hit}%`, tone: cold ? 'bad' : 'ok' },
    left > 0 ? { kind: 'ttl', value: clock(left), text: `ttl ${clock(left)}`, tone: left <= 60_000 ? 'warn' : 'ok' } : null,
    ...hints.map((text) => ({ kind: 'hint', value: text, text, tone: text === 'compact soon' ? 'warn' : 'bad' })),
  ].filter(Boolean)
  const text = segments.map((x) => x.text).join(' · ')
  return { ctx, hit, left, hints, text, segments }
}
