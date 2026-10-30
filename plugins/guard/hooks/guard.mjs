// Command hook for Claude Code, Copilot CLI and VS Code Copilot: one hooks.json, one script, every OS.
// Both harnesses send Claude's payload (snake_case, `hook_event_name`); Copilot maps the PascalCase events
// and reads `hookSpecificOutput.permissionDecision`. A hook is a fresh process, so per-session facts
// (loaded skills, rules already reminded) live in a JSON file under $CLAUDE_PLUGIN_DATA.
import { execFile } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { cpus, homedir, loadavg, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { analysis, branchFacts, cdDirs, cmdClass, codexRules, deniedBy, deniedDir, evaluateCommand, evaluateEdit, evaluateRouting, hostJudged, isHeavy, isRisky, nativeAsk, previewCommand, pureRead, refFacts, tagFacts, tagTargets, regenFacts, unattendedSet, withPreview, worktreeFacts } from '../core/engine.mjs'
import { cpuPercentFrom } from '../core/host.mjs'
import { commandWords, units } from '../core/shell.mjs'
import { emit } from '../core/otel.mjs'
import { rules } from '../core/rules.mjs'
import { pluginDataDir } from './data.mjs'
import { installedVersions, staleCheck } from './stale.mjs'
import { appendDecision, commandHash, harnessName, recordAttrs } from './telemetry.mjs'

// Claude Bash/PowerShell, Copilot bash/powershell, VS Code run_in_terminal. VS Code ignores matchers, so every
// tool call reaches this script and anything else passes untouched.
const SHELLS = new Set(['bash', 'powershell', 'run_in_terminal'])
// Edit and write tools across harnesses (Claude, Copilot CLI, VS Code, opencode, pi), for the `files` skill hints.
// VS Code's task tools run a command as well: `create_and_run_task` carries it (`task.command`, `task.args`),
// `run_task` names a task of `.vscode/tasks.json` by label (`id`, `type: label` or the label). Field names from VS
// Code's source (chatAgentTools `runTaskTool.ts`, `createAndRunTaskTool.ts`).
const TASKS = new Set(['run_task', 'create_and_run_task'])
const quoteArg = (a) => (/^[\w./@%+=:,~-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
const taskLine = (task) =>
  task && typeof task.command === 'string' ? [task.command, ...(Array.isArray(task.args) ? task.args.map((a) => quoteArg(String(typeof a === 'string' ? a : (a?.value ?? '')))) : [])].join(' ') : null
// The command a task tool runs, or null when it cannot be read.
export function taskCommand(tool, t = {}, cwd = '.') {
  if (tool === 'create_and_run_task') return taskLine(t.task)
  try {
    // tasks.json is JSONC: comments and trailing commas are dropped before parsing.
    const text = readFileSync(join(t.workspaceFolder || cwd || '.', '.vscode', 'tasks.json'), 'utf8')
    const json = JSON.parse(text.replace(/^\s*\/\/.*$|\/\*[\s\S]*?\*\//gm, '').replace(/,(\s*[}\]])/g, '$1'))
    const id = String(t.id ?? '')
    const label = id.indexOf(': ') > 0 ? id.slice(id.indexOf(': ') + 2) : id
    return taskLine(json.tasks?.find((x) => x?.label === label || x?.label === id))
  } catch {
    return null
  }
}

// Read tools: Claude Code `Read`, Copilot CLI `view`, VS Code `read_file`, opencode and pi `read`.
const READS = new Set(['read', 'view', 'read_file'])
// Shell commands that only print a file.
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'sed', 'get-content', 'gc', 'type'])
// Where installed or checked-out skills live: a plugin cache or install (Claude Code, Codex, Copilot CLI), user skill
// dirs (Claude Code, opencode, `.agents`), pi's packages, and a checkout's `plugins/<name>/skills`.
const SKILL_ROOT = /(?:[\\/]\.(?:claude|codex|copilot|pi)[\\/]|[\\/]\.config[\\/]opencode[\\/]|[\\/]\.agents[\\/]skills[\\/]|(?:^|[\\/])plugins[\\/](?:cache[\\/][\w.-]+[\\/])?[\w-]+[\\/](?:[\w.-]+[\\/])?skills[\\/])/
const bareSkill = (s) => String(s).split(':').pop()
// The skills whose SKILL.md is among `paths`, under a skill root.
const skillsRead = (paths) => paths.flatMap((p) => (SKILL_ROOT.test(p) ? [.../(?:^|[\\/])skills[\\/]([\w-]+)[\\/]SKILL\.md$/.exec(p)?.slice(1) ?? []] : []))
// The arguments of every reader in a shell command (`cat f`, `sed -n 1,200p f`; not `sed -i`), payloads included.
const readerArgs = (command) =>
  units(analysis(command)).flatMap(({ cmd }) => {
    const [name, ...args] = commandWords(cmd.words).map((w) => w.val)
    const reader = READERS.has(String(name ?? '').replace(/^.*[\\/]/, '').toLowerCase()) && !args.some((a) => /^(?:-i|-[a-zA-Z]*i\b|--in-place)/.test(a))
    return reader ? args : []
  })
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

// Per-session state: { reminded: string[], loaded: string[], unattended?: boolean }, kept as append-only facts in
// `sessions/<id>.jsonl`, one JSON line each (`{"loaded":"ship"}`, `{"reminded":"edit","agent":"a1"}`,
// `{"unattended":true}`). Parallel hooks each append their own lines with one O_APPEND write, which the OS keeps
// whole, so none is lost and no lock is needed. Skill loads and the unattended switch (the latest wins) count for the
// whole session, subagents included; reminders count per agent (`agent_id`, absent for the main agent), so a subagent
// gets its own hints, except the read and edit hints, which say the same to every agent and so come once per session.
// Without a session id nothing is kept.
const SESSION_HINTS = new Set(['read', 'edit'])
// Harness processes whose plugin versions a session file keeps. More means the hook's parent is no harness process
// but a shell started per call (#254): recording stops there, so the stale note stays silent and the file small.
const MAX_PROCESSES = 4
// `processId`: the harness process the facts belong to (the plugin versions it loaded).
export function sessionStore(dir, sessionId, agentId, processId) {
  const file = sessionId ? join(dir, 'sessions', `${String(sessionId).replace(/[^\w-]/g, '_')}.jsonl`) : null
  const agent = agentId ? String(agentId) : undefined
  let seen = { reminded: [], loaded: [] }
  return {
    load() {
      seen = { reminded: [], loaded: [], unattended: undefined, plugins: {}, processes: new Set() }
      if (!file) return { reminded: [], loaded: [], plugins: {} }
      const proc = String(processId ?? '')
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
        if (typeof fact.reminded === 'string' && (fact.agent === agent || SESSION_HINTS.has(fact.reminded) || fact.reminded.startsWith('stale:'))) seen.reminded.push(fact.reminded)
        if (typeof fact.unattended === 'boolean') seen.unattended = fact.unattended
        // The plugin versions this harness process loaded: the first record of each wins. A resumed or restarted session
        // keeps its id but is a new process, which loaded what was installed then.
        // The directory this process started in, which picks the plugin installs that apply to it.
        if (typeof fact.cwd === 'string' && String(fact.process ?? '') === proc) seen.cwd ??= fact.cwd
        // `guard.session` went out for this process.
        if (fact.announced === true && String(fact.process ?? '') === proc) seen.announced = true
        if (typeof fact.plugin === 'string' && typeof fact.version === 'string') {
          seen.processes.add(String(fact.process ?? ''))
          if (String(fact.process ?? '') === proc) seen.plugins[fact.plugin] ??= fact.version
        }
      }
      return { reminded: [...new Set(seen.reminded)], loaded: [...new Set(seen.loaded)], unattended: seen.unattended, plugins: { ...seen.plugins }, startCwd: seen.cwd, announced: seen.announced }
    },
    // Appends the facts `state` adds to what load() read.
    save(state) {
      if (!file) return
      const lines = [
        ...(state.announced && !seen.announced ? [JSON.stringify({ announced: true, process: processId })] : []),
        ...[...new Set(state.loaded)].filter((s) => !seen.loaded.includes(s)).map((s) => JSON.stringify({ loaded: s })),
        ...[...new Set(state.reminded)].filter((r) => !seen.reminded.includes(r)).map((r) => JSON.stringify({ reminded: r, agent })),
        ...(typeof state.unattended === 'boolean' && state.unattended !== seen.unattended ? [JSON.stringify({ unattended: state.unattended })] : []),
        ...(seen.processes.has(String(processId ?? '')) || seen.processes.size < MAX_PROCESSES
          ? [
              ...(typeof state.startCwd === 'string' && !seen.cwd ? [JSON.stringify({ cwd: state.startCwd, process: processId })] : []),
              ...Object.entries(state.plugins ?? {}).filter(([p]) => !(p in seen.plugins)).map(([plugin, version]) => JSON.stringify({ plugin, version, process: processId })),
            ]
          : []),
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
// `notice`: a line the user sees (`systemMessage`), for what only the user can act on.
const note = (context, notice) => ({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context }, ...(notice ? { systemMessage: notice } : {}) }) })

// Telemetry never holds a decision back: records are sent without waiting, and a command hook's process stays up
// until they are out, after its answer is written.
const fire = (deps, ...args) => {
  try {
    Promise.resolve(deps.emit?.(...args)).catch(() => {})
  } catch {
    // a failed record changes nothing
  }
}

// `promise`, or `fallback` once `ms` pass.
const within = (promise, ms, fallback) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      () => (clearTimeout(timer), resolve(fallback)),
    )
  })

