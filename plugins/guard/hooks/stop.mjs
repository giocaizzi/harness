// Stop hook (Claude Code and VS Code Stop, Copilot agentStop): run `make check-fast` (when the Makefile
// defines it; large repos keep the full suite for CI) or else `make check` before the agent stops, but only
// when the repo changed since the last green run. On failure, block the stop once and hand back the output
// tail; a second stop (stop_hook_active) always passes, so it cannot loop. No make, no Makefile or neither
// target: nothing to do. A timeout is reported, never treated as a failure.
// Env: GUARD_STOP_CHECK=off disables it; GUARD_STOP_TIMEOUT_MS overrides the timeout (default 1750 s).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_TIMEOUT_MS = 1_750_000 // under the 1800 s hook limit in hooks.json
const sha = (s) => createHash('sha256').update(s).digest('hex')

// What "unchanged" means: same HEAD, same diff against it, same untracked file names. Null outside a git
// repo (or when git fails), which means "always run".
export function fingerprint(cwd, run = spawnSync) {
  const git = (...args) => run('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  const parts = [git('rev-parse', 'HEAD'), git('diff', 'HEAD'), git('ls-files', '-o', '--exclude-standard')]
  if (parts.some((p) => p.status !== 0)) return null
  return sha(parts.map((p) => p.stdout ?? '').join('\0'))
}

const stateFile = (cwd) =>
  join(process.env.CLAUDE_PLUGIN_DATA || process.env.COPILOT_PLUGIN_DATA || join(tmpdir(), 'guard-plugin'), 'stop', `${sha(cwd).slice(0, 16)}.txt`)

function lastGreen(cwd) {
  try {
    return readFileSync(stateFile(cwd), 'utf8').trim()
  } catch {
    return null
  }
}

function markGreen(cwd, fp) {
  try {
    mkdirSync(join(stateFile(cwd), '..'), { recursive: true })
    writeFileSync(stateFile(cwd), fp)
  } catch {
    // best effort: the next stop just runs the check again
  }
}

export function stopCheck(input, run = spawnSync) {
  if (input.stop_hook_active || process.env.GUARD_STOP_CHECK === 'off') return null
  const cwd = input.cwd || process.cwd()
  const timeout = Number(process.env.GUARD_STOP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  const opts = { cwd, encoding: 'utf8', timeout, windowsHide: true }
  const target = ['check-fast', 'check'].find((t) => run('make', ['-n', t], opts).status === 0)
  if (!target) return null
  const fp = fingerprint(cwd, run)
  if (fp && fp === lastGreen(cwd)) return null
  const r = run('make', [target], opts)
  if (r.status === 0) {
    if (fp) markGreen(cwd, fp)
    return null
  }
  if (r.error?.code === 'ETIMEDOUT') {
    return { systemMessage: `make ${target} did not finish within ${Math.round(timeout / 1000)} s; not blocking. Raise GUARD_STOP_TIMEOUT_MS or run it by hand.` }
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd().split('\n').slice(-40).join('\n')
  const reason = `make ${target} failed; fix before finishing:\n${out || r.error?.message || `exit ${r.status}`}`
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
