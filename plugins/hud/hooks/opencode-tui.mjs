// opencode TUI plugin: each running subagent of the session, with its model and variant (the effort), beside the
// prompt (`session_prompt_right` slot). scripts/install.mjs lists it in tui.json's `plugin`. opencode resolves
// `@opentui/solid` and `solid-js` to its own copies, so the text is built without JSX; node cannot load this file, so
// the tests take opencode-agents.mjs.
import { createElement, insert } from '@opentui/solid'
import { createSignal } from 'solid-js'
import { createChildren, EVENTS } from './opencode-agents.mjs'

export default {
  id: 'giocaizzi-hud',
  tui: async (api) => {
    const kids = createChildren()
    const [version, bump] = createSignal(0)
    for (const type of EVENTS) {
      const off = api.event.on(type, (e) => kids.on(e) && bump((n) => n + 1))
      api.lifecycle.onDispose(off)
    }
    api.slots.register({
      slots: {
        session_prompt_right: (ctx, props) => {
          const text = createElement('text')
          if (ctx.theme?.current?.textMuted) text.fg = ctx.theme.current.textMuted
          insert(text, () => (version(), kids.parts(props.session_id)))
          return text
        },
      },
    })
  },
}