// The hook's time budget (D2), under the harnesses' 30 s hook timeout: the slow lookups (worktrees, branches and
// PRs, ignored build output) get FACTS_MS, the blast-radius preview PREVIEW_MS. A lookup that runs out is dropped,
// the fast rules still apply, and a risky command whose safe case could not be shown asks.
const FACTS_MS = 20_000
const ALLOW_SAMPLE = 10
const PREVIEW_MS = 3_000

// Unattended: GUARD_UNATTENDED in the environment the harness was launched with, or set by a command in this session
// (`export GUARD_UNATTENDED=1`), which a hook cannot otherwise see: each hook is its own process. The command's own
// setting counts for itself; it is kept for the session only once the guard lets that command run.
const ON = /^(1|true|on)$/i

// The directories a command's `cd`s reach that exist, so a `cd x; rm -rf y` is followed only when `cd x` surely ran.
export function existingDirs(command, env, cwd) {
  const dirs = new Set()
  for (const d of cdDirs(command, env)) {
    if (!PLAIN_DIR.test(d)) continue
    try {
      if (statSync(resolve(cwd || '.', d)).isDirectory()) dirs.add(d)
    } catch {
      // missing: the cd may fail
    }
  }
  return dirs
}
const PLAIN_DIR = /^[\w.@%+=:,\\/~-]+$/

