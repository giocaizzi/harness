// opencode plugin: the guard's rules on opencode's plugin hooks (https://opencode.ai/docs/plugins/).
// scripts/install.mjs writes a one-line stub into ~/.config/opencode/plugins/ that re-exports this file.
// opencode cannot ask from a plugin, so a risky command is denied (as on Codex).
import { createGuard } from './bridge.mjs'

export const GuardPlugin = async ({ client, directory }, deps) => {
  const guard = createGuard({ harness: 'opencode', noAsk: true, deps })
  const notes = new Map() // callID -> note for the tool output (the pip note outside uv repos)
  const blocked = new Set() // sessions whose last stop make check already blocked
  const text = (t) => (typeof t === 'string' ? t : '')

  return {
    'tool.execute.before': async (input, output) => {
      const d = await guard.preTool({ sessionId: input.sessionID, cwd: directory, tool: String(input.tool).toLowerCase(), input: output.args ?? {} })
      if (d.decision === 'deny' || d.decision === 'ask') throw new Error(d.reason)
      if (d.context) notes.set(input.callID, d.context)
    },
    'tool.execute.after': async (input, output) => {
      const extra = [notes.get(input.callID), guard.postTool({ cwd: directory, tool: String(input.tool).toLowerCase(), input: input.args ?? {} })].filter(Boolean)
      notes.delete(input.callID)
      if (extra.length) output.output = [text(output.output), ...extra].filter(Boolean).join('\n\n')
    },
    'chat.message': async (input, output) => {
      const prompt = (output.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      if (prompt) await guard.prompt({ sessionId: input.sessionID, cwd: directory, prompt })
    },
    event: async ({ event }) => {
      const sessionId = event.properties?.sessionID ?? event.properties?.info?.id
      if (event.type === 'session.created') guard.awake()
      else if (event.type === 'session.deleted') await guard.sessionEnd({ sessionId })
      else if (event.type === 'session.idle' && sessionId) {
        // The Stop hook: when make check fails, send the failure back once; the next idle always passes.
        const reason = guard.stop({ cwd: directory, active: blocked.has(sessionId) })
        if (!reason) return void blocked.delete(sessionId)
        blocked.add(sessionId)
        await client.session.prompt({ path: { id: sessionId }, body: { parts: [{ type: 'text', text: reason }] } }).catch(() => {})
      }
    },
  }
}
