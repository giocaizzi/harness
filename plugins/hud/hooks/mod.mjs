// Claude Code mod (hooks.json `modules`; Copilot ignores the key): the token-weather band and `/weather` pane with
// the PR and CI strip and the limit forecasts; the turn footer, tool rows and spinner, the subagent tracker and the
// context pane register from their own files. Toasts and sounds are the `sounds` plugin's.
import { atom, read, update } from 'claude-code'
import { registerAgents } from './agents.mjs'
import { registerContext } from './context.mjs'
import { registerFooter } from './footer.mjs'
import { linkRepo } from './links.mjs'
import { toTree } from './markup.mjs'
import { createFacts, fetchState, rewrite, settings } from './rewrite.mjs'
import { registerTools } from './tools.mjs'
import { ICON, TTL_MS, azurePr, battery, clock, forecast, forgeOf, fullAt, githubPr, gitlabMr, glyph, repoState, sparkCells, sparkRange, tokens, when } from './weather.mjs'

// The last main-loop turn: its usage, when it ended, and how many turns this conversation has had.
const weather = atom({ plugin: 'hud', key: 'weather' }, null)
// Context % and cache hit % of the last turns (null: unknown), oldest first.
const history = atom({ plugin: 'hud', key: 'history' }, [])

// Written here, drawn by footer.mjs and agents.mjs (each file declares the atoms it reads): the main loop's turns for
// the footer, and the subagents for the tracker.
const turns = atom({ plugin: 'hud', key: 'turns' }, [])
const agents = atom({ plugin: 'hud', key: 'agents' }, [])
const KEEP_TURNS = 200

// The repository a reply's work-item references link to (links.mjs linkRepo); null: no remote or another forge.
let linkTo = null
// The branch's PR, unpushed work and uncommitted changes (the band says them).
const repo = atom({ plugin: 'hud', key: 'repo' }, null)
const REPO_REFRESH_MS = 60_000
// Checks passed, failed, or some still running (an hourglass: nf-fa-hourglass_half).
const CI_ICON = { pass: '\u2713', fail: '\u2717', pending: ICON.pending }
const CI_TONE = { pass: 'ok', fail: 'bad', pending: 'warn' }

const PANE = 'weather'
const HISTORY_TURNS = 24
const BAND_TURNS = 8
const TONE_COLOR = { ok: undefined, warn: '#f9e2af', bad: '#f38ba8' }

// A bar chart of the history as one Raster; a value of unknown context counts as empty.
const spark = (Raster, key, values, rows, lo, hi) =>
  Raster({ key, columns: values.length, rows, cells: new Uint8Array(Uint32Array.from(sparkCells(values, rows, lo, hi)).buffer).toBase64() })

// A /clear: forget the last turn and redraw.
async function reset($) {
  await update($, weather, () => null)
  await update($, history, () => [])
  $.ui.invalidate('ui.render')
}

async function sessionCost($) {
  try {
    return (await $.session.usage()).cost?.usd
  } catch {
    return undefined // usage unavailable
  }
}

async function contextPercent($) {
  try {
    return (await $.session.usage()).context.percent
  } catch {
    return undefined // usage unavailable
  }
}

// The branch's PR (with its checks) from the forge the origin remote names, unpushed work and uncommitted changes;
// each part is null where git or the forge's CLI (gh, glab, az) cannot say.
// argv's stdout, or null where it fails or is missing.
const runner = ($, timeoutMs = 8000) => async (argv) => {
  try {
    const r = await $.process.run(argv, { timeoutMs })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null // not a repository, or the tool is missing
  }
}

// The reply rewrites' lookups (rewrite.mjs createFacts), cached for the session: files, commits, work-item states.
const replyFacts = ($) =>
  createFacts({
    stat: async (p) => {
      const s = await $.fs.stat(p).catch(() => null)
      return s?.kind === 'file' || s?.kind === 'dir' ? s.kind : null
    },
    commit: async (sha) => (await runner($, 3000)(['git', 'cat-file', '-e', `${sha}^{commit}`])) !== null,
    state: (r, ref) => fetchState(runner($, 8000), r, ref),
  })

