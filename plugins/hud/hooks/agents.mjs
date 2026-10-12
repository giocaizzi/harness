// The subagent tracker: each spawned subagent with its type, model, state, time and tokens, in `/subagents`; the
// band counts the running ones.
import { atom, read, update } from 'claude-code'
import { duration, tokens } from './weather.mjs'

const agents = atom({ plugin: 'hud', key: 'agents' }, [])
const PANE = 'subagents'
const KEEP = 30
const STATE = { running: ['…', '#f9e2af'], done: ['✓', '#a6e3a1'], failed: ['✗', '#f38ba8'] }

export function registerAgents(on) {
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const at = await $.clock.now()
      const row = { id: r.agentId, type: e.subagentType, description: e.description, model: r.model, startedAt: at, endedAt: null, state: 'running', tokens: 0 }
      await update($, agents, (a) => [...a, row].slice(-KEEP))
    }
    return r
  }).catch(($, e, next) => next(e)) // a failed record never blocks the spawn

  on('command.run', { command: 'subagents' }, async ($) => {
    const opened = await $.ui.open({ id: PANE, title: 'Subagents', focus: true })
    return { text: opened.isPlaced ? 'Subagents pane opened.' : 'Widen the terminal to see the subagents pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const a = await read($, agents)
    const now = await $.clock.now()
    return Box({
      flexDirection: 'column',
      children: [
        a.length ? null : Text({ dimColor: true, children: ['No subagents yet.'] }),
        ...a.map((x) =>
          Box({
            key: x.id,
            flexDirection: 'row',
            children: [
              Text({ color: STATE[x.state][1], children: [`${STATE[x.state][0]} `] }),
              Text({ children: [`${x.type} `] }),
              Text({ dimColor: true, children: [`${x.description} · ${x.model} · ${duration((x.endedAt ?? now) - x.startedAt)}${x.tokens ? ` · ${tokens(x.tokens)} tok` : ''}`] }),
            ],
          }),
        ),
        Button({ label: 'Close', hotkey: 'q', onPress: () => $.ui.close({ id: PANE }) }),
      ].filter(Boolean),
    })
  })
}
