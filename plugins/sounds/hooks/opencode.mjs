// opencode plugin: sounds' turn and context alerts on opencode's events (https://opencode.ai/docs/plugins/). When a
// session goes idle it plays the default clip for how the turn ended (macOS only) and shows the notices as TUI toasts
// (`client.tui.showToast`). The context is the last assistant message's tokens over the model's context limit.
// scripts/install.mjs writes a one-line stub into ~/.config/opencode/plugins/ that re-exports this file, so it exports
// nothing but the plugin (opencode calls every exported function as one).
import { CLIPS, settle } from './alerts.mjs'
import { afplay } from './play.mjs'

export const SoundsPlugin = async ({ client }, deps = {}) => {
  const play = deps.play ?? afplay
  const now = deps.now ?? Date.now
  const started = new Map() // sessionID -> when its last prompt was sent
  const errors = new Map() // sessionID -> the error name that ended its turn
  const last = new Map() // sessionID -> its last assistant message
  const levels = new Map() // sessionID -> context levels raised so far
  const children = new Set() // subagent sessions
  let limits // `${providerID}/${modelID}` -> context window, read once
  const contextOf = async (m) => {
    limits ??= client.config
      .providers()
      .then((r) => Object.fromEntries((r.data?.providers ?? []).flatMap((p) => Object.values(p.models ?? {}).map((x) => [`${p.id}/${x.id}`, x.limit?.context]))))
      .catch(() => ({}))
    return (await limits)[`${m.providerID}/${m.modelID}`]
  }

  return {
    'chat.message': async (input) => {
      started.set(input.sessionID, now())
      errors.delete(input.sessionID)
    },
    event: async ({ event }) => {
      const p = event.properties ?? {}
      if (event.type === 'permission.asked' || event.type === 'question.asked') play(CLIPS.soundNeedsInput)
      else if (event.type === 'session.created' && p.info?.parentID) children.add(p.info.id)
      else if (event.type === 'message.updated' && p.info?.role === 'assistant') last.set(p.info.sessionID, p.info)
      else if (event.type === 'session.error' && p.sessionID) errors.set(p.sessionID, p.error?.name ?? 'UnknownError')
      else if (event.type === 'session.idle' && p.sessionID) {
        const id = p.sessionID
        const m = last.get(id)
        const t = m?.tokens
        const limit = m && (await contextOf(m))
        const used = t ? t.input + t.output + t.reasoning + t.cache.read + t.cache.write : 0
        const err = errors.get(id)
        const r = settle({
          durationMs: now() - (started.get(id) ?? now()),
          aborted: err === 'MessageAbortedError',
          error: Boolean(err) && err !== 'MessageAbortedError',
          agentId: children.has(id) ? id : undefined,
          pct: limit ? Math.round((used / limit) * 100) : null,
          before: levels.get(id) ?? {},
        })
        levels.set(id, r.now)
        errors.delete(id)
        for (const clip of r.clips) play(clip)
        for (const message of r.notices) void client.tui.showToast({ body: { message, variant: 'info' } }).catch(() => {})
      }
    },
  }
}