async function refreshRepo($) {
  const run = runner($)
  const json = async (argv) => {
    const out = await run(argv)
    try {
      return out ? JSON.parse(out) : null
    } catch {
      return null // not JSON: an old CLI or a prompt
    }
  }
  const forge = forgeOf((await run(['git', 'remote', 'get-url', 'origin']))?.trim())
  linkTo = await linkRepo(run)
  let pr = null
  if (forge === 'github') pr = githubPr(await json(['gh', 'pr', 'view', '--json', 'number,url,state,statusCheckRollup']))
  if (forge === 'gitlab') pr = gitlabMr(await json(['glab', 'mr', 'view', '--output', 'json']))
  if (forge === 'azure') {
    const branch = (await run(['git', 'branch', '--show-current']))?.trim()
    const list = branch ? await json(['az', 'repos', 'pr', 'list', '--source-branch', branch, '--status', 'all', '--top', '1', '--output', 'json']) : null
    const id = list?.[0]?.pullRequestId
    pr = azurePr(list, id ? await json(['az', 'repos', 'pr', 'policy', 'list', '--id', String(id), '--output', 'json']) : null)
  }
  const counts = await run(['git', 'rev-list', '--left-right', '--count', '@{u}...HEAD'])
  const shortstat = await run(['git', 'diff', '--shortstat', 'HEAD'])
  const porcelain = await run(['git', 'status', '--porcelain'])
  await update($, repo, () => repoState(pr, counts, shortstat, porcelain))
}

// The rate-limit windows by kind (five_hour, seven_day): percent used and the reset in epoch ms; empty when unavailable.
async function windows($) {
  try {
    return Object.fromEntries((await $.session.usage()).rateLimits.map((r) => [r.kind, { pct: r.percentUsed, resetsAt: r.resetsAt ? Date.parse(r.resetsAt) : null }]))
  } catch {
    return {} // usage unavailable
  }
}

