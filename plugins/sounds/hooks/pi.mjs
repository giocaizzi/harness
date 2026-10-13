// pi extension: sounds' turn and context alerts on pi's events. A finished run plays its clip and, after a minute or
// on an error, raises a notification (ctx.ui.notify); the context crossing 80% and 90% raises one each. The clips and
// thresholds are the Claude plugin's defaults (pi has no per-plugin settings). Clips play with afplay, so on macOS only,
// as in Claude Code. Loaded from the root package.json.
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { alerts, turnNotice, turnSound } from './alerts.mjs'

const SOUNDS = join(dirname(fileURLToPath(import.meta.url)), '..', 'sounds')
// The plugin.json defaults: the clip per alert or turn ending.
export const CLIPS = { soundContext: 'alert', soundDone: 'done', soundAborted: null, soundRefused: 'error', soundError: 'error' }

const afplay = (name) => process.platform === 'darwin' && execFile('afplay', [join(SOUNDS, `${name}.wav`)], () => {})

// What a settled run raises: the clips to play and the notifications to show.
export function settle({ durationMs, aborted, error, pct, before }) {
  const e = { durationMs, reason: aborted ? 'aborted' : error ? 'error' : 'done' }
  const { alerts: raised, now } = alerts(pct, {}, before)
  const clips = [CLIPS[turnSound(e)], ...raised.map((a) => CLIPS[a.key])].filter(Boolean)
  const notices = [turnNotice(e), ...raised.map((a) => a.text)].filter(Boolean)
  return { clips: [...new Set(clips)], notices, now }
}

export default function soundsExtension(pi, deps = {}) {
  const play = deps.play ?? afplay
  let started = Date.now()
  let error = false
  let levels = {}
  pi.on('agent_start', () => {
    started = Date.now()
    error = false
  })
  pi.on('message_end', (event) => {
    if (event.message?.stopReason === 'error') error = true
  })
  pi.on('session_compact', () => (levels = {}))
  pi.on('agent_settled', (event, ctx) => {
    const r = settle({ durationMs: Date.now() - started, aborted: event.aborted, error, pct: ctx.getContextUsage?.()?.percent ?? null, before: levels })
    levels = r.now
    for (const clip of r.clips) play(clip)
    if (ctx.hasUI) for (const text of r.notices) ctx.ui.notify(text, 'info')
  })
}
