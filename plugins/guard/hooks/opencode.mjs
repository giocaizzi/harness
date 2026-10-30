// opencode plugin: the guard's rules on opencode's plugin hooks (https://opencode.ai/docs/plugins/).
// scripts/install.mjs writes a one-line stub into ~/.config/opencode/plugins/ that re-exports this file.
// A plugin cannot ask (opencode 1.19 declares `permission.ask` but never calls it), so the `config` hook adds
// `permission.bash` ask entries for the risky prefixes and opencode asks itself; any other risky form is denied.
import { createGuard } from './bridge.mjs'
import { nativeAsk, opencodeAsks } from '../core/engine.mjs'
import { rules } from '../core/rules.mjs'

const ASKS = opencodeAsks(rules)
const ROOT_TIMEOUT_MS = 2000
// A config key that rules on bash: `bash` or the `*` catch-all.
const bashKeys = (perm) => (perm && typeof perm === 'object' ? Object.entries(perm).filter(([k]) => k === 'bash' || k === '*').map(([, v]) => v) : [perm])
const denies = (perm) => bashKeys(perm).some((v) => v === 'deny' || (v && typeof v === 'object' && Object.values(v).includes('deny')))

// The permission config with the asks appended last to `bash` (opencode's last matching rule wins), so they
// override the user's allows. `bash` moves after `*` for the same reason.
export function withAsks(perm) {
  const p = typeof perm === 'string' ? { '*': perm } : { ...perm }
  const bash = typeof p.bash === 'string' ? { '*': p.bash } : { ...p.bash }
  delete p.bash
  for (const k of Object.keys(ASKS)) delete bash[k]
  return { ...p, bash: { ...bash, ...ASKS } }
}

// The LSP tool's name when opencode enables it (`OPENCODE_EXPERIMENTAL_LSP_TOOL` or `OPENCODE_EXPERIMENTAL`), else null.
export const opencodeLsp = (env = process.env) => (env.OPENCODE_EXPERIMENTAL_LSP_TOOL === 'true' || env.OPENCODE_EXPERIMENTAL === 'true' ? 'lsp' : null)

