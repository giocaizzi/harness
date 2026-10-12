// PostToolUse hook: after an edit of a shell script run shellcheck, of a .ps1 PSScriptAnalyzer, and hand
// the findings back as additional context. Formatting is left to `make lint`. Missing linter: skip.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Edit tools of every harness. VS Code ignores hooks.json matchers, so the script filters itself.
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'create', 'create_file', 'replace_string_in_file', 'multi_replace_string_in_file', 'insert_edit_into_file', 'apply_patch'])

const PS_LINT =
  'if (Get-Module -ListAvailable -Name PSScriptAnalyzer) { $r = Invoke-ScriptAnalyzer -Path $env:GUARD_LINT_FILE -Severity Error,Warning; ' +
  'if ($r) { $r | Format-List RuleName,Line,Message | Out-String } }'

// Edited files: Claude `file_path`, Copilot `path`, VS Code `filePath` or `replacements[].filePath`, and the
// `*** Add/Update File:` lines of an apply_patch (Copilot sends the patch as the whole tool_input, VS Code as `input`).
export function editedFiles(input) {
  const t = input.tool_input
  const patch = typeof t === 'string' ? t : t?.input
  const paths =
    typeof patch === 'string'
      ? [...patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((m) => m[1].trim())
      : [t?.file_path ?? t?.path ?? t?.filePath, ...(Array.isArray(t?.replacements) ? t.replacements.map((r) => r?.filePath) : [])]
  return [...new Set(paths.filter((p) => typeof p === 'string' && p).map((p) => resolve(input.cwd || '.', p)))]
}

export function lintFile(input, run = spawnSync, platform = process.platform) {
  if (!EDIT_TOOLS.has(String(input.tool_name ?? '').toLowerCase())) return null
  const found = editedFiles(input).map((file) => lintOne(file, run, platform)).filter(Boolean)
  if (!found.length) return null
  const context = found.join('\n\n')
  // Claude and VS Code read hookSpecificOutput; Copilot CLI reads the top-level additionalContext.
  return { additionalContext: context, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }
}

function lintOne(file, run, platform) {
  if (!existsSync(file)) return null
  const opts = { encoding: 'utf8', timeout: 50_000, windowsHide: true }
  let out = ''
  if (/\.(sh|bash)$/i.test(file)) {
    const r = run('shellcheck', [file], opts)
    if (!r.error && r.status !== 0) out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  } else if (/\.ps1$/i.test(file)) {
    const r = run(platform === 'win32' ? 'powershell' : 'pwsh', ['-NoProfile', '-Command', PS_LINT], { ...opts, env: { ...process.env, GUARD_LINT_FILE: file } })
    if (!r.error && r.status === 0) out = r.stdout ?? ''
  }
  return out.trim() ? `Lint findings in ${file}; fix them:\n${out.trim()}` : null
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const out = lintFile(JSON.parse(readFileSync(0, 'utf8') || '{}'))
    if (out) process.stdout.write(JSON.stringify(out))
  } catch {
    // unreadable payload: nothing to lint
  }
}
