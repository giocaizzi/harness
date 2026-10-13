// pi extension: the guard's rules on pi's extension events (docs/extensions.md in earendil-works/pi).
// Loaded from the repo's root package.json (`pi install git:github.com/giocaizzi/harness`). pi can ask, so a
// risky command gets a confirm dialog; without a UI (print or JSON mode) it is blocked.
import { createGuard } from './bridge.mjs'

export default function guardExtension(pi, deps) {
  const guard = createGuard({ harness: 'pi', deps })
  const notes = new Map() // toolCallId -> note for the tool result
  let blocked = false // the last settle already sent a make check failure back
  const sessionOf = (ctx) => ctx.sessionManager?.getSessionId?.()

  pi.on('tool_call', async (event, ctx) => {
    const d = await guard.preTool({ sessionId: sessionOf(ctx), cwd: ctx.cwd, tool: String(event.toolName).toLowerCase(), input: event.input ?? {} })
    if (d.decision === 'deny') return { block: true, reason: d.reason }
    if (d.decision === 'ask' && !(ctx.hasUI && (await ctx.ui.confirm('Run this risky command?', d.reason)))) return { block: true, reason: d.reason }
    if (d.context) notes.set(event.toolCallId, d.context)
  })

  pi.on('tool_result', async (event, ctx) => {
    const extra = [notes.get(event.toolCallId), guard.postTool({ cwd: ctx.cwd, tool: String(event.toolName).toLowerCase(), input: event.input ?? {} })].filter(Boolean)
    notes.delete(event.toolCallId)
    if (extra.length) return { content: [...(event.content ?? []), ...extra.map((text) => ({ type: 'text', text }))] }
  })

  pi.on('input', async (event, ctx) => {
    await guard.prompt({ sessionId: sessionOf(ctx), cwd: ctx.cwd, prompt: event.text ?? '' })
    return { action: 'continue' }
  })

  pi.on('session_start', () => void guard.awake())
  pi.on('session_shutdown', async (_event, ctx) => void (await guard.sessionEnd({ sessionId: sessionOf(ctx) })))

  // The Stop hook: when make check fails, send the failure back as a follow-up once; the next settle passes.
  pi.on('agent_settled', async (event, ctx) => {
    if (event.aborted) return
    const reason = guard.stop({ cwd: ctx.cwd, active: blocked })
    blocked = Boolean(reason)
    if (reason) await pi.sendUserMessage(reason)
  })
}
