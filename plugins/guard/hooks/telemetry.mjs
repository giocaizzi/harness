// Attributes every guard record carries: which harness, which guard version, which repo. Never the command text:
// a command is reported as a short hash of its normalised form, enough to count repeats without its content.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { otelEnabled } from '../core/otel.mjs'

// `--harness=<name>` (the Codex hooks file passes `--harness=codex`) wins; else the data dir variable each harness
// sets: Claude Code sets CLAUDE_PLUGIN_DATA, Copilot CLI COPILOT_PLUGIN_DATA, VS Code only CLAUDE_PLUGIN_ROOT.
export function harnessName(argv = process.argv, env = process.env) {
  const flag = argv.find((a) => a.startsWith('--harness='))
  if (flag) return flag.slice('--harness='.length)
  if (env.CLAUDE_PLUGIN_DATA) return 'claude'
  if (env.COPILOT_PLUGIN_DATA) return 'copilot'
  if (env.CLAUDE_PLUGIN_ROOT) return 'vscode'
  return 'other'
}

let version
// The installed guard's version, from its own plugin.json; read once per process.
export function guardVersion() {
  if (version !== undefined) return version
  try {
    version = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null
  } catch {
    version = null
  }
  return version
}

const repos = new Map()
// The basename of the git top level of `cwd` (null outside git); one `git rev-parse` per directory and process.
export function repoName(cwd, run = execFileSync) {
  const key = cwd || '.'
  if (!repos.has(key)) {
    let name = null
    try {
      const top = String(run('git', ['rev-parse', '--show-toplevel'], { cwd: key, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })).trim()
      name = top ? basename(top) : null
    } catch {
      // not a repo, or git missing
    }
    repos.set(key, name)
  }
  return repos.get(key)
}

// Every record carries the harness, the guard version and the repo (the git top level's name of `cwd`, the hook
// input's), read only when something will be sent.
export const recordAttrs = (attrs, cwd, harness, env = process.env) => (otelEnabled(env) ? { ...attrs, harness, guard_version: guardVersion(), repo: repoName(cwd) } : attrs)

// A line of tool output made safe to send: long token-like runs and `key=value` / `key: value` pairs whose key names
// a secret are masked, then it is cut to 200 characters.
export const scrub = (line) =>
  String(line ?? '')
    .replace(/((?:token|secret|password|passwd|pass|key|auth|bearer|credential)[\w-]*\s*[=:]\s*)\S+/gi, '$1***')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_\-+/=]{24,}\b/g, '***')
    .slice(0, 200)

// The make target that failed (`make: *** [test] Error 1`; the innermost recipe, which make reports first), or null.
export function failedTarget(output) {
  const all = [...String(output ?? '').matchAll(/make(?:\[\d+\])?: \*\*\* \[(?:[^\]]*:\s*)?([^\]\s]+)\] Error/g)]
  return all.length ? all[0][1] : null
}

// 12 hex chars of the sha256 of the command with runs of whitespace collapsed.
export const commandHash = (command) => createHash('sha256').update(String(command).trim().replace(/\s+/g, ' ')).digest('hex').slice(0, 12)

// One JSON line per decision to $FACTORY_EVENTS_FILE, when a factory runtime sets it: the runtime's guard deny-rate
// breaker reads it. Only the hash of the command, never its text; a failed write is dropped and the decision stands.
export function appendDecision(env, { decision, rule, cmd_hash }, now = new Date(), append = appendFileSync) {
  const file = env?.FACTORY_EVENTS_FILE
  if (!file) return
  try {
    append(file, `${JSON.stringify({ ts: now.toISOString(), decision, rule, cmd_hash })}\n`)
  } catch {
    // unwritable path: telemetry never blocks a decision
  }
}
