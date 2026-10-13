// pi extension: hud's status line in pi's footer (ctx.ui.setStatus): the context weather, the model, the branch's PR
// with its checks, unpushed and uncommitted work. Same parts and icons as the Claude band; refreshed at session start
// and after each turn. Also makes the work-item references of each reply links (links.mjs). Loaded from the root
// package.json.
import { execFile } from 'node:child_process'
import { linkRepo, linkify, styled } from './links.mjs'
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

// An assistant message with the references in its text blocks made markdown links, which pi's renderer draws as
// OSC 8 hyperlinks; null when nothing changed. pi has no display-only hook: `message_end` replaces the stored message,
// so the session file and the model's next turn see the links too.
export function linkMessage(message, links, glyph) {
  if (message?.role !== 'assistant' || !links || !Array.isArray(message.content)) return null
  let changed = false
  const content = message.content.map((b) => {
    if (b.type !== 'text') return b
    const text = linkify(b.text, links, { glyph })
    changed ||= text !== b.text
    return text === b.text ? b : { ...b, text }
  })
  return changed ? { ...message, content } : null
}

export default function hudExtension(pi, deps = {}) {
  let repo = null
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
  pi.on('session_start', (_e, ctx) => void refresh(ctx))
  pi.on('turn_end', (_e, ctx) => draw(ctx))
  pi.on('agent_settled', (_e, ctx) => void refresh(ctx))
  // Only where a TUI draws the reply (not `pi -p` or JSON, whose text stays the model's) and the terminal draws OSC 8
  // links (deps.hyperlinks, pi-tui's detection from pi-entry.mjs); elsewhere a link prints its URL beside it.
  pi.on('message_end', async (e, ctx) => {
    try {
      if (!ctx.hasUI || !(await deps.hyperlinks?.())) return undefined
      const message = linkMessage(e.message, repo?.links, styled(process.env))
      return message ? { message } : undefined
    } catch {
      return undefined // the session ended under us: leave the message as it is
    }
  })
}
