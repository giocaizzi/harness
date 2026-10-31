// Stop hook (Claude Code and VS Code Stop, Copilot agentStop): run `make check-fast` (when the Makefile
// defines it; large repos keep the full suite for CI) or else `make check` before the agent stops, but only
// when the repo changed since the last green run, and the change is not docs only (core/docsonly.mjs, plus the repo's
// `.stop-check-ignore`). On failure, block the stop once and hand back the output
// tail; a second stop (stop_hook_active) always passes, so it cannot loop. No make, no Makefile or neither
// target: nothing to do. make runs detached from the terminal (stdin closed, its own session), so a recipe that
// reads /dev/tty fails at once instead of hanging the session.
// It never becomes the bottleneck: on a strained host (the guard's host caps), while another stop check runs in the
// same repo, or past the timeout it is deferred, not failed: nothing is marked green, so the next stop runs it.
// Every outcome goes to telemetry as guard.stop (result, target, duration_ms); the result gate's blocks, its cap and
// its own errors too, as target result-gate.
// Env: GUARD_STOP_CHECK=off disables it, =force runs it on a strained host too (CI, where load is high by design);
// GUARD_STOP_TIMEOUT_MS overrides the timeout (default 300 s).
// Before it, in a factory run, the result gate (resultGate below) blocks a stop that leaves no valid result.json.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { loadavg, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { docsOnly } from '../core/docsonly.mjs'
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
// It resolves right after the kill, without waiting for 'close': a grandchild outside the group (an MSYS `&` job on
// Windows, which taskkill misses) can hold the pipes open for good, so they are destroyed and the child unref'd.
// Resolves { status, stdout, stderr, timedOut, error }.
export function runDetached(cmd, args, { cwd, timeout }) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, CI: '1', TERM: 'dumb' } })
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, timedOut, ...r })
    }
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
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      finish({ status: null })
    }, timeout)
    child.on('error', (error) => finish({ status: null, error }))
    child.on('close', (status) => finish({ status }))
  })
}

// The paths changed since `base` (the last green run's HEAD; HEAD when there is none): `git diff` against it with
// renames split into delete and add, plus untracked files, all relative to the repo root, and the text of the repo's
// `.stop-check-ignore` ('' when it has none). Null when git cannot say, which means "run the check".
export function changes(cwd, base, run = spawnSync) {
  const git = (args, at) => run('git', args, { cwd: at, encoding: 'utf8', windowsHide: true })
  const top = git(['rev-parse', '--show-toplevel'], cwd)
  const root = top.status === 0 ? String(top.stdout ?? '').trim() : ''
  if (!root) return null
  const commit = /^[0-9a-f]{40,64}$/.test(base ?? '') ? base : 'HEAD'
  const diff = git(['diff', '--name-only', '--no-renames', '-z', commit, '--'], root)
  const untracked = git(['ls-files', '-o', '--exclude-standard', '-z'], root)
  if (diff.status !== 0 || untracked.status !== 0) return null
  const paths = `${diff.stdout ?? ''}\0${untracked.stdout ?? ''}`.split('\0').filter(Boolean)
  let rules = ''
  try {
    rules = readFileSync(join(root, '.stop-check-ignore'), 'utf8')
  } catch {
    // no repo rules: the defaults alone
  }
  return { paths, rules }
}

const stateFile = (cwd) =>
  join(pluginDataDir(), 'stop', `${sha(cwd).slice(0, 16)}.txt`)

// The last green run: { fp, head } (its fingerprint and HEAD; a file from an older guard has no head), or {}.
function lastGreen(cwd) {
  try {
    const [fp, head] = readFileSync(stateFile(cwd), 'utf8').trim().split('\n')
    return { fp, head }
  } catch {
    return {}
  }
}

