// Command hook for Claude Code, Copilot CLI and VS Code Copilot: one hooks.json, one script, every OS.
// Both harnesses send Claude's payload (snake_case, `hook_event_name`); Copilot maps the PascalCase events
// and reads `hookSpecificOutput.permissionDecision`. A hook is a fresh process, so per-session facts
// (loaded skills, rules already reminded) live in a JSON file under $CLAUDE_PLUGIN_DATA.
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { cpus, homedir, loadavg, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { branchFacts, codexRules, deniedBy, deniedDir, evaluateCommand, evaluateEdit, isHeavy, isRisky, nativeAsk, previewCommand, regenFacts, withPreview, worktreeFacts } from '../core/engine.mjs'
import { cpuPercentFrom } from '../core/host.mjs'
import { emit } from '../core/otel.mjs'
import { rules } from '../core/rules.mjs'
import { pluginDataDir } from './data.mjs'
import { commandHash, harnessName, recordAttrs } from './telemetry.mjs'

// Claude Bash/PowerShell, Copilot bash/powershell, VS Code run_in_terminal. VS Code ignores matchers, so every
// tool call reaches this script and anything else passes untouched.
const SHELLS = new Set(['bash', 'powershell', 'run_in_terminal'])
// Edit and write tools across harnesses (Claude, Copilot CLI, VS Code, opencode, pi), for the `files` skill hints.
const EDITS = new Set(['edit', 'write', 'multiedit', 'create', 'create_file', 'replace_string_in_file', 'insert_edit_into_file'])
const WEEK_MS = 7 * 24 * 3600 * 1000

// This marketplace's skill names, from the plugins beside this one: `plugins/<p>/skills/<s>` in a checkout,
// `<p>/<version>/skills/<s>` in a harness's plugin cache. A typed `/name` counts as a skill load only for these,
// so built-in commands (`/model`, `/clear`) stay out of guard.skill.
export function knownSkills(here = dirname(fileURLToPath(import.meta.url))) {
  const names = new Set()
  const ls = (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  const plugins = resolve(here, '..', '..')
  if (existsSync(join(plugins, 'guard', 'core'))) {
    for (const p of ls(plugins)) for (const s of ls(join(plugins, p, 'skills'))) names.add(s)
    return names
  }
  const cache = resolve(here, '..', '..', '..')
  for (const p of ls(cache)) for (const v of ls(join(cache, p))) for (const s of ls(join(cache, p, v, 'skills'))) names.add(s)
  return names
}

// Per-session state: { reminded: string[], loaded: string[] }, kept as append-only facts in `sessions/<id>.jsonl`,
// one JSON line each (`{"loaded":"ship"}`, `{"reminded":"edit","agent":"a1"}`). Parallel hooks each append their
// own lines with one O_APPEND write, which the OS keeps whole, so none is lost and no lock is needed. Skill loads
// count for the whole session, subagents included; reminders count per agent (`agent_id`, absent for the main
// agent), so a subagent gets its own hints. Without a session id nothing is kept.
export function sessionStore(dir, sessionId, agentId) {
  const file = sessionId ? join(dir, 'sessions', `${String(sessionId).replace(/[^\w-]/g, '_')}.jsonl`) : null
  const agent = agentId ? String(agentId) : undefined
  let seen = { reminded: [], loaded: [] }
  return {
    load() {
      seen = { reminded: [], loaded: [] }
      if (!file) return { reminded: [], loaded: [] }
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        // no facts yet
      }
      for (const line of text.split('\n')) {
        let fact
        try {
          fact = JSON.parse(line)
        } catch {
          continue
        }
        if (typeof fact.loaded === 'string') seen.loaded.push(fact.loaded)
        if (typeof fact.reminded === 'string' && fact.agent === agent) seen.reminded.push(fact.reminded)
      }
      return { reminded: [...new Set(seen.reminded)], loaded: [...new Set(seen.loaded)] }
    },
    // Appends the facts `state` adds to what load() read.
    save(state) {
      if (!file) return
      const lines = [
        ...[...new Set(state.loaded)].filter((s) => !seen.loaded.includes(s)).map((s) => JSON.stringify({ loaded: s })),
        ...[...new Set(state.reminded)].filter((r) => !seen.reminded.includes(r)).map((r) => JSON.stringify({ reminded: r, agent })),
      ]
      if (!lines.length) return
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      appendFileSync(file, lines.join('\n') + '\n')
    },
    // Drop files of sessions idle for a week. Not this session's own: a resumed session keeps its id, and
    // forgetting its loaded skills denied every skill rule again after each resume.
    sweep() {
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

// The host facts behind a host deny: what the caps were compared with.
const hostAttrs = (host) => ({ load1: host.load1, cpu_percent: host.cpuPercent, free_gb: host.freeGb })

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
    // HOME resolves `~` and `$HOME` in paths (USERPROFILE on Windows).
    const facts = { env: { TMPDIR: deps.env.TMPDIR, TEMP: deps.env.TEMP, TMP: deps.env.TMP, HOME: deps.env.HOME || deps.env.USERPROFILE } }
    if (isRisky(command, rules)) {
      const inCwd = (argv, cwd) => deps.run(argv, cwd ?? input.cwd)
      ;[facts.worktrees, facts.branches, facts.regenerable] = await Promise.all([
        worktreeFacts(command, facts.env, rules, inCwd),
        branchFacts(command, rules, inCwd, facts.env),
        regenFacts(command, facts.env, rules, inCwd),
      ])
    }
    // The manager of the repo the denied command runs in (`cd <repo> && pip install x`), not just the cwd's.
    if (deniedBy(command, rules)?.when) {
      const dir = deniedDir(command, rules, facts.env)
      facts.python = deps.pythonManager(dir ? resolve(input.cwd || '.', dir) : input.cwd)
    }
    const reminded = new Set(state.reminded)
    const d = evaluateCommand({ command, loadedSkills: new Set(state.loaded), state: { reminded }, host, readTool: deps.readTool ?? true, ...facts, rules })
    state.reminded = [...reminded]
    // Logged after the harness-specific transforms, so `action` is what happened: an ask that became a deny is a deny,
    // with `via` saying why (unattended, no-ask) or how the ask was made (native-ask: the harness's own prompt).
    const report = (action, via) =>
      deps.emit?.('guard.decision', { rule: d.rule, action, via, tool: String(input.tool_name ?? ''), session_id: input.session_id, tool_use_id: input.tool_use_id, cmd_hash: commandHash(command), ...(d.rule === 'host' ? hostAttrs(host) : {}) }, input.cwd)
    if (d.remind) await deps.emit?.('guard.reminder', { rule: d.rule, tool: String(input.tool_name ?? ''), session_id: input.session_id, tool_use_id: input.tool_use_id }, input.cwd)
    if (d.action === 'deny') {
      await report('deny', d.split ? 'split' : undefined)
      return preToolUse('deny', d.reason)
    }
    // Unattended run (GUARD_UNATTENDED=1): nobody can answer an ask, so it becomes a deny and the agent picks another way.
    if (d.action === 'ask' && /^(1|true|on)$/i.test(deps.env?.GUARD_UNATTENDED ?? '')) {
      await report('deny', 'unattended')
      return preToolUse('deny', `${d.reason}\nUnattended run (GUARD_UNATTENDED): nobody can confirm this, so the command was not run. Pick another approach, or leave it for the user.`)
    }
    // Codex and opencode hooks cannot ask: the harness's own prompt rule asks for the plain forms (`deps.nativeAsk`),
    // anything else is denied and the user runs it.
    if (d.action === 'ask' && deps.noAsk) {
      if (await deps.nativeAsk?.(command, d.rule, input)) {
        await report('ask', 'native-ask')
        return {}
      }
      await report('deny', 'no-ask')
      return preToolUse('deny', `${d.reason}\nThis harness cannot ask for confirmation for this form, so the command was not run: ask the user to run it.`)
    }
    if (d.action === 'ask') {
      await report('ask')
      const argv = previewCommand(d.rule, command, rules, facts.env)
      return preToolUse('ask', argv ? withPreview(d.reason, await deps.run(argv, input.cwd).catch(() => '')) : d.reason)
    }
    return d.context ? note(d.context) : {}
  } catch (err) {
    // Fail open for reminders, closed for risky commands.
    if (isRisky(command, rules)) await deps.emit?.('guard.decision', { rule: 'guard-error', action: 'deny', tool: String(input.tool_name ?? ''), session_id: input.session_id, tool_use_id: input.tool_use_id, cmd_hash: commandHash(command) }, input.cwd)
    return isRisky(command, rules) ? preToolUse('deny', `The command guard failed, so this risky command was not run: ${err?.message ?? err}`) : {}
  }
}

async function onEdit(input, state, deps) {
  const t = input.tool_input ?? {}
  const reminded = new Set(state.reminded)
  const d = evaluateEdit({ path: t.file_path ?? t.path ?? t.filePath, loadedSkills: new Set(state.loaded), state: { reminded }, rules })
  state.reminded = [...reminded]
  if (!d.remind) return {}
  await deps.emit?.('guard.reminder', { rule: d.rule, tool: String(input.tool_name ?? ''), session_id: input.session_id, tool_use_id: input.tool_use_id }, input.cwd)
  return note(d.context)
}

// One hook event in, { stdout?, stderr?, code? } out. `deps` is injected so tests run without a host.
export async function handle(input, deps) {
  const store = sessionStore(deps.dataDir, input.session_id, input.agent_id)
  const state = { reminded: [], loaded: [], ...store.load() }
  const loadedBefore = [...state.loaded]
  const event = input.hook_event_name
  let out = {}

  if (event === 'SessionEnd') {
    store.sweep()
    return out
  }
  if (event === 'UserPromptSubmit') {
    // A skill the user named counts as loaded: `/name` (Claude, Copilot, opencode), `/skill:name` (pi), `$name` (Codex).
    const m = /^\s*(?:\/(?:skill:)?|\$)([\w:-]+)/.exec(input.prompt ?? '')
    if (m) state.loaded.push(m[1])
  } else if (event === 'PreToolUse') {
    const tool = String(input.tool_name ?? '').toLowerCase()
    const t = input.tool_input ?? {}
    // Codex and pi have no skill tool: the agent reads SKILL.md with a shell or read tool, which counts too.
    for (const m of `${t.command ?? ''} ${t.file_path ?? t.path ?? t.filePath ?? ''}`.matchAll(/skills[\\/]([\w-]+)[\\/]SKILL\.md/g)) state.loaded.push(m[1])
    if (tool === 'skill' && (t.skill || t.name)) state.loaded.push(String(t.skill || t.name))
    else if (SHELLS.has(tool)) out = await onShell(input, state, deps)
    else if (EDITS.has(tool)) out = await onEdit(input, state, deps)
  }
  // One guard.skill per skill and session, in every harness: the same skill-usage figure everywhere.
  const before = new Set(loadedBefore)
  const known = deps.knownSkills ?? knownSkills()
  for (const skill of new Set(state.loaded)) {
    const name = skill.split(':').pop()
    if (!before.has(skill) && (event !== 'UserPromptSubmit' || known.has(name))) await deps.emit?.('guard.skill', { skill: name, via: event === 'UserPromptSubmit' ? 'prompt' : 'tool', session_id: input.session_id }, input.cwd)
  }
  state.loaded = [...new Set(state.loaded)]
  try {
    store.save(state)
  } catch {
    // unwritable data dir: the decision still stands, a reminder may repeat
  }
  return out
}

// Codex asks through the prompt rules `make install HARNESS=codex` writes. Only when the installed file is this
// version's (a stale one may miss a prefix) does the guard leave a covered risky command to Codex.
// The prompt must reach a human: the session's effective `approvals_reviewer` (config, profile, `-c`,
// `--approve-for-me`) is in the rollout's last `turn_context`; anything but "user", or no record, denies.
export const CODEX_RULES = 'giocaizzi-guard.rules'
export function codexReviewer(transcript) {
  const ctx = transcript.split('\n').filter((l) => l.includes('"turn_context"')).pop()
  return ctx ? JSON.parse(ctx).payload?.approvals_reviewer : undefined
}
export function codexAsks(env, transcriptPath) {
  try {
    const home = env.CODEX_HOME || join(homedir(), '.codex')
    if (readFileSync(join(home, 'rules', CODEX_RULES), 'utf8') !== codexRules(rules)) return null
    if (codexReviewer(readFileSync(transcriptPath, 'utf8')) !== 'user') return null
    return (command, rule) => nativeAsk(command, rule, rules)
  } catch {
    return null
  }
}


async function main() {
  let input = {}
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return // unreadable payload: nothing to judge
  }
  // argv[2] names the event when a harness leaves hook_event_name out.
  if (!input.hook_event_name && process.argv[2]) input.hook_event_name = process.argv[2]
  const dataDir = pluginDataDir()
  // Never exit non-zero: Copilot denies a preToolUse whose hook fails. The risky path fails closed inside onShell.
  // `--no-ask` comes from the Codex hooks file (.generated/codex/hooks.json), which build_agents.py generates.
  const noAsk = process.argv.includes('--no-ask')
  // Codex (`--no-ask`) is the one harness without a file-read tool.
  const out = await handle(input, { dataDir, env: process.env, hostFacts, run, pythonManager, noAsk, readTool: !noAsk, nativeAsk: noAsk ? codexAsks(process.env, input.transcript_path) : null, emit: (event, attrs, cwd) => emit(process.env, event, recordAttrs(attrs, cwd, noAsk ? 'codex' : harnessName())) }).catch(() => ({}))
  if (out.stdout) process.stdout.write(out.stdout)
  if (out.stderr) process.stderr.write(out.stderr)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
