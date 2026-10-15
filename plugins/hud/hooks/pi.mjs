// pi extension: hud's status line in pi's footer (ctx.ui.setStatus): the context weather, the model, the branch's PR
// with its checks, unpushed and uncommitted work. Same parts and icons as the Claude band; refreshed at session start
// and after each turn. Also rewrites each reply (rewrite.mjs: links, paths, commits, secrets, ...). Loaded from the root
// package.json.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { linkRepo } from './links.mjs'
import { createFacts, FEATURES, fetchState, refsRule, rewrite, settings } from './rewrite.mjs'
import { azurePr, forgeOf, githubPr, gitlabMr, glyph, ICON, repoState } from './weather.mjs'

// The footer text from the facts; a part is left out where its fact is missing.
export function piStatus({ pct, model, repo }) {
  const parts = []
  if (pct != null) parts.push(`[${glyph(pct)} ctx:${Math.round(pct)}%]`)
  if (model) parts.push(`[${ICON.model} ${model}]`)
  const pr = repo?.pr
  if (pr) {
    const icon = pr.state === 'merged' ? ICON.merged : pr.ci === 'pending' ? ICON.pending : ICON.pr
    const ci = pr.ci === 'fail' ? ' ✗' : pr.total ? ` ${pr.passed}/${pr.total}` : ''
    parts.push(`[${icon} #${pr.number}${pr.state === 'open' ? ci : ` ${pr.state}`}]`)
  }
  if (repo?.ahead || repo?.behind) parts.push(`[${ICON.sync} ↑${repo.ahead} ↓${repo.behind}]`)
  const c = repo?.changes
  if (c && (c.files || c.untracked)) parts.push(`[${ICON.changes} ${c.files + c.untracked} +${c.added} -${c.removed}]`)
  return parts.join(' ')
}

const run = (argv, cwd) =>
  new Promise((resolve) => execFile(argv[0], argv.slice(1), { cwd, timeout: 8000, windowsHide: true }, (err, out) => resolve(err ? null : out)))

