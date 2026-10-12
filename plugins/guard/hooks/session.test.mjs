import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopCheck } from './stop.mjs'
import { lintFile } from './lint.mjs'
import { harnessPid, keepAwake, keeperArgv } from './awake.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'guard-test-'))

const stopRun = (calls, make, git = { status: 0, stdout: 'x' }) => (cmd, args) => {
  calls.push(`${cmd} ${args.join(' ')}`)
  if (cmd === 'git') return git
  return args[0] === '-n' ? { status: 0 } : make
}

test('stop: blocks once with the output tail when make check fails', () => {
  const calls = []
  const make = { status: 2, stdout: 'ok\n'.repeat(50) + 'FAIL x\n', stderr: '' }
  const out = stopCheck({ cwd: '/r' }, stopRun(calls, make, { status: 2 }))
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /make check failed[\s\S]*FAIL x$/)
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'Stop', decision: 'block', reason: out.reason }) // VS Code
  assert.ok(out.reason.split('\n').length <= 41)
  assert.deepEqual(calls.filter((c) => c.startsWith('make')), ['make -n check', 'make check'])
})

test('stop: passes when stop_hook_active, no check target, no make, or green', () => {
  const never = () => assert.fail('must not run')
  assert.equal(stopCheck({ stop_hook_active: true }, never), null)
  assert.equal(stopCheck({}, () => ({ status: 2 })), null)
  assert.equal(stopCheck({}, () => ({ status: null, error: new Error('ENOENT') })), null)
  assert.equal(stopCheck({}, () => ({ status: 0 })), null)
})

test('stop: skips make check when the repo is unchanged since the last green run', () => {
  const dir = tmp()
  process.env.CLAUDE_PLUGIN_DATA = dir
  try {
    const calls = []
    const run = stopRun(calls, { status: 0 })
    assert.equal(stopCheck({ cwd: '/r' }, run), null)
    assert.equal(calls.filter((c) => c === 'make check').length, 1)
    assert.equal(stopCheck({ cwd: '/r' }, run), null) // same fingerprint: skipped
    assert.equal(calls.filter((c) => c === 'make check').length, 1)
    const changed = stopRun(calls, { status: 0 }, { status: 0, stdout: 'y' })
    assert.equal(stopCheck({ cwd: '/r' }, changed), null) // changed tree: runs again
    assert.equal(calls.filter((c) => c === 'make check').length, 2)
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
  }
})