// The factory labels a run never touches, from `labels` in the nearest `.factory/config.yaml` above `cwd`, each else its default.
// Fails closed: a config that exists but cannot be read, or whose `labels` cannot be parsed, returns the defaults with
// `unsure` set and any names it can still find in `extra`, and the engine then denies every label change.
export function factoryLabels(cwd) {
  const defaults = { approval: rules.factory.approval, takeover: rules.factory.takeover }
  const keys = Object.keys(defaults)
  for (let dir = resolve(cwd || '.'); ; dir = dirname(dir)) {
    let text
    try {
      text = readFileSync(join(dir, '.factory', 'config.yaml'), 'utf8').replace(/\r/g, '')
    } catch (e) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') return { ...defaults, unsure: true, extra: [] }
    }
    if (text !== undefined) {
      if (!/^labels\b/m.test(text)) return defaults
      const block = text.match(/^labels:[ \t]*\n((?:[ \t]+.*(?:\n|$)|[ \t]*\n)*)/m)?.[1]
      const named = Object.fromEntries(keys.map((key) => {
        if (block === undefined) return [key, null]
        if (!new RegExp(`^[ \\t]+${key}[ \\t]*:`, 'm').test(block)) return [key, defaults[key]]
        const name = block.match(new RegExp(`^[ \\t]+${key}:[ \\t]*(?:"([^"]+)"|'([^']+)'|([^\\s#]+))`, 'm'))
        return [key, name ? (name[1] ?? name[2] ?? name[3]) : null]
      }))
      if (keys.every((key) => named[key] !== null)) return named
      const extra = [...text.matchAll(/\b(?:approval|takeover)[ \t]*:[ \t]*["']?([^\s"',}\]#]+)/g)].map((m) => m[1])
      return { ...defaults, unsure: true, extra }
    }
    if (dirname(dir) === dir) return defaults
  }
}

// What a factory run's shell must not write (rule `protected-path`): the globs of FACTORY_PROTECTED_PATHS (one per line,
// added to the rules' defaults; unset or empty adds none), the repo root (the nearest directory above `cwd` holding
// `.git`, else `cwd`) and `cwd`, with forward slashes.
export function protectFacts(env, cwd) {
  const extra = String(env?.FACTORY_PROTECTED_PATHS ?? '').split(/\r?\n/).map((g) => g.trim()).filter(Boolean)
  const at = resolve(cwd || '.')
  let root = at
  for (let dir = at; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      root = dir
      break
    }
    if (dirname(dir) === dir) break
  }
  const slash = (p) => p.replace(/\\/g, '/')
  return { extra, root: slash(root), cwd: slash(at) }
}

async function onShell(input, state, deps) {
  const command = String(input.tool_input?.command ?? '')
  if (!command) return {}
  const set = unattendedSet(command)
  const fromEnv = ON.test(deps.env?.GUARD_UNATTENDED ?? '')
  const unattended = fromEnv || (set ?? state.unattended) === true
  try {
    const host = isHeavy(command, rules) ? await deps.hostFacts(input.cwd) : {}
    // HOME resolves `~` and `$HOME` in paths (USERPROFILE on Windows).
    let unfinished = false
    const facts = { env: { TMPDIR: deps.env.TMPDIR, TEMP: deps.env.TEMP, TMP: deps.env.TMP, HOME: deps.env.HOME || deps.env.USERPROFILE } }
    facts.env.dirs = existingDirs(command, facts.env, input.cwd)
    if (isRisky(command, rules)) {
      // A lookup's own directory (a `cd` the engine followed) is relative to the call's cwd.
      const inCwd = (argv, cwd) => deps.run(argv, cwd == null ? input.cwd : resolve(input.cwd || '.', cwd))
      const gathered = await within(
        Promise.all([worktreeFacts(command, facts.env, rules, inCwd), branchFacts(command, rules, inCwd, facts.env), regenFacts(command, facts.env, rules, inCwd), refFacts(command, rules, inCwd, facts.env)]),
        deps.factsMs ?? FACTS_MS,
        null,
      )
      if (gathered) [facts.worktrees, facts.branches, facts.regenerable, facts.refs] = gathered
      else unfinished = true
    }
    // A `git tag -f`/`-d` of a tag no remote has is not a release (one `ls-remote` per remote, same budget).
    if (tagTargets(command, rules, facts.env).some((t) => !t.name.startsWith('<'))) {
      facts.tags = (await within(tagFacts(command, rules, (argv) => deps.run(argv, input.cwd), facts.env), deps.factsMs ?? FACTS_MS, null)) ?? {}
    }
    // The manager of the repo the denied command runs in (`cd <repo> && pip install x`), not just the cwd's.
    if (deniedBy(command, rules)?.when) {
      const dir = deniedDir(command, rules, facts.env)
      facts.python = deps.pythonManager(dir ? resolve(input.cwd || '.', dir) : input.cwd)
    }
    // Auto mode tells the agent to read and make small edits through the shell, so the read and edit hints would
    // contradict it: they are held back there, and still come once the session leaves auto mode.
    const held = input.permission_mode === 'auto' ? ['read', 'edit'].filter((r) => !state.reminded.includes(r)) : []
    const reminded = new Set([...state.reminded, ...held])
    const judged = hostJudged(command, rules, reminded)
    const d = evaluateCommand({ command, loadedSkills: new Set(state.loaded), state: { reminded }, host, readTool: deps.readTool ?? true, ...facts, factory: deps.env?.FACTORY_RUN_ID ? { ...factoryLabels(input.cwd), protect: protectFacts(deps.env, input.cwd) } : null, rules })
    state.reminded = [...reminded].filter((r) => !held.includes(r))
    if (unfinished && d.action !== 'allow') d.reason += '\nChecks unfinished: the worktree, branch and build-output lookups ran out of time, so a safe case could not be shown.'
    // Logged after the harness-specific transforms, so `action` is what happened: an ask that became a deny is a deny,
    // with `via` saying why (unattended, no-ask) or how the ask was made (native-ask: the harness's own prompt).
    const report = (action, via) => {
      appendDecision(deps.env, { decision: action, rule: d.rule, cmd_hash: commandHash(command) })
      fire(deps, 'guard.decision', { rule: d.rule, action, via, cmd_class: cmdClass(d.rule, command), tool: String(input.tool_name ?? ''), session_id: input.session_id, tool_use_id: input.tool_use_id, cmd_hash: commandHash(command), ...(d.rule === 'host' ? hostAttrs(host) : {}) }, input.cwd)
    }
    // Allows are sampled (one in ALLOW_SAMPLE, `sample_rate` on the record), so ask and deny rates have a denominator
    // without a record per shell call. An allow the host rule judged (hostJudged: heavy, not wrapped, no host deny yet
    // this session) is always sent, as rule `host` with the host facts it passed on, so "the host rule ran and let it
    // through" shows apart from "the host rule never ran"; other heavy allows are sampled like the rest. Never to
    // FACTORY_EVENTS_FILE, which counts denies and asks.
    const allowed = (via) => {
      if (!judged && (deps.random ?? Math.random)() * ALLOW_SAMPLE >= 1) return
      const sampled = judged ? { rule: 'host', sample_rate: 1, cmd_class: 'host', ...hostAttrs(host) } : { rule: d.rule, sample_rate: ALLOW_SAMPLE, cmd_class: cmdClass(null, command) }
      fire(deps, 'guard.decision', { action: 'allow', via, ...sampled, tool: String(input.tool_name ?? ''), session_id: input.session_id, tool_use_id: input.tool_use_id, cmd_hash: commandHash(command) }, input.cwd)
    }
    if (d.remind) fire(deps, 'guard.reminder', { rule: d.rule, cmd_class: cmdClass(d.rule, command), tool: String(input.tool_name ?? ''), session_id: input.session_id, tool_use_id: input.tool_use_id }, input.cwd)
    if (d.action === 'deny') {
      report('deny', d.split ? 'split' : undefined)
      return preToolUse('deny', d.reason)
    }
    // Unattended run (GUARD_UNATTENDED=1): nobody can answer an ask, so it becomes a deny and the agent picks another way.
    if (d.action === 'ask' && unattended) {
      report('deny', 'unattended')
      const source = fromEnv ? '' : ' It was switched on by a command in this session; `export GUARD_UNATTENDED=0` turns it off.'
      return preToolUse('deny', `${d.reason}\nUnattended run (GUARD_UNATTENDED): nobody can confirm this, so the command was not run. Pick another approach, or leave it for the user.${source}`)
    }
    // Codex and opencode hooks cannot ask: the harness's own prompt rule asks for the plain forms (`deps.nativeAsk`),
    // anything else is denied and the user runs it.
    if (d.action === 'ask' && deps.noAsk) {
      if (await deps.nativeAsk?.(command, d.rule, input)) {
        report('ask', 'native-ask')
        return {}
      }
      report('deny', 'no-ask')
      return preToolUse('deny', `${d.reason}\nThis harness cannot ask for confirmation for this form, so the command was not run: ask the user to run it.`)
    }
    if (d.action === 'ask') {
      report('ask')
      const argv = previewCommand(d.rule, command, rules, facts.env)
      return preToolUse('ask', argv ? withPreview(d.reason, await within(Promise.resolve(deps.run(argv, input.cwd)), deps.previewMs ?? PREVIEW_MS, '')) : d.reason)
    }
    if (set !== null) state.unattended = set
    // A plain read of non-secret files never waits on the harness's prompt (Claude Code, Copilot CLI, VS Code; Codex
    // and the in-process harnesses do not prompt for it), inside a project's work tree only.
    if (!deps.noAsk && pureRead(command) && inWorkTree(input.cwd, deps.env)) {
      allowed('read')
      return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'guard: a plain read of non-secret files', ...(d.context ? { additionalContext: d.context } : {}) } }) }
    }
    allowed()
    return d.context ? note(d.context) : {}
  } catch (err) {
    // Fail open for reminders, closed for risky commands.
    if (isRisky(command, rules)) {
      appendDecision(deps.env, { decision: 'deny', rule: 'guard-error', cmd_hash: commandHash(command) })
      fire(deps, 'guard.decision', { rule: 'guard-error', action: 'deny', cmd_class: 'guard-error', tool: String(input.tool_name ?? ''), session_id: input.session_id, tool_use_id: input.tool_use_id, cmd_hash: commandHash(command) }, input.cwd)
    }
    return isRisky(command, rules) ? preToolUse('deny', `The command guard failed, so this risky command was not run: ${err?.message ?? err}`) : {}
  }
}

