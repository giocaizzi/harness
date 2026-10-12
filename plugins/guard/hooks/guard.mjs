// Command hook for Claude Code, Copilot CLI and VS Code Copilot: one hooks.json, one script, every OS.
// Both harnesses send Claude's payload (snake_case, `hook_event_name`); Copilot maps the PascalCase events
// and reads `hookSpecificOutput.permissionDecision`. A hook is a fresh process, so per-session facts
// (loaded skills, rules already reminded) live in a JSON file under $CLAUDE_PLUGIN_DATA.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { cpus, loadavg, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deniedBy, evaluateCommand, isHeavy, isRisky, previewCommand, withPreview, worktreeFacts } from '../core/engine.mjs'
import { cpuPercentFrom } from '../core/host.mjs'
import { emit } from '../core/otel.mjs'
import { rules } from '../core/rules.mjs'

// Claude Bash/PowerShell, Copilot bash/powershell, VS Code run_in_terminal. VS Code ignores matchers, so every
// tool call reaches this script and anything else passes untouched.
const SHELLS = new Set(['bash', 'powershell', 'run_in_terminal'])
const WEEK_MS = 7 * 24 * 3600 * 1000

// Per-session state: { reminded: string[], loaded: string[] }.
// ponytail: read-modify-write without a lock; parallel tool calls can lose a write (a reminder repeats once).
export function sessionStore(dir, sessionId) {
  const file = join(dir, 'sessions', `${String(sessionId || 'default').replace(/[^\w-]/g, '_')}.json`)
  return {
    load() {
      try {
        return JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return {}
      }
    },
    save(state) {
      mkdirSync(join(dir, 'sessions'), { recursive: true })
      writeFileSync(file, JSON.stringify(state))
    },
    // Drop this session's file and any left behind by sessions that never ended cleanly.
    drop() {
      rmSync(file, { force: true })
      const sessions = join(dir, 'sessions')
      try {
        for (const f of readdirSync(sessions)) if (Date.now() - statSync(join(sessions, f)).mtimeMs > WEEK_MS) rmSync(join(sessions, f), { force: true })
      } catch {
        // no sessions dir yet
      }
    },
  }
}

// Load average on Unix, cpu percent on Windows (sampled), free disk everywhere.
export async function hostFacts(cwd) {
  try {
    const fs = await statfs(cwd || '.')
    const freeGb = Math.round((fs.bavail * fs.bsize) / 1073741824)
    if (platform() !== 'win32') return { load1: Math.round(loadavg()[0] * 100) / 100, freeGb }
    const before = cpus()
    await new Promise((r) => setTimeout(r, 300))
    return { cpuPercent: cpuPercentFrom(before, cpus()), freeGb }
  } catch {
    return {}
  }
}

// The Python manager of the project around cwd, from the nearest directory (up to the repo root) with a marker:
// 'uv' (uv.lock, or a pyproject.toml that is neither Poetry nor a requirements-only setup), 'poetry', 'pipenv', 'pip';
// null when there is no Python project. Plain fs calls, so it behaves the same on every OS.
export function pythonManager(cwd) {
  try {
    for (let dir = resolve(cwd || '.'); ; dir = dirname(dir)) {
      const has = (f) => existsSync(join(dir, f))
      const requirements = () => existsSync(dir) && readdirSync(dir).some((f) => /^requirements.*\.txt$/i.test(f))
      if (has('uv.lock')) return 'uv'
      if (has('poetry.lock')) return 'poetry'
      if (has('Pipfile.lock') || has('Pipfile')) return 'pipenv'
      if (has('pyproject.toml')) {
        const toml = readFileSync(join(dir, 'pyproject.toml'), 'utf8')
        if (/^\[tool\.poetry\]/m.test(toml)) return 'poetry'
        return !/^\[project\]/m.test(toml) && requirements() ? 'pip' : 'uv'
      }
      if (requirements()) return 'pip'
      if (has('.git') || dirname(dir) === dir) return null
    }
  } catch {
    return null
  }
}

// Blast-radius previews and worktree git checks: argv only (no shell), short timeout, null on failure.
export const run = (argv, cwd) =>
  new Promise((resolve) => execFile(argv[0], argv.slice(1), { cwd, timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout)))

