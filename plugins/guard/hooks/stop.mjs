// Stop hook (Claude Code and VS Code Stop, Copilot agentStop): run `make check-fast` (when the Makefile
// defines it; large repos keep the full suite for CI) or else `make check` before the agent stops, but only
// when the repo changed since the last green run. On failure, block the stop once and hand back the output
// tail; a second stop (stop_hook_active) always passes, so it cannot loop. No make, no Makefile or neither
// target: nothing to do. make runs detached from the terminal (stdin closed, its own session), so a recipe that
// reads /dev/tty fails at once instead of hanging the session.
// It never becomes the bottleneck: on a strained host (the guard's host caps), while another stop check runs in the
// same repo, or past the timeout it is deferred, not failed: nothing is marked green, so the next stop runs it.
// Every outcome goes to telemetry as guard.stop (result, target, duration_ms).
// Env: GUARD_STOP_CHECK=off disables it, =force runs it on a strained host too (CI, where load is high by design);
// GUARD_STOP_TIMEOUT_MS overrides the timeout (default 300 s).
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { loadavg, platform } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { emit } from '../core/otel.mjs'
import { rules } from '../core/rules.mjs'
import { pluginDataDir } from './data.mjs'
import { failedTarget, harnessName, recordAttrs, scrub } from './telemetry.mjs'

const DEFAULT_TIMEOUT_MS = 300_000 // owner decision D7; the hook limit in hooks.json (1800 s) leaves room to raise it
const MAX_UNTRACKED = 2000
const sha = (s) => createHash('sha256').update(s).digest('hex')

// What "unchanged" means: same HEAD, same diff against it, same untracked files, names and contents. Null outside
// a git repo, when git fails or past MAX_UNTRACKED untracked files, which means "always run".
export function fingerprint(cwd, run = spawnSync) {
  const git = (args, input) => run('git', args, { cwd, encoding: 'utf8', windowsHide: true, input })
  const parts = [git(['rev-parse', 'HEAD']), git(['diff', 'HEAD']), git(['ls-files', '-o', '--exclude-standard', '-z'])]
  if (parts.some((p) => p.status !== 0)) return null
  const untracked = String(parts[2].stdout ?? '').split('\0').filter(Boolean)
  if (untracked.length > MAX_UNTRACKED) return null
  if (untracked.length) {
    const hashes = git(['hash-object', '--stdin-paths'], untracked.join('\n'))
    if (hashes.status !== 0) return null
    parts.push(hashes)
  }
  return sha(parts.map((p) => p.stdout ?? '').join('\0'))
}

// Runs make with no terminal: stdin closed, output piped, in its own session (`detached`: setsid on Unix, its own
// process group), with CI=1 and TERM=dumb. Past `timeout` the whole group is killed, grandchildren included.
// Resolves { status, stdout, stderr, timedOut, error }.
export function runDetached(cmd, args, { cwd, timeout }) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, CI: '1', TERM: 'dumb' } })
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (platform() === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        else process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, timeout)
    child.on('error', (error) => (clearTimeout(timer), resolve({ status: null, stdout, stderr, timedOut, error })))
    child.on('close', (status) => (clearTimeout(timer), resolve({ status, stdout, stderr, timedOut })))
  })
}

const stateFile = (cwd) =>
  join(pluginDataDir(), 'stop', `${sha(cwd).slice(0, 16)}.txt`)

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

// Why the host cannot take a check now, or null. Load average on Unix only (Windows reports 0), free disk everywhere.
export function hostStrain(cwd) {
  try {
    const load1 = loadavg()[0]
    if (platform() !== 'win32' && load1 > rules.host.loadCap) return `load ${Math.round(load1 * 10) / 10}`
    const fs = statfsSync(cwd)
    const freeGb = (fs.bavail * fs.bsize) / 1073741824
    return freeGb < rules.host.freeFloorGb ? `${Math.round(freeGb)} GB free` : null
  } catch {
    return null
  }
}

// One stop check per repo at a time: an exclusive lock file holding the pid; a dead holder's lock is taken over.
const lock = (cwd) => takeLock(`${stateFile(cwd)}.lock`)

