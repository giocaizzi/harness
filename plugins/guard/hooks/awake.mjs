// SessionStart hook: keep the machine awake while the harness runs. One detached keeper per harness process,
// tied to its pid, so it ends with the session: macOS caffeinate -w, Linux systemd-inhibit around tail --pid,
// Windows SetThreadExecutionState held by a PowerShell that waits on the pid. No tool for it: skip.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// The hook's parent is often the shell the harness ran `command` in: skip shells up to the harness itself.
const SHELL = /^-?(sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd)(\.exe)?$/i

export function harnessPid(start, lookup) {
  let pid = start
  for (let i = 0; i < 4; i++) {
    const p = lookup(pid)
    if (!p || !SHELL.test(p.name) || !(p.ppid > 1)) return pid
    pid = p.ppid
  }
  return pid
}

// { ppid, name } of a pid, or null.
export function lookupProcess(pid, platform = process.platform) {
  const opts = { encoding: 'utf8', timeout: 5000, windowsHide: true }
  const out =
    platform === 'win32'
      ? spawnSync('powershell', ['-NoProfile', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { "$($p.ParentProcessId) $($p.Name)" }`], opts).stdout
      : spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], opts).stdout
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(out ?? '')
  return m ? { ppid: Number(m[1]), name: m[2].split(/[\\/]/).pop() } : null
}

const WIN_KEEPER = (pid) =>
  "Add-Type -Namespace Guard -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; " +
  `[void][Guard.Power]::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue`

export function keeperArgv(pid, platform = process.platform) {
  if (platform === 'darwin') return ['caffeinate', '-i', '-w', String(pid)]
  if (platform === 'linux')
    return ['systemd-inhibit', '--what=idle:sleep', '--who=guard', '--why=agent session', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null']
  if (platform === 'win32')
    return ['powershell', '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(WIN_KEEPER(pid), 'utf16le').toString('base64')]
  return null
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Start a keeper for this harness unless one recorded for it is still running (resume, /clear, compact).
export function keepAwake({ dataDir, start = process.ppid, lookup = lookupProcess, platform = process.platform, launch, isAlive = alive }) {
  const pid = harnessPid(start, (p) => lookup(p, platform))
  const argv = keeperArgv(pid, platform)
  if (!argv) return null
  const file = join(dataDir, 'awake', `${pid}.pid`)
  let kept = 0
  try {
    kept = Number(readFileSync(file, 'utf8'))
  } catch {
    // first session start for this harness
  }
  if (kept && isAlive(kept)) return null
  const keeper = launch(argv)
  if (!keeper) return null
  mkdirSync(join(dataDir, 'awake'), { recursive: true })
  writeFileSync(file, String(keeper))
  return { harness: pid, keeper, argv }
}

const launchDetached = (argv) => {
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {}) // tool missing: no keeper
  child.unref()
  return child.pid
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const dataDir = process.env.CLAUDE_PLUGIN_DATA || process.env.COPILOT_PLUGIN_DATA || join(tmpdir(), 'guard-plugin')
    keepAwake({ dataDir, launch: launchDetached })
  } catch {
    // never block a session start
  }
}
