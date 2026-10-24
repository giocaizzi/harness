// opencode's running subagents for hud's TUI plugin (opencode-tui.mjs), free of TUI imports so node can test them.
// A `task` call runs its subagent as a child session: `session.created` names its parent and agent, each assistant
// `message.updated` the model and variant (the effort) it runs at, `session.status` whether it is busy. Pure: fed
// opencode's events, it answers the parts to draw beside one session's prompt.
import { ICON } from './weather.mjs'

export const EVENTS = ['session.created', 'session.updated', 'session.deleted', 'message.updated', 'session.status']

export function createChildren() {
  const kids = new Map()
  return {
    // Takes one event; true when what a session draws may have changed.
    on(e) {
      const type = e?.type
      const p = e?.properties ?? {}
      const info = p.info ?? {}
      // A message's info is the message (its session is `sessionID`), a session's the session; a status names its session.
      const kid = kids.get(type === 'message.updated' ? info.sessionID : (info.id ?? p.sessionID))
      if ((type === 'session.created' || type === 'session.updated') && info.parentID) {
        kids.set(info.id, { busy: true, ...kid, parent: info.parentID, agent: info.agent ?? kid?.agent })
        return true
      }
      if (!kid) return false
      if (type === 'session.deleted') return kids.delete(info.id)
      if (type === 'message.updated' && info.role === 'assistant') Object.assign(kid, { model: info.modelID ?? kid.model, variant: info.variant ?? kid.variant })
      else if (type === 'session.status') kid.busy = p.status?.type !== 'idle'
      else return false
      return true
    },
    // `[icon agent · model · variant]` for each busy child of the session, one space apart.
    parts(session) {
      return [...kids.values()]
        .filter((k) => k.parent === session && k.busy)
        .map((k) => `[${ICON.agents} ${[k.agent, k.model, k.variant].filter(Boolean).join(' · ')}]`)
        .join(' ')
    },
  }
}