export const GuardPlugin = async ({ client, directory }, deps) => {
  let asks = false // the config hook added the asks
  const guard = createGuard({
    harness: 'opencode',
    noAsk: true,
    deps: {
      // opencode's LSP tool exists only behind its experimental flag (https://opencode.ai/docs/tools/).
      lspTool: opencodeLsp(),
      // opencode asks only when the asks are in, the command is a covered form and no session rule (an API
      // caller's `tools: { bash: true }`) overrides them; anything unsure is denied. `opencode run --auto`
      // approves every ask itself, so it gets the deny. ponytail: `run --attach <url> --auto` approves from the
      // client process, whose argv this server-side plugin cannot see.
      nativeAsk: async (command, rule, input) => {
        // Any `--auto` spelling yargs takes (`--auto`, `--auto=true`, `--auto true`) except an explicit false.
        const auto = (deps?.argv ?? process.argv).some((a) => a.startsWith('--auto') && a !== '--auto=false')
        if (!asks || auto || !nativeAsk(command, rule, rules)) return false
        const s = await client.session.get({ path: { id: input.agent_id ?? input.session_id } }).catch(() => null)
        return Boolean(s?.data) && !(s.data.permission ?? []).some((r) => r.permission === 'bash' || r.permission === '*')
      },
      ...deps,
    },
  })
  const notes = new Map() // callID -> note for the tool output (the pip note outside uv repos)
  // A subagent runs in a child session (`parentID`): it belongs to the root session, as its own agent. Unreadable, or
  // no answer within ROOT_TIMEOUT_MS (a hung server must not stall the tool call): its own, and the next call asks again.
  const roots = new Map()
  const rootOf = (id) => {
    if (!roots.has(id)) {
      const walk = (async () => {
        let cur = id
        for (let depth = 0; depth < 5; depth++) {
          const parent = (await client.session?.get?.({ path: { id: cur } }).catch(() => null))?.data?.parentID
          if (!parent) break
          cur = parent
        }
        return cur
      })().catch(() => id)
      const late = Symbol('late')
      let timer
      const timeout = new Promise((resolve) => (timer = setTimeout(resolve, deps?.rootTimeoutMs ?? ROOT_TIMEOUT_MS, late)))
      roots.set(id, Promise.race([walk, timeout]).then((root) => {
        if (root !== late) return root
        roots.delete(id)
        return id
      }).finally(() => clearTimeout(timer)))
    }
    return roots.get(id)
  }
  const who = async (id) => {
    const root = await rootOf(id)
    return root && root !== id ? { sessionId: root, agentId: id } : { sessionId: id }
  }
  const blocked = new Set() // sessions whose last stop make check already blocked
  const reported = new Set() // assistant messages whose usage was sent (message.updated repeats)
  const text = (t) => (typeof t === 'string' ? t : '')

  return {
    // ponytail: a user deny on bash (or `*`) anywhere skips the asks, so they never weaken it; the guard denies there.
    config: async (cfg) => {
      const agents = Object.values(cfg.agent ?? {}).filter((a) => a?.permission)
      if (denies(cfg.permission) || agents.some((a) => denies(a.permission))) return
      cfg.permission = withAsks(cfg.permission ?? {})
      for (const a of agents) a.permission = withAsks(a.permission)
      asks = true
    },
    'tool.execute.before': async (input, output) => {
      const d = await guard.preTool({ ...(await who(input.sessionID)), cwd: directory, tool: String(input.tool).toLowerCase(), input: output.args ?? {} })
      if (d.decision === 'deny' || d.decision === 'ask') throw new Error(d.reason)
      if (d.context) notes.set(input.callID, d.context)
      if (d.notice) Promise.resolve().then(() => client.tui.showToast({ body: { message: d.notice, variant: 'info' } })).catch(() => {})
    },
    'tool.execute.after': async (input, output) => {
      const extra = [notes.get(input.callID), guard.postTool({ cwd: directory, tool: String(input.tool).toLowerCase(), input: input.args ?? {} })].filter(Boolean)
      notes.delete(input.callID)
      if (extra.length) output.output = [text(output.output), ...extra].filter(Boolean).join('\n\n')
    },
    'chat.message': async (input, output) => {
      const prompt = (output.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      if (prompt) await guard.prompt({ ...(await who(input.sessionID)), cwd: directory, prompt })
    },
    event: async ({ event }) => {
      const sessionId = event.properties?.sessionID ?? event.properties?.info?.id
      const info = event.properties?.info
      // Usage once per finished assistant message; opencode prices it (`cost`, USD).
      if (event.type === 'message.updated' && info?.role === 'assistant' && info.time?.completed && info.tokens && !reported.has(info.id)) {
        reported.add(info.id)
        const t = info.tokens
        await guard.usage({ sessionId: info.sessionID, model: info.modelID ?? info.model?.id, provider: info.providerID ?? info.model?.providerID, tokens: { input: t.input, output: t.output, cacheRead: t.cache?.read, cacheWrite: t.cache?.write, reasoning: t.reasoning }, costUsd: info.cost })
      }
      if (event.type === 'session.created') guard.awake()
      else if (event.type === 'session.deleted') await guard.sessionEnd({ sessionId })
      else if (event.type === 'session.idle' && sessionId) {
        // The Stop hook: when make check fails, send the failure back once; the next idle always passes (the factory
        // result gate, sent back the same way, holds at most twice per run). A subagent's
        // session (it has a parent) is part of its parent's turn: the parent's idle runs the check.
        const session = await Promise.resolve()
          .then(() => client.session.get({ path: { id: sessionId } }))
          .catch(() => null)
        if (session?.data?.parentID) return
        const reason = await guard.stop({ cwd: directory, active: blocked.has(sessionId) })
        if (!reason) return void blocked.delete(sessionId)
        blocked.add(sessionId)
        await client.session.prompt({ path: { id: sessionId }, body: { parts: [{ type: 'text', text: reason }] } }).catch(() => {})
      }
    },
  }
}