export function register(on, options = {}) {
  let facts = null
  let settling = false
  registerFooter(on)
  registerTools(on)
  registerAgents(on)
  registerContext(on)
  let ttlMs = TTL_MS['5m']
  let tick
  let repoTick

  // Draw at once (the context part needs no turn); a reload keeps $.state, so the last turn stays.
  on('session.start', async ($, e, next) => {
    $.ui.invalidate('ui.render')
    try {
      ttlMs = TTL_MS[(await $.settings.read()).promptCacheTtl] ?? TTL_MS['5m']
    } catch {
      // settings unreadable: the API default
    }
    facts = replyFacts($)
    await refreshRepo($)
    await $.command.register({ name: 'weather', description: 'Show the context and prompt-cache history in a pane' })
    await $.command.register({ name: 'subagents', description: 'Show the subagents of this session in a pane' })
    await $.command.register({ name: 'ctx', description: 'Show what fills the context window in a pane' })
    tick?.cancel()
    repoTick?.cancel()
    repoTick = $.clock.every(REPO_REFRESH_MS, () => refreshRepo($))
    // The TTL countdown: one redraw a second while the band shows a last turn.
    tick = $.clock.every(1000, async () => {
      if ((await read($, weather)) || (await read($, agents)).some((x) => x.state === 'running')) $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await reset($)
    return next(e)
  })

  // A subagent's turn ends its row in the tracker; the weather and the footer follow the main loop only, since a
  // subagent's turn says nothing about this conversation's cache.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const at = await $.clock.now()
      const u = e.usage
      const used = u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens : 0
      const state = e.reason === 'answer' ? 'done' : 'failed'
      await update($, agents, (a) => a.map((x) => (x.id === e.agentId ? { ...x, endedAt: at, state, tokens: x.tokens + used } : x)))
    }
    if (!e.agentId && e.usage) {
      const usd = await sessionCost($)
      await update($, turns, (t) => {
        const prev = t.at(-1)?.usd
        return [...t, { durationMs: e.durationMs, usage: e.usage, usd: usd ?? null, cost: usd != null && prev != null ? usd - prev : null }].slice(-KEEP_TURNS)
      })
      const at = await $.clock.now()
      const lim = await windows($)
      const { ctx, hit } = forecast({ percent: await contextPercent($), usage: e.usage, turns: 2 })
      await update($, weather, (w) => ({ usage: e.usage, at, turns: (w?.turns ?? 0) + 1 }))
      const sample = (w) => ({ pct: w?.pct ?? null, resetsAt: w?.resetsAt ?? null })
      await update($, history, (h) => [...h, { at, ctx, hit, five: sample(lim.five_hour), seven: sample(lim.seven_day) }].slice(-HISTORY_TURNS))
    }
    if (!e.agentId) await refreshRepo($)
    return next(e)
  })

  // Our line under whatever the plugins beneath draw (next-steps and the like), never in its place: last in the
  // band, it sits right above the prompt, and a blank row such a plugin leads with stays above the band.
  // The context % and its weather glyph are in the status line; the band says the work in flight and the cache facts.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const w = await read($, weather)
    const now = await $.clock.now()
    const f = forecast({ percent: await contextPercent($), usage: w?.usage, turns: w?.turns ?? 0, ttlMs, sinceMs: w ? now - w.at : undefined, showCtx: false })
    const all = await read($, history)
    const h = all.slice(-BAND_TURNS)
    const { Box, Text, Raster, Link } = $.ui.resolve(e)
    const dim = (children) => Text({ dimColor: true, children: [children] })
    // Each part in brackets, as the prompt and the status line draw theirs: dim while fine, coloured when not.
    const bracket = (inner) => [dim('['), inner, dim(']')]
    const part = (text, tone) => bracket(Text({ color: TONE_COLOR[tone], dimColor: tone === 'ok', children: [text] }))
    const label = (x) => (ICON[x.kind] ? `${ICON[x.kind]} ${x.value}` : x.value)
    const r = await read($, repo)
    const c = r?.changes
    // Uncommitted work: files changed, lines added and removed, untracked files.
    const changes = c && (c.files || c.untracked) ? [c.files ? `~${c.files} +${c.added} -${c.removed}` : '', c.untracked ? `?${c.untracked}` : ''].filter(Boolean).join(' ') : null
    const ahead = r && (r.ahead || r.behind) ? `${r.ahead ? `\u2191${r.ahead}` : ''}${r.ahead && r.behind ? ' ' : ''}${r.behind ? `\u2193${r.behind}` : ''}` : null
    // Every part is `[icon value]`. The PR number opens the PR on a click; what follows it says its state or checks.
    const prState = (pr) =>
      pr.state === 'merged'
        ? Text({ color: '#cba6f7', children: [` ${ICON.merged} merged`] })
        : pr.state === 'closed'
          ? Text({ dimColor: true, children: [' closed'] })
          : pr.ci
            ? Text({ color: TONE_COLOR[CI_TONE[pr.ci]], dimColor: pr.ci === 'pass', children: [` ${CI_ICON[pr.ci]} ${pr.passed}/${pr.total}`] })
            : null
    const prPart = r?.pr
      ? bracket(
          Box({
            flexDirection: 'row',
            children: [
              Text({ dimColor: true, children: [`${ICON.pr} `] }),
              r.pr.url ? Link({ href: r.pr.url, label: `#${r.pr.number}` }) : Text({ children: [`#${r.pr.number}`] }),
              prState(r.pr),
            ].filter(Boolean),
          }),
        )
      : null
    const running = (await read($, agents)).filter((x) => x.state === 'running').length
    // A window that fills before it resets, at the pace of the last turns.
    const full = [['5h', 'five'], ['7d', 'seven']].flatMap(([label, key]) => {
      const last = all.at(-1)?.[key]
      const at = fullAt(all.map((x) => ({ at: x.at, pct: x[key]?.pct ?? null })), last?.resetsAt)
      return at == null ? [] : [part(`${ICON.forecast} ${label} full ~${when(at, now)}`, 'warn')]
    })
    const ctxs = h.map((x) => x.ctx ?? 0)
    const parts = [
      prPart,
      ahead ? part(`${ICON.sync} ${ahead}`, 'ok') : null,
      changes ? part(`${ICON.changes} ${changes}`, 'ok') : null,
      running ? part(`${ICON.agents} ${running}`, 'ok') : null,
      ...full,
      ...f.segments.map((x) => part(label(x), x.tone)),
      h.length > 1 ? bracket(Box({ flexDirection: 'row', children: [Text({ dimColor: true, children: [`${ICON.trend} `] }), spark(Raster, 'weather-spark', ctxs, 1, ...sparkRange(ctxs))] })) : null,
    ].filter(Boolean)
    if (!parts.length) return below
    // One column in from the edge, as the status line is drawn.
    const line = Box({
      flexDirection: 'row',
      paddingLeft: 1,
      children: [
        ...parts.flatMap((p, i) => [i ? Text({ children: [' '] }) : null, ...p]),
      ].filter(Boolean),
    })
    // Claude Code keeps a blank row under the band; a blank row on top pairs it, unless a plugin beneath already
    // leads its block with one (next-steps does). The engine's own drawing under the band takes no rows.
    const alone = !below || below.type === 'engine'
    return Box({ flexDirection: 'column', marginTop: alone ? 1 : 0, children: below ? [below, line] : [line] })
  })

  // Reply rewrites (rewrite.mjs): secrets masked, long URLs, work-item references with their state, paths and
  // file:line, commits, timestamps and pass/fail, each a setting. Display only: the stored message keeps the model's
  // text. A rewrite never waits: what is not known yet (a file, a commit, a state) is drawn as written, then drawn
  // again once its lookup is in. Colour needs a tree of our own (markup.mjs), as markdown carries none.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const env = { NO_COLOR: await $.env.get('NO_COLOR') }
    const o = settings(options, env, true)
    facts ??= replyFacts($)
    const cwd = await $.session.cwd().catch(() => null)
    const ctx = { repo: linkTo, cwd, home: (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')), now: await $.clock.now() }
    const text = rewrite(e.props.text, o, ctx, facts)
    if (facts.pending && !settling) {
      settling = true
      void facts.settle(10_000).then(() => {
        settling = false
        $.ui.invalidate('ui.render')
      })
    }
    if (text === e.props.text) return next(e)
    return toTree(text, $.ui.resolve(e), { first: e.props.isFirstOfReply }) ?? next({ ...e, props: { ...e.props, text } })
  })

  // /weather: the history at full size.
  on('command.run', { command: 'weather' }, async ($) => {
    const opened = await $.ui.open({ id: PANE, title: 'Token weather', focus: true })
    return { text: opened.isPlaced ? 'Token weather pane opened.' : 'Widen the terminal to see the token weather pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Raster } = $.ui.resolve(e)
    const w = await read($, weather)
    const h = await read($, history)
    const left = w ? ttlMs - ((await $.clock.now()) - w.at) : null
    const filled = left == null ? 0 : Math.round((20 * Math.max(0, left)) / ttlMs)
    return Box({
      flexDirection: 'column',
      children: [
        h.length ? Text({ dimColor: true, children: ['context %, one bar per turn'] }) : Text({ dimColor: true, children: ['No turns yet.'] }),
        h.length ? spark(Raster, 'weather-pane', h.map((x) => x.ctx ?? 0), 4) : null,
        ...h.slice(-8).map((x, i, rows) =>
          Text({ children: [`turn ${w.turns - (rows.length - 1 - i)}  ${glyph(x.ctx) || ' '}  ${x.ctx ?? '?'}%  ${ICON.cache} ${x.hit ?? '?'}%`] }),
        ),
        ...[['5h', 'five'], ['7d', 'seven']].flatMap(([label, key]) => {
          const series = h.map((x) => x[key]?.pct ?? 0)
          const now = h.at(-1)?.[key]?.pct
          return now == null ? [] : [Text({ children: [`${battery(now)} ${label} ${Math.round(now)}%`] }), spark(Raster, `weather-${key}`, series, 1, 0, 100)]
        }),
        w ? Text({ dimColor: true, children: [`last turn: ${tokens(w.usage.input_tokens)} in · ${tokens(w.usage.cache_read_input_tokens)} read · ${tokens(w.usage.cache_creation_input_tokens)} written · ${tokens(w.usage.output_tokens)} out`] }) : null,
        // The TTL gauge: a heavy rule for what is left, a light one for what is spent.
        left == null
          ? null
          : Box({
              flexDirection: 'row',
              children:
                left > 0
                  ? [
                      Text({ children: [`${ICON.ttl} `] }),
                      Text({ color: TONE_COLOR[left <= 60_000 ? 'warn' : 'ok'] ?? '#a6e3a1', children: ['━'.repeat(filled)] }),
                      Text({ dimColor: true, children: ['─'.repeat(20 - filled)] }),
                      Text({ children: [` ${clock(left)}`] }),
                    ]
                  : [Text({ color: TONE_COLOR.bad, children: ['cache expired'] })],
            }),
        Button({ label: 'Close', hotkey: 'q', onPress: () => $.ui.close({ id: PANE }) }),
      ].filter(Boolean),
    })
  })
}