// The lock at `file`: a release function, or null while a live process holds it.
export function takeLock(file) {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, String(process.pid), { flag: 'wx' })
    return () => rmSync(file, { force: true })
  } catch (err) {
    if (err?.code !== 'EEXIST') return () => {} // unwritable data dir: run unlocked
    try {
      process.kill(Number(readFileSync(file, 'utf8')), 0)
      return null // holder alive
    } catch {
      // Dead holder: remove its lock and take it with `wx` again, so of two stops taking over only one wins.
      try {
        rmSync(file, { force: true })
        writeFileSync(file, String(process.pid), { flag: 'wx' })
        return () => rmSync(file, { force: true })
      } catch {
        return null
      }
    }
  }
}

// `run` runs git and `make -n` (sync); `exec` runs the check itself (async, detached; tests pass a stub through
// `run`). `strain(cwd)` and `report(attrs)` are injected by tests and the in-process bridge.
export async function stopCheck(input, run = spawnSync, { exec = run === spawnSync ? runDetached : async (c, a, o) => run(c, a, o), strain = hostStrain, report = () => {} } = {}) {
  if (input.stop_hook_active || process.env.GUARD_STOP_CHECK === 'off') return null
  const cwd = input.cwd || process.cwd()
  const timeout = Number(process.env.GUARD_STOP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  const opts = { cwd, encoding: 'utf8', timeout, windowsHide: true }
  const target = ['check-fast', 'check'].find((t) => run('make', ['-n', t], opts).status === 0)
  if (!target) return null
  const fp = fingerprint(cwd, run)
  if (fp && fp === lastGreen(cwd)) return null
  const deferred = (why, attrs = {}) => {
    report({ result: 'deferred', target, why, ...attrs })
    return { systemMessage: `make ${target} deferred (${why}); it runs at the next stop. Run it before you ship.` }
  }
  const strained = process.env.GUARD_STOP_CHECK === 'force' ? null : strain(cwd)
  if (strained) return deferred(`host strained: ${strained}`)
  const unlock = lock(cwd)
  if (!unlock) return deferred('another stop check is running in this repo')
  const started = Date.now()
  let r
  try {
    r = await exec('make', [target], opts)
  } finally {
    unlock()
  }
  const done = (result) => report({ result, target, duration_ms: Date.now() - started })
  if (r.status === 0) {
    if (fp) markGreen(cwd, fp)
    done('pass')
    return null
  }
  // A timeout is deferred, not failed (owner decision D7): nothing is marked green and nothing blocks.
  if (r.timedOut || r.error?.code === 'ETIMEDOUT') return deferred(`did not finish within ${Math.round(timeout / 1000)} s`, { duration_ms: Date.now() - started })
  const all = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd()
  // What failed, for telemetry: the innermost make target and the last output line, scrubbed of secrets.
  report({ result: 'fail', target, duration_ms: Date.now() - started, failed_target: failedTarget(all), last_line: scrub(all.split('\n').at(-1)) })
  const out = all.split('\n').slice(-40).join('\n')
  const reason = `make ${target} failed; fix before finishing:\n${out || r.error?.message || `exit ${r.status}`}`
  // Claude and Copilot CLI read the top-level decision; VS Code reads it from hookSpecificOutput.
  return { decision: 'block', reason, hookSpecificOutput: { hookEventName: 'Stop', decision: 'block', reason } }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
    let event = null
    const out = await stopCheck(input, spawnSync, { report: (attrs) => (event = attrs) })
    // Codex rejects a Stop output with keys it does not know: it gets the top-level decision and reason only.
    const codex = harnessName() === 'codex'
    if (out) process.stdout.write(JSON.stringify(codex && out.decision ? { decision: out.decision, reason: out.reason } : out))
    if (event) await emit(process.env, 'guard.stop', recordAttrs({ ...event, session_id: input.session_id }, input.cwd || process.cwd(), harnessName()))
  } catch {
    // unreadable payload: let the agent stop
  }
}