async function onEdit(input, state, deps) {
  const t = input.tool_input ?? {}
  const reminded = new Set(state.reminded)
  const d = evaluateEdit({ path: t.file_path ?? t.path ?? t.filePath, loadedSkills: new Set(state.loaded), state: { reminded }, rules })
  state.reminded = [...reminded]
  if (!d.remind) return {}
  fire(deps, 'guard.reminder', { rule: d.rule, cmd_class: 'hint', tool: String(input.tool_name ?? ''), session_id: input.session_id, tool_use_id: input.tool_use_id }, input.cwd)
  return note(d.context)
}

// A subagent spawn (Claude Code `Agent`/`Task`, Copilot CLI `task`, Codex `spawn_agent`, VS Code `runSubagent`) that
// bypasses the typed agents: a hint, never a deny.
function onSpawn(input, state, deps) {
  const t = input.tool_input ?? {}
  const reminded = new Set(state.reminded)
  const d = evaluateRouting({ type: t.subagent_type ?? t.agent_type ?? t.agentName, model: t.model, effort: t.effort, tool: String(input.tool_name ?? '').toLowerCase(), state: { reminded }, rules })
  state.reminded = [...reminded]
  if (!d.remind) return {}
  fire(deps, 'guard.reminder', { rule: d.rule, cmd_class: 'routing', tool: String(input.tool_name ?? ''), session_id: input.session_id, tool_use_id: input.tool_use_id }, input.cwd)
  return note(d.context)
}

