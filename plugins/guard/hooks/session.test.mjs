import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopCheck } from './stop.mjs'
import { lintFile } from './lint.mjs'
import { harnessPid, keepAwake, keeperArgv } from './awake.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'guard-test-'))

test('stop: blocks once with the output tail when make check fails', () => {
  const calls = []
  const run = (cmd, args) => {
    calls.push(args.join(' '))
    return args[0] === '-n' ? { status: 0 } : { status: 2, stdout: 'ok\n'.repeat(50) + 'FAIL x\n', stderr: '' }
  }
  const out = stopCheck({ cwd: '/r' }, run)
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /make check failed[\s\S]*FAIL x$/)
  assert.ok(out.reason.split('\n').length <= 41)
  assert.deepEqual(calls, ['-n check', 'check'])
})

test('stop: passes when stop_hook_active, no check target, no make, or green', () => {
  const never = () => assert.fail('must not run')
  assert.equal(stopCheck({ stop_hook_active: true }, never), null)
  assert.equal(stopCheck({}, () => ({ status: 2 })), null)
  assert.equal(stopCheck({}, () => ({ status: null, error: new Error('ENOENT') })), null)
  assert.equal(stopCheck({}, () => ({ status: 0 })), null)
})

test('lint: shellcheck findings come back as context; clean, missing tool or other files pass', () => {
  const dir = tmp()
  const sh = join(dir, 'a.sh')
  const md = join(dir, 'a.md')
  writeFileSync(sh, 'echo $x\n')
  writeFileSync(md, '# x\n')
  const findings = () => ({ status: 1, stdout: 'SC2086: quote this\n', stderr: '' })
  const out = lintFile({ tool_input: { file_path: sh } }, findings)
  assert.match(out.hookSpecificOutput.additionalContext, /SC2086/)
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse')
  assert.match(lintFile({ tool_input: { path: sh } }, findings).hookSpecificOutput.additionalContext, /a\.sh/) // Copilot spelling
  assert.equal(lintFile({ tool_input: { file_path: sh } }, () => ({ status: 0, stdout: '' })), null)
  assert.equal(lintFile({ tool_input: { file_path: sh } }, () => ({ status: null, error: new Error('ENOENT') })), null)
  assert.equal(lintFile({ tool_input: { file_path: md } }, findings), null)
  assert.equal(lintFile({ tool_input: { file_path: join(dir, 'gone.sh') } }, findings), null)
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
  assert.match(lintFile({ tool_input: { file_path: ps1 } }, run, 'darwin').hookSpecificOutput.additionalContext, /PSAvoidUsingWriteHost/)
  assert.deepEqual(used, ['pwsh', ps1])
  lintFile({ tool_input: { file_path: ps1 } }, run, 'win32')
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
