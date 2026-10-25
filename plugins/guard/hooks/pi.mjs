// pi extension: the guard's rules on pi's extension events (docs/extensions.md in earendil-works/pi).
// Loaded from the repo's root package.json (`pi install git:github.com/giocaizzi/harness`). pi can ask, so a
// risky command gets a confirm dialog; without a UI (print or JSON mode) it is blocked.
import { createGuard } from './bridge.mjs'

export default function guardExtension(pi, deps) {
  const guard = createGuard({ harness: 'pi', deps })
  const notes = new Map() // toolCallId -> note for the tool result
  let blocked = false // the last settle already sent a make check failure back
  // A dev-tools `subagent` child runs with `--no-session`: it names the parent session and itself in its environment.
  const sessionOf = (ctx) => process.env.GUARD_PARENT_SESSION || ctx.sessionManager?.getSessionId?.()
  const agentId = process.env.GUARD_PARENT_SESSION ? process.env.GUARD_AGENT_ID || 'subagent' : undefined

  pi.on('tool_call', async (event, ctx) => {
    const d = await guard.preTool({ sessionId: sessionOf(ctx), agentId, cwd: ctx.cwd, tool: String(event.toolName).toLowerCase(), input: event.input ?? {} })
    if (d.decision === 'deny') return { block: true, reason: d.reason }
    if (d.decision === 'ask') {
      const ask = { sessionId: sessionOf(ctx), cwd: ctx.cwd, tool: String(event.toolName), command: event.input?.command }
      if (!ctx.hasUI) {
        await guard.askResult({ ...ask, result: 'unavailable', via: 'no-ui' })
        return { block: true, reason: `${d.reason}\nNo UI to confirm this (print or JSON mode), so the command was not run: ask the user to run it.` }
      }
      const started = Date.now()
      const ok = await ctx.ui.confirm('Run this risky command?', d.reason)
      await guard.askResult({ ...ask, result: ok ? 'allow' : 'deny', waitMs: Date.now() - started })
      if (!ok) return { block: true, reason: `The user denied this command. Do not retry it or a respelling of it; ask the user what they want instead.\n${d.reason}` }
    }
    if (d.context) notes.set(event.toolCallId, d.context)
    // pi blocks a call whose handler throws: a notice must never cost the call.
    if (d.notice && ctx.hasUI) {
      try {
        ctx.ui.notify(d.notice, 'info')
      } catch {
        // no notification: the agent still has the note
      }
    }
  })

  pi.on('tool_result', async (event, ctx) => {
    const extra = [notes.get(event.toolCallId), guard.postTool({ cwd: ctx.cwd, tool: String(event.toolName).toLowerCase(), input: event.input ?? {} })].filter(Boolean)
    notes.delete(event.toolCallId)
    if (extra.length) return { content: [...(event.content ?? []), ...extra.map((text) => ({ type: 'text', text }))] }
  })

  pi.on('input', async (event, ctx) => {
    await guard.prompt({ sessionId: sessionOf(ctx), agentId, cwd: ctx.cwd, prompt: event.text ?? '' })
    return { action: 'continue' }
  })

  // Usage per assistant message: pi prices it at its catalog rate (usage.cost.total).
  pi.on('message_end', async (event, ctx) => {
    const m = event.message
    if (m?.role !== 'assistant' || !m.usage) return
    const u = m.usage
    await guard.usage({ sessionId: sessionOf(ctx), model: m.responseModel ?? m.model, provider: m.provider, tokens: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, reasoning: u.reasoning }, costUsd: u.cost?.total })
  })

  pi.on('session_start', () => void guard.awake())
  pi.on('session_shutdown', async (_event, ctx) => void (await guard.sessionEnd({ sessionId: sessionOf(ctx) })))

  // The Stop hook: when make check fails, send the failure back as a follow-up once; the next settle passes. The factory
  // result gate is sent back the same way, at most twice per run.
  pi.on('agent_settled', async (event, ctx) => {
    if (event.aborted) return
    const reason = await guard.stop({ cwd: ctx.cwd, active: blocked })
    blocked = Boolean(reason)
    if (reason) await pi.sendUserMessage(reason)
  })
}