// Plugins updated since the session loaded them: one note per newer version, next to a call that has no decision
// (a decision's reason is the agent's to read alone), so the next call carries it instead.
function onStale(input, state, deps, out) {
  const decided = out.stdout && JSON.parse(out.stdout).hookSpecificOutput?.permissionDecision
  const reminded = state.reminded.filter((r) => r.startsWith('stale:')).map((r) => r.slice(6))
  // Scoped by the directory the session started in: moving into another project mid-session loads nothing new.
  state.startCwd ??= typeof input.cwd === 'string' ? input.cwd : undefined
  const s = staleCheck({ root: deps.pluginRoot, cwd: state.startCwd, loaded: state.plugins, reminded, harness: deps.harness })
  state.plugins = s.loaded
  if (!s.context || decided) return out
  state.reminded.push(...s.remind.map((r) => `stale:${r}`))
  fire(deps, 'guard.reminder', { rule: 'stale-plugins', cmd_class: 'hint', tool: String(input.tool_name ?? ''), session_id: input.session_id, tool_use_id: input.tool_use_id }, input.cwd)
  const context = out.stdout ? JSON.parse(out.stdout).hookSpecificOutput?.additionalContext : null
  return note(context ? `${context}\n${s.context}` : s.context, s.notice)
}

// Whether `cwd` is inside a git work tree other than the home directory's: a relative read there is project files.
// From `$HOME`, or a dotfiles repo at `$HOME`, `cat .codex/auth.json` is a secret the path rules may not know (#208).
export function inWorkTree(cwd, env = {}, platform = process.platform) {
  if (typeof cwd !== 'string' || !cwd) return false
  const home = resolve(env.HOME || env.USERPROFILE || homedir())
  // Windows paths are case-insensitive: `c:\Users\me` is still the home directory.
  const isHome = (dir) => (platform === 'win32' ? dir.toLowerCase() === home.toLowerCase() : dir === home)
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return !isHome(dir)
    if (dir === dirname(dir) || isHome(dir)) return false
  }
}

