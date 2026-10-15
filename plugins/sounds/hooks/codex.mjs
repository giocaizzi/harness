#!/usr/bin/env node
// Codex Stop hook: sounds' turn and context alerts. Codex's Stop payload names the turn and its rollout
// (`transcript_path`); the rollout holds the turn's start (`task_started`), errors and token counts against the
// model's context window. The finished turn plays its default clip (macOS only) and the notices go back as
// `systemMessage`, which Codex shows as a warning. Named only by the generated hooks/codex.json (from
// hooks/codex-only.json); never fails the hook.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CLIPS, settle } from './alerts.mjs'
import { afplay } from './play.mjs'

// The turn's facts from the rollout's JSONL lines: when it started, whether it hit an error, and the context used.
export function turnFacts(lines, turnId) {
  let startedMs = null
  let error = false
  let pct = null
  for (const line of lines) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const p = e?.type === 'event_msg' ? e.payload : null
    if (p?.type === 'task_started' && p.turn_id === turnId) [startedMs, error] = [p.started_at * 1000, false]
    else if (p?.type === 'error') error = true
    else if (p?.type === 'token_count' && p.info?.model_context_window) pct = Math.round((p.info.last_token_usage.total_tokens / p.info.model_context_window) * 100)
  }
  return { startedMs, error, pct }
}

export function stop(payload, { now = Date.now(), dataDir, read = (f) => readFileSync(f, 'utf8'), play = afplay } = {}) {
  const facts = turnFacts(read(payload.transcript_path).split('\n'), payload.turn_id)
  const state = join(dataDir, `sounds-codex-${String(payload.session_id).replace(/[^\w-]/g, '')}.json`)
  let before = {}
  try {
    before = JSON.parse(read(state))
  } catch {
    // first turn of the session
  }
  const r = settle({ durationMs: facts.startedMs == null ? 0 : now - facts.startedMs, error: facts.error, pct: facts.pct, before })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(state, JSON.stringify(r.now))
  for (const clip of r.clips) play(clip)
  return r.notices.length ? { systemMessage: r.notices.join(' · ') } : {}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let input = ''
  process.stdin.on('data', (d) => (input += d))
  process.stdin.on('end', () => {
    let out = {}
    try {
      const payload = JSON.parse(input)
      if (payload.hook_event_name === 'PermissionRequest') afplay(CLIPS.soundNeedsInput) // no decision: Codex prompts
      else out = stop(payload,{ dataDir: process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'giocaizzi-sounds') })
    } catch {
      // fail open: a missing rollout or bad payload plays nothing
    }
    process.stdout.write(JSON.stringify(out))
  })
}