function markGreen(cwd, fp, run) {
  try {
    const head = run('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true })
    mkdirSync(join(stateFile(cwd), '..'), { recursive: true })
    writeFileSync(stateFile(cwd), head.status === 0 ? `${fp}\n${String(head.stdout ?? '').trim()}` : fp)
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

const RESULT_GATE_MAX = 2 // blocks per run id, so a run that cannot write a valid file still ends
const TICKET_NUMBER = /^[\w.-]+\/[\w.-]+#([1-9]\d*)$/

// The factory result gate: why a factory run may not stop yet, or null. A runtime's run (FACTORY_RUN_ID and
// FACTORY_TICKET) needs a valid <main checkout>/.factory/runs/<n>/result.json carrying its run id; an attended run
// (FACTORY_ATTENDED_RUN_ID and FACTORY_ATTENDED_TICKET) is held only to a present file that carries its id and is
// invalid. The checks are factory's check-result.mjs, which `make build` copies into .generated/factory/ (the plugins
// install separately). A subagent's stop, GUARD_RESULT_GATE=off, a run already blocked RESULT_GATE_MAX times and any
// error of the gate itself pass. `onEvent(attrs)` gets each block, cap and error, for telemetry.
export async function resultGate(input, run = spawnSync, env = process.env, onEvent = () => {}) {
  const event = (result, attrs = {}) => onEvent({ result, target: 'result-gate', ...attrs })
  try {
    if (env.GUARD_RESULT_GATE === 'off' || input.agent_id || /^subagentstop$/i.test(input.hook_event_name ?? '')) return null
    const runtime = (env.FACTORY_RUN_ID ?? '').trim()
    const runId = runtime || (env.FACTORY_ATTENDED_RUN_ID ?? '').trim()
    const number = TICKET_NUMBER.exec((runtime ? env.FACTORY_TICKET : env.FACTORY_ATTENDED_TICKET)?.trim() ?? '')?.[1]
    if (!runId || !number) return null
    const git = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: input.cwd || process.cwd(), encoding: 'utf8', windowsHide: true })
    if (git.status !== 0 || !String(git.stdout ?? '').trim()) return null
    const file = join(dirname(String(git.stdout).trim()), '.factory', 'runs', number, 'result.json')
    const { report, resultErrors } = await import('../.generated/factory/check-result.mjs')
    let errors
    try {
      const result = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      if (!runtime && result?.run_id !== runId) return null
      // A group run's run file resolves against the session's directory, as the run itself reads it.
      const runFile = (env.FACTORY_RUN_FILE ?? '').trim()
      errors = resultErrors(result, runtime ? (runFile ? { ...env, FACTORY_RUN_FILE: resolve(input.cwd || process.cwd(), runFile) } : env) : {})
    } catch (e) {
      if (!runtime) return null
      errors = [e.code === 'ENOENT' ? 'no such file' : e instanceof SyntaxError ? `not valid JSON (${e.message})` : `cannot read (${e.code ?? e.message})`]
    }
    if (!errors.length) return null
    const counter = join(pluginDataDir(), 'result-gate', `${sha(runId).slice(0, 16)}.txt`)
    let blocks = 0
    try {
      blocks = Number(readFileSync(counter, 'utf8')) || 0
    } catch {
      // no block yet
    }
    if (blocks >= RESULT_GATE_MAX) {
      event('capped', { runner: runtime ? 'runtime' : 'attended' })
      return null
    }
    mkdirSync(dirname(counter), { recursive: true })
    writeFileSync(counter, String(blocks + 1))
    event('block', { runner: runtime ? 'runtime' : 'attended', blocks: blocks + 1 })
    return [
      `Factory result gate (block ${blocks + 1} of ${RESULT_GATE_MAX}): ${file} is not a valid result for run ${runId}:`,
      ...report(errors),
      "Write it with the ticket-run skill's scripts/write-result.mjs, never by hand: put the judgment fields in a JSON file and run `node <skill dir>/scripts/write-result.mjs <file>` from the repo; fix the input, never the written file, until it exits 0.",
      'A subagent (such as the verifier) ignores this and ends its turn: the main session writes the file.',
    ].join('\n')
  } catch (e) {
    event('error', { why: scrub(String(e?.message ?? e)).slice(0, 200) })
    return null
  }
}

// The result gate, then make check; when both block, one block carries both reasons.
export async function stopCheck(input, run = spawnSync, opts = {}) {
  const gate = await resultGate(input, run, process.env, opts.report)
  const check = await makeCheck(input, run, opts)
  if (!gate) return check
  const reason = check?.decision === 'block' ? `${gate}\n\n${check.reason}` : gate
  return { ...(check?.systemMessage ? { systemMessage: check.systemMessage } : {}), decision: 'block', reason, hookSpecificOutput: { hookEventName: 'Stop', decision: 'block', reason } }
}

// `run` runs git and `make -n` (sync); `exec` runs the check itself (async, detached; tests pass a stub through
// `run`). `strain(cwd)` and `report(attrs)` are injected by tests and the in-process bridge.
async function makeCheck(input, run = spawnSync, { exec = run === spawnSync ? runDetached : async (c, a, o) => run(c, a, o), strain = hostStrain, report = () => {} } = {}) {
  if (input.stop_hook_active || process.env.GUARD_STOP_CHECK === 'off') return null
  const cwd = input.cwd || process.cwd()
  const timeout = Number(process.env.GUARD_STOP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  const opts = { cwd, encoding: 'utf8', timeout, windowsHide: true }
  const target = ['check-fast', 'check'].find((t) => run('make', ['-n', t], opts).status === 0)
  if (!target) return null
  const fp = fingerprint(cwd, run)
  const green = lastGreen(cwd)
  if (fp && fp === green.fp) return null
  // Only docs changed since the last green run: nothing to check, and nothing is marked green.
  const changed = changes(cwd, green.head, run)
  if (changed && docsOnly(changed.paths, changed.rules)) return null
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
    if (fp) markGreen(cwd, fp, run)
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
    if (input.terminationReason !== undefined && !input.hook_event_name) input.hook_event_name = 'Stop'
    if (input.conversationId && !input.session_id) input.session_id = input.conversationId
    if (input.workspacePaths?.[0] && !input.cwd) input.cwd = input.workspacePaths[0]
    const events = []
    const out = await stopCheck(input, spawnSync, { report: (attrs) => events.push(attrs) })
    // Codex rejects a Stop output with keys it does not know: it gets the top-level decision and reason only.
    const codex = harnessName() === 'codex'
    const antigravity = harnessName() === 'antigravity' || input.terminationReason !== undefined
    if (out) {
      if (antigravity) {
        process.stdout.write(JSON.stringify(out.decision === 'block' ? { decision: 'continue', reason: out.reason } : {}))
      } else if (codex && out.decision) {
        process.stdout.write(JSON.stringify({ decision: out.decision, reason: out.reason }))
      } else {
        process.stdout.write(JSON.stringify(out))
      }
    }
    for (const event of events) await emit(process.env, 'guard.stop', recordAttrs({ ...event, cmd_class: 'stop', session_id: input.session_id }, input.cwd || process.cwd(), harnessName()))
  } catch {
    // unreadable payload: let the agent stop
  }
}
