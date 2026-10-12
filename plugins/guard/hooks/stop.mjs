// Stop hook (Claude Code and VS Code Stop, Copilot agentStop): run `make check` once before the agent stops.
// On failure, block the stop once and hand back the output tail; a second stop (stop_hook_active)
// always passes, so it cannot loop. No make, no Makefile or no `check` target: nothing to do.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function stopCheck(input, run = spawnSync) {
  if (input.stop_hook_active) return null
  const opts = { cwd: input.cwd || process.cwd(), encoding: 'utf8', timeout: 590_000, windowsHide: true }
  if (run('make', ['-n', 'check'], opts).status !== 0) return null
  const r = run('make', ['check'], opts)
  if (r.status === 0) return null
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd().split('\n').slice(-40).join('\n')
  const reason = `make check failed; fix before finishing:\n${out || r.error?.message || `exit ${r.status}`}`
  // Claude and Copilot CLI read the top-level decision; VS Code reads it from hookSpecificOutput.
  return { decision: 'block', reason, hookSpecificOutput: { hookEventName: 'Stop', decision: 'block', reason } }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const out = stopCheck(JSON.parse(readFileSync(0, 'utf8') || '{}'))
    if (out) process.stdout.write(JSON.stringify(out))
  } catch {
    // unreadable payload: let the agent stop
  }
}
