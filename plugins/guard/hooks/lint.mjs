// PostToolUse hook: after an edit of a shell script run shellcheck, of a .ps1 PSScriptAnalyzer, and hand
// the findings back as additional context. Formatting is left to `make lint`. Missing linter: skip.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const PS_LINT =
  'if (Get-Module -ListAvailable -Name PSScriptAnalyzer) { $r = Invoke-ScriptAnalyzer -Path $env:GUARD_LINT_FILE -Severity Error,Warning; ' +
  'if ($r) { $r | Format-List RuleName,Line,Message | Out-String } }'

export function lintFile(input, run = spawnSync, platform = process.platform) {
  const file = input.tool_input?.file_path ?? input.tool_input?.path
  if (!file || !existsSync(file)) return null
  const opts = { encoding: 'utf8', timeout: 50_000, windowsHide: true }
  let out = ''
  if (/\.(sh|bash)$/i.test(file)) {
    const r = run('shellcheck', [file], opts)
    if (!r.error && r.status !== 0) out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  } else if (/\.ps1$/i.test(file)) {
    const r = run(platform === 'win32' ? 'powershell' : 'pwsh', ['-NoProfile', '-Command', PS_LINT], { ...opts, env: { ...process.env, GUARD_LINT_FILE: file } })
    if (!r.error && r.status === 0) out = r.stdout ?? ''
  }
  if (!out.trim()) return null
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `Lint findings in ${file}; fix them:\n${out.trim()}` } }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const out = lintFile(JSON.parse(readFileSync(0, 'utf8') || '{}'))
    if (out) process.stdout.write(JSON.stringify(out))
  } catch {
    // unreadable payload: nothing to lint
  }
}