const preToolUse = (decision, reason) => ({
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }),
})
// No decision: the harness's normal permission flow runs, the note reaches the agent next to the tool result.
const note = (context) => ({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }) })

async function onShell(input, state, deps) {
  const command = String(input.tool_input?.command ?? '')
  if (!command) return {}
  try {
    const host = isHeavy(command, rules) ? await deps.hostFacts(input.cwd) : {}
    const facts = {}
    if (isRisky(command, rules)) {
      facts.env = { TMPDIR: deps.env.TMPDIR, TEMP: deps.env.TEMP, TMP: deps.env.TMP }
      facts.worktrees = await worktreeFacts(command, facts.env, rules, (argv, cwd) => deps.run(argv, cwd ?? input.cwd))
    }
    if (deniedBy(command, rules)?.when) facts.python = deps.pythonManager(input.cwd)
    const reminded = new Set(state.reminded)
    const d = evaluateCommand({ command, loadedSkills: new Set(state.loaded), state: { reminded }, host, ...facts, rules })
    state.reminded = [...reminded]
    if (d.action === 'deny' || d.action === 'ask') await deps.emit?.('guard.decision', { rule: d.rule, action: d.action, tool: String(input.tool_name ?? ''), session_id: input.session_id })
    if (d.action === 'deny') return preToolUse('deny', d.reason)
    if (d.action === 'ask') {
      const argv = previewCommand(d.rule, command)
      return preToolUse('ask', argv ? withPreview(d.reason, await deps.run(argv, input.cwd).catch(() => '')) : d.reason)
    }
    return d.context ? note(d.context) : {}
  } catch (err) {
    // Fail open for reminders, closed for risky commands.
    if (isRisky(command, rules)) await deps.emit?.('guard.decision', { rule: 'guard-error', action: 'deny', tool: String(input.tool_name ?? ''), session_id: input.session_id })
    return isRisky(command, rules) ? preToolUse('deny', `The command guard failed, so this risky command was not run: ${err?.message ?? err}`) : {}
  }
}

// One hook event in, { stdout?, stderr?, code? } out. `deps` is injected so tests run without a host.
export async function handle(input, deps) {
  const store = sessionStore(deps.dataDir, input.session_id)
  const state = { reminded: [], loaded: [], ...store.load() }
  const event = input.hook_event_name
  let out = {}

  if (event === 'SessionEnd') {
    store.drop()
    return out
  }
  if (event === 'UserPromptSubmit') {
    // A slash command the user typed counts as the skill having been loaded.
    const m = /^\s*\/([\w:-]+)/.exec(input.prompt ?? '')
    if (m) state.loaded.push(m[1])
  } else if (event === 'PreToolUse') {
    const tool = String(input.tool_name ?? '').toLowerCase()
    if (tool === 'skill' && input.tool_input?.skill) state.loaded.push(String(input.tool_input.skill))
    else if (SHELLS.has(tool)) out = await onShell(input, state, deps)
  }
  state.loaded = [...new Set(state.loaded)]
  try {
    store.save(state)
  } catch {
    // unwritable data dir: the decision still stands, a reminder may repeat
  }
  return out
}

// Which harness runs the hook, from the data dir variable each one sets.
const harness = () => (process.env.CLAUDE_PLUGIN_DATA ? 'claude' : process.env.COPILOT_PLUGIN_DATA ? 'copilot' : 'other')

async function main() {
  let input = {}
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return // unreadable payload: nothing to judge
  }
  // argv[2] names the event when a harness leaves hook_event_name out.
  if (!input.hook_event_name && process.argv[2]) input.hook_event_name = process.argv[2]
  const dataDir = process.env.CLAUDE_PLUGIN_DATA || process.env.COPILOT_PLUGIN_DATA || join(tmpdir(), 'guard-plugin')
  // Never exit non-zero: Copilot denies a preToolUse whose hook fails. The risky path fails closed inside onShell.
  const out = await handle(input, { dataDir, env: process.env, hostFacts, run, pythonManager, emit: (event, attrs) => emit(process.env, event, { ...attrs, harness: harness() }) }).catch(() => ({}))
  if (out.stdout) process.stdout.write(out.stdout)
  if (out.stderr) process.stderr.write(out.stderr)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