test('stop: a timeout is reported, not blocked, and never marks green', () => {
  const dir = tmp()
  process.env.CLAUDE_PLUGIN_DATA = dir
  process.env.GUARD_STOP_TIMEOUT_MS = '5000'
  try {
    const calls = []
    const make = { status: null, error: Object.assign(new Error('spawnSync make ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
    const out = stopCheck({ cwd: '/r' }, stopRun(calls, make))
    assert.equal(out.decision, undefined)
    assert.match(out.systemMessage, /did not finish within 5 s/)
    stopCheck({ cwd: '/r' }, stopRun(calls, { status: 0 }))
    assert.equal(calls.filter((c) => c === 'make check').length, 2) // not skipped
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
    delete process.env.GUARD_STOP_TIMEOUT_MS
  }
})

test('stop: GUARD_STOP_CHECK=off disables it', () => {
  process.env.GUARD_STOP_CHECK = 'off'
  try {
    assert.equal(stopCheck({}, () => assert.fail('must not run')), null)
  } finally {
    delete process.env.GUARD_STOP_CHECK
  }
})

test('lint: shellcheck findings come back as context; clean, missing tool or other files pass', () => {
  const dir = tmp()
  const sh = join(dir, 'a.sh')
  const md = join(dir, 'a.md')
  writeFileSync(sh, 'echo $x\n')
  writeFileSync(md, '# x\n')
  const findings = () => ({ status: 1, stdout: 'SC2086: quote this\n', stderr: '' })
  const out = lintFile({ tool_name: 'Edit', tool_input: { file_path: sh } }, findings)
  assert.match(out.hookSpecificOutput.additionalContext, /SC2086/)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse')
  assert.equal(out.additionalContext, out.hookSpecificOutput.additionalContext) // Copilot reads the top level
  assert.match(lintFile({ tool_name: 'create', tool_input: { path: sh } }, findings).additionalContext, /a\.sh/) // Copilot spelling
  assert.equal(lintFile({ tool_name: 'Write', tool_input: { file_path: sh } }, () => ({ status: 0, stdout: '' })), null)
  assert.equal(lintFile({ tool_name: 'Write', tool_input: { file_path: sh } }, () => ({ status: null, error: new Error('ENOENT') })), null)
  assert.equal(lintFile({ tool_name: 'Write', tool_input: { file_path: md } }, findings), null)
  assert.equal(lintFile({ tool_name: 'Write', tool_input: { file_path: join(dir, 'gone.sh') } }, findings), null)
  assert.equal(lintFile({ tool_name: 'read_file', tool_input: { filePath: sh } }, findings), null) // VS Code ignores matchers
})

test('lint: VS Code and apply_patch spellings of the edited files', () => {
  const dir = tmp()
  const sh = join(dir, 'a.sh')
  const findings = () => ({ status: 1, stdout: 'SC2086\n' })
  writeFileSync(sh, 'echo $x\n')
  for (const [tool_name, tool_input] of [
    ['create_file', { filePath: sh }],
    ['replace_string_in_file', { filePath: sh }],
    ['multi_replace_string_in_file', { replacements: [{ filePath: sh }, { filePath: sh }] }],
    ['Edit', '*** Begin Patch\n*** Update File: a.sh\n@@\n-x\n+y\n*** End Patch\n'], // Copilot CLI apply_patch
    ['apply_patch', { input: `*** Begin Patch\n*** Add File: ${sh}\n+y\n*** End Patch\n` }], // VS Code
  ]) {
    const out = lintFile({ tool_name, tool_input, cwd: dir }, findings)
    assert.equal(out?.additionalContext.match(/Lint findings/g).length, 1, tool_name)
  }
})

test('lint: .ps1 goes to PSScriptAnalyzer through pwsh, powershell on Windows', () => {
  const dir = tmp()
  const ps1 = join(dir, 'a.ps1')
  writeFileSync(ps1, 'Write-Host x\n')
  let used
  const run = (cmd, args, opts) => {
    used = [cmd, opts.env.GUARD_LINT_FILE]
    return { status: 0, stdout: 'RuleName : PSAvoidUsingWriteHost\n' }
  }
  assert.match(lintFile({ tool_name: 'Edit', tool_input: { file_path: ps1 } }, run, 'darwin').hookSpecificOutput.additionalContext, /PSAvoidUsingWriteHost/)
  assert.deepEqual(used, ['pwsh', ps1])
  lintFile({ tool_name: 'Edit', tool_input: { file_path: ps1 } }, run, 'win32')
  assert.equal(used[0], 'powershell')
})

test('awake: walks past shells to the harness pid', () => {
  const tree = { 10: { ppid: 9, name: 'bash' }, 9: { ppid: 8, name: '/bin/zsh' }, 8: { ppid: 1, name: 'claude' } }
  const lookup = (p) => (tree[p] ? { ...tree[p], name: tree[p].name.split('/').pop() } : null)
  assert.equal(harnessPid(10, lookup), 8)
  assert.equal(harnessPid(8, lookup), 8)
  assert.equal(harnessPid(42, lookup), 42)
})

test('awake: one keeper per OS, tied to the harness pid', () => {
  assert.deepEqual(keeperArgv(8, 'darwin'), ['caffeinate', '-i', '-w', '8'])
  assert.ok(keeperArgv(8, 'linux').includes('--pid=8'))
  const win = keeperArgv(8, 'win32')
  assert.equal(win[0], 'powershell')
  const script = Buffer.from(win.at(-1), 'base64').toString('utf16le')
  assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483649\)/)
  assert.match(script, /Wait-Process -Id 8/)
  assert.equal(keeperArgv(8, 'aix'), null)
})

test('awake: a live keeper is reused across session starts; a dead one is replaced', () => {
  const dataDir = tmp()
  let launched = 0
  const base = { dataDir, start: 8, lookup: () => null, platform: 'darwin', launch: () => 1000 + ++launched }
  assert.equal(keepAwake({ ...base, isAlive: () => true }).keeper, 1001)
  assert.equal(keepAwake({ ...base, isAlive: () => true }), null)
  assert.equal(keepAwake({ ...base, isAlive: () => false }).keeper, 1002)
  assert.equal(keepAwake({ ...base, launch: () => undefined, isAlive: () => false }), null)
})