// The branch's PR from the origin remote's forge, unpushed work and uncommitted changes, as the Claude mod reads them.
export async function readRepo(cwd, exec = run) {
  const j = async (argv) => {
    try {
      return JSON.parse((await exec(argv, cwd)) ?? 'null')
    } catch {
      return null
    }
  }
  const forge = forgeOf((await exec(['git', 'remote', 'get-url', 'origin'], cwd))?.trim())
  let pr = null
  if (forge === 'github') pr = githubPr(await j(['gh', 'pr', 'view', '--json', 'number,url,state,statusCheckRollup']))
  if (forge === 'gitlab') pr = gitlabMr(await j(['glab', 'mr', 'view', '--output', 'json']))
  if (forge === 'azure') {
    const branch = (await exec(['git', 'branch', '--show-current'], cwd))?.trim()
    const list = branch ? await j(['az', 'repos', 'pr', 'list', '--source-branch', branch, '--status', 'all', '--top', '1', '--output', 'json']) : null
    const id = list?.[0]?.pullRequestId
    pr = azurePr(list, id ? await j(['az', 'repos', 'pr', 'policy', 'list', '--id', String(id), '--output', 'json']) : null)
  }
  const counts = await exec(['git', 'rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd)
  return { ...repoState(pr, counts, await exec(['git', 'diff', '--shortstat', 'HEAD'], cwd), await exec(['git', 'status', '--porcelain'], cwd)), links: await linkRepo((argv) => exec(argv, cwd)) }
}

// An assistant message with fn(text) applied to its text blocks; null when nothing changed. pi has no display-only
// hook: `message_end` replaces the stored message, so the session file and the model's next turn see the rewrite
// too (a masked secret leaves the context; a link keeps its target in the URL).
export function rewriteMessage(message, fn) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return null
  let changed = false
  const content = message.content.map((b) => {
    if (b.type !== 'text') return b
    const text = fn(b.text)
    changed ||= text !== b.text
    return text === b.text ? b : { ...b, text }
  })
  return changed ? { ...message, content } : null
}

// pi has no per-plugin settings: `hud.json` in pi's config directory (PI_CODING_AGENT_DIR, else ~/.pi/agent) takes
// the Claude settings' keys. Times are off unless set there: a rewrite is stored, and "5h ago" would go stale.
export const PI_DEFAULTS = { replyTimes: 'off' }
export function piOptions(env = process.env, read = (p) => readFileSync(p, 'utf8')) {
  const dir = env.PI_CODING_AGENT_DIR || join(env.HOME || env.USERPROFILE || homedir(), '.pi', 'agent')
  try {
    return { ...PI_DEFAULTS, ...JSON.parse(read(join(dir, 'hud.json'))) }
  } catch {
    return { ...PI_DEFAULTS } // none, or not JSON
  }
}

// The rewrites' lookups in the session's directory (rewrite.mjs createFacts).
export const piFacts = (cwd, exec = run) =>
  createFacts({
    stat: async (p) => {
      try {
        const s = await stat(p)
        return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null
      } catch {
        return null // missing
      }
    },
    commit: async (sha) => (await exec(['git', 'cat-file', '-e', `${sha}^{commit}`], cwd)) !== null,
    state: (r, ref) => fetchState((argv) => exec(argv, cwd), r, ref),
  })

// Lookups a reply's rewrite waits for at most: the message is stored once, so it cannot be drawn again later.
const SETTLE_MS = 1500

export default function hudExtension(pi, deps = {}) {
  let repo = null
  let facts = null
  const draw = (ctx) => {
    try {
      if (!ctx.hasUI) return
      const pct = ctx.getContextUsage?.()?.percent ?? null
      ctx.ui.setStatus('hud', piStatus({ pct, model: ctx.model?.id, repo }))
    } catch {
      // the session ended while the repo was read (pi -p): its context is gone, nothing to draw
    }
  }
  const refresh = async (ctx) => {
    try {
      repo = await (deps.readRepo ?? readRepo)(ctx.cwd)
    } catch {
      repo = null // not a repository
    }
    draw(ctx)
  }
  pi.on('session_start', (_e, ctx) => {
    facts = null // a new session, maybe in another directory
    void refresh(ctx)
  })
  pi.on('turn_end', (_e, ctx) => draw(ctx))
  // /refresh-refs: forget every lookup, so the next replies ask again. A stored reply is not drawn again.
  pi.registerCommand?.('refresh-refs', {
    description: 'Look up the issue and PR states, files and commits in the next replies again',
    handler: async (_args, ctx) => {
      facts = null
      ctx.ui?.notify?.('hud: lookups cleared; the next replies look them up again.', 'info')
    },
  })
  // The rule that a reference of another repository is written whole (rewrite.mjs refsRule), as a guideline.
  pi.on('before_agent_start', (e) => {
    const rule = refsRule(repo?.links ?? null, settings(deps.options ?? piOptions(), process.env, false))
    if (!rule) return
    const g = (e.systemPromptOptions.promptGuidelines ??= [])
    if (!g.includes(rule)) g.push(rule)
  })
  pi.on('agent_settled', (_e, ctx) => void refresh(ctx))
  // The reply rewrites (rewrite.mjs), without colour: pi's markdown takes none, and an escape sequence would be stored.
  // All of them only where a TUI draws the reply and the terminal draws OSC 8 links (deps.hyperlinks, pi-tui's
  // detection from pi-entry.mjs), since elsewhere a link prints its URL beside it; there (`pi -p`, JSON, no OSC 8)
  // secrets are still masked, plainly.
  pi.on('message_end', async (e, ctx) => {
    try {
      const links = !!ctx.hasUI && !!(await deps.hyperlinks?.())
      const all = settings(deps.options ?? piOptions(), process.env, false)
      const secrets = all.f.replySecrets && { glyph: false, colour: false }
      const o = links ? all : { ...all, f: { ...Object.fromEntries(FEATURES.map((k) => [k, null])), replySecrets: secrets } }
      facts ??= (deps.facts ?? piFacts)(ctx.cwd)
      const c = { repo: repo?.links ?? null, cwd: ctx.cwd, home: process.env.HOME ?? process.env.USERPROFILE, now: Date.now() }
      const once = () => rewriteMessage(e.message, (t) => rewrite(t, o, c, facts))
      let message = once()
      if (facts.pending) {
        await facts.settle(SETTLE_MS)
        message = once()
      }
      return message ? { message } : undefined
    } catch {
      return undefined // the session ended under us: leave the message as it is
    }
  })
}