// One hook event in, { stdout?, stderr?, code? } out. `deps` is injected so tests run without a host.
export async function handle(input, deps) {
  // A command hook's parent is the harness process (one per session run: a resume or restart is a new one).
  // A subagent keeps its own reminders (`agent_id`) and shares the session's skills: Claude Code and Codex send the
  // parent's `session_id`, Copilot CLI the subagent's own with `parent_agent_id` naming the parent session.
  const session = input.agent_id && input.parent_agent_id ? input.parent_agent_id : input.session_id
  const store = sessionStore(deps.dataDir, session, input.agent_id, deps.processId ?? process.ppid)
  const state = { reminded: [], loaded: [], plugins: {}, ...store.load() }
  const loadedBefore = [...state.loaded]
  const event = input.hook_event_name
  let out = {}

  if (event === 'SessionEnd') {
    store.sweep()
    return out
  }
  if (event === 'SessionStart') {
    // Joins cost telemetry to plugin versions by session: one record per session id and harness process (a compact
    // keeps both; a resume is a new process and may run newer versions). Nothing on stdout: it would reach the model.
    if (!state.announced) {
      try {
        const { self, installed } = installedVersions(deps.pluginRoot, input.cwd)
        if (self.versioned && self.version) installed[self.name] = self.version
        const attrs = Object.fromEntries(Object.entries(installed).map(([p, v]) => [`plugin_version_${p.replace(/[^a-z0-9]/g, '_')}`, v]))
        fire(deps, 'guard.session', { session_id: input.session_id, source: input.source, ...attrs }, input.cwd)
        state.announced = true
      } catch {
        // a missing record changes nothing
      }
    }
  } else if (event === 'UserPromptSubmit') {
    // A skill the user named counts as loaded: `/name` (Claude, Copilot, opencode), `/skill:name` (pi), `$name` (Codex).
    const m = /^\s*(?:\/(?:skill:)?|\$)([\w:-]+)/.exec(input.prompt ?? '')
    if (m) state.loaded.push(m[1])
  } else if (event === 'PreToolUse') {
    const tool = String(input.tool_name ?? '').toLowerCase()
    const t = input.tool_input ?? {}
    // Codex and pi have no skill tool: the agent reads SKILL.md with a read tool or a shell reader, which counts too
    // (owner decision D8), only under a skill root; writing one never counts.
    if (READS.has(tool)) state.loaded.push(...skillsRead([t.file_path ?? t.path ?? t.filePath ?? '']))
    else if (SHELLS.has(tool)) state.loaded.push(...skillsRead(readerArgs(String(t.command ?? ''))))
    if (tool === 'skill' && (t.skill || t.name)) state.loaded.push(String(t.skill || t.name))
    else if (SHELLS.has(tool)) out = await onShell(input, state, deps)
    else if (EDITS.has(tool)) out = await onEdit(input, state, deps)
    else if (rules.routing.tools.includes(tool)) out = onSpawn(input, state, deps)
    else if (TASKS.has(tool)) {
      const command = taskCommand(tool, t, input.cwd)
      if (command) out = await onShell({ ...input, tool_input: { command } }, state, deps)
      else if (tool === 'run_task') out = note(`The guard could not read the command of task "${t.id ?? ''}" in .vscode/tasks.json, so it did not check it. If it deletes, force-pushes or reads secrets, confirm with the user first.`)
    }
    try {
      out = onStale(input, state, deps, out)
    } catch {
      // the note is a nicety: a decision already made stands
    }
  }
  // One guard.skill per skill and session, in every harness: the same skill-usage figure everywhere. Names are kept
  // bare (`dev-tools:ship` is `ship`), so a skill loaded both ways counts once.
  state.loaded = state.loaded.map(bareSkill)
  const before = new Set(loadedBefore.map(bareSkill))
  const known = deps.knownSkills ?? knownSkills()
  for (const skill of new Set(state.loaded)) {
    const name = skill.split(':').pop()
    if (!before.has(skill) && (event !== 'UserPromptSubmit' || known.has(name))) fire(deps, 'guard.skill', { skill: name, cmd_class: 'skill', via: event === 'UserPromptSubmit' ? 'prompt' : 'tool', session_id: input.session_id }, input.cwd)
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
// The last TAIL_BYTES of a file, from its first whole line: a rollout grows to hundreds of MB, and the latest
// `turn_context` is near its end (older than that, the reviewer is unknown and the command is denied).
const TAIL_BYTES = 256 * 1024
export function tail(path, bytes = TAIL_BYTES) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    return start ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    closeSync(fd)
  }
}
export function codexAsks(env, transcriptPath) {
  try {
    const home = env.CODEX_HOME || join(homedir(), '.codex')
    if (readFileSync(join(home, 'rules', CODEX_RULES), 'utf8') !== codexRules(rules)) return null
    if (codexReviewer(tail(transcriptPath)) !== 'user') return null
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
  if (!input || typeof input !== 'object' || Array.isArray(input)) return // no harness sends one; a throw would deny
  // argv[2] names the event when a harness leaves hook_event_name out.
  if (!input.hook_event_name && process.argv[2]) input.hook_event_name = process.argv[2]
  const dataDir = pluginDataDir()
  // Never exit non-zero: Copilot denies a preToolUse whose hook fails. The risky path fails closed inside onShell.
  // `--no-ask` comes from the Codex hooks file (.generated/codex/hooks.json), which build_agents.py generates.
  const noAsk = process.argv.includes('--no-ask')
  // Codex (`--no-ask`) is the one harness without a file-read tool.
  const out = await handle(input, { dataDir, harness: noAsk ? 'codex' : harnessName(), env: process.env, hostFacts, run, pythonManager, noAsk, readTool: !noAsk, nativeAsk: noAsk ? (command, rule) => codexAsks(process.env, input.transcript_path)?.(command, rule) ?? false : null, emit: (event, attrs, cwd) => new Promise((r) => setImmediate(r)).then(() => emit(process.env, event, recordAttrs(attrs, cwd, noAsk ? 'codex' : harnessName()))) }).catch(() => ({}))
  if (out.stdout) process.stdout.write(out.stdout)
  if (out.stderr) process.stderr.write(out.stderr)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
