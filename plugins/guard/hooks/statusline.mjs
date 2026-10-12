// Copilot CLI status line (`statusLine.command` in ~/.copilot/settings.json): the token-weather line the Claude mod
// draws above the prompt. Copilot pipes the session status as JSON on stdin; its token totals are cumulative and
// include cache reads and writes, so the hit rate is the session's, not the last turn's. No TTL: Copilot has none.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { forecast } from './weather.mjs'

export function copilotWeather(status) {
  const c = status?.context_window ?? {}
  const read = c.total_cache_read_tokens ?? 0
  const write = c.total_cache_write_tokens ?? 0
  const usage = c.total_input_tokens ? { cache_read_input_tokens: read, cache_creation_input_tokens: write, input_tokens: Math.max(0, c.total_input_tokens - read - write) } : undefined
  // More input than the last call means more than one call, so a low hit rate is worth a hint.
  const turns = c.total_input_tokens > (c.last_call_input_tokens ?? 0) ? 2 : 1
  return forecast({ percent: c.current_context_used_percentage ?? c.used_percentage ?? undefined, usage, turns }).text
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.stdout.write(copilotWeather(JSON.parse(readFileSync(0, 'utf8') || '{}')))
  } catch {
    // unreadable status: print nothing
  }
}
