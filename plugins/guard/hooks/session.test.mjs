import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, runDetached, stopCheck, takeLock } from './stop.mjs'
import { lintFile } from './lint.mjs'
import { harnessPid, keepAwake, keeperArgv } from './awake.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'guard-test-'))
// Lint skips files in a temp dir, so lint tests write theirs next to this file, removed afterwards.
const LINT_ROOT = fileURLToPath(new URL('./.lint-test/', import.meta.url))
const lintTmp = () => (mkdirSync(LINT_ROOT, { recursive: true }), mkdtempSync(join(LINT_ROOT, 'x-')))
after(() => rmSync(LINT_ROOT, { recursive: true, force: true }))

// The stop tests expect the check to run; a developer's own GUARD_STOP_CHECK=off must not leak in.
delete process.env.GUARD_STOP_CHECK
delete process.env.GUARD_STOP_TIMEOUT_MS

const stopRun = (calls, make, git = { status: 0, stdout: 'x' }, targets = ['check']) => (cmd, args) => {
  calls.push(`${cmd} ${args.join(' ')}`)
  if (cmd === 'git') return git
  if (args[0] === '-n') return { status: targets.includes(args[1]) ? 0 : 2 }
  return make
}

test('stop: blocks once with the output tail when make check fails', async () => {
  const calls = []
  const make = { status: 2, stdout: 'ok\n'.repeat(50) + 'FAIL x\n', stderr: '' }
  const out = await stopCheck({ cwd: '/r' }, stopRun(calls, make, { status: 2 }))
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /make check failed[\s\S]*FAIL x$/)
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'Stop', decision: 'block', reason: out.reason }) // VS Code
  assert.ok(out.reason.split('\n').length <= 41)
  assert.deepEqual(calls.filter((c) => c.startsWith('make')), ['make -n check-fast', 'make -n check', 'make check'])
})

test('stop: a failure is reported with the failing target and its last line, scrubbed', async () => {
  const events = []
  const make = { status: 2, stdout: 'ok\n', stderr: 'make[1]: *** [Makefile:3: test] Error 1\nAPI_TOKEN=supersecret leaked' }
  await stopCheck({ cwd: '/r' }, stopRun([], make, { status: 2 }), { strain: () => null, report: (e) => events.push(e) })
  assert.equal(events[0].result, 'fail')
  assert.equal(events[0].failed_target, 'test')
  assert.equal(events[0].last_line, 'API_TOKEN=*** leaked')
})

test('stop: prefers make check-fast when the Makefile defines it', async () => {
  const calls = []
  const make = { status: 2, stdout: 'FAIL y\n', stderr: '' }
  const out = await stopCheck({ cwd: '/r' }, stopRun(calls, make, { status: 2 }, ['check-fast', 'check']))
  assert.match(out.reason, /^make check-fast failed/)
  assert.deepEqual(calls.filter((c) => c.startsWith('make')), ['make -n check-fast', 'make check-fast'])
})

test('stop: passes when stop_hook_active, no check target, no make, or green', async () => {
  // Own data dir: under the guard's own stop hook, the real one holds this repo's lock and the check would defer.
  process.env.CLAUDE_PLUGIN_DATA = tmp()
  try {
    const never = () => assert.fail('must not run')
    assert.equal(await stopCheck({ stop_hook_active: true }, never), null)
    assert.equal(await stopCheck({}, () => ({ status: 2 })), null)
    assert.equal(await stopCheck({}, () => ({ status: null, error: new Error('ENOENT') })), null)
    assert.equal(await stopCheck({}, () => ({ status: 0 })), null)
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
  }
})

test('stop: skips make check when the repo is unchanged since the last green run', async () => {
  const dir = tmp()
  process.env.CLAUDE_PLUGIN_DATA = dir
  try {
    const calls = []
    const run = stopRun(calls, { status: 0 })
    assert.equal(await stopCheck({ cwd: '/r' }, run), null)
    assert.equal(calls.filter((c) => c === 'make check').length, 1)
    assert.equal(await stopCheck({ cwd: '/r' }, run), null) // same fingerprint: skipped
    assert.equal(calls.filter((c) => c === 'make check').length, 1)
    const changed = stopRun(calls, { status: 0 }, { status: 0, stdout: 'y' })
    assert.equal(await stopCheck({ cwd: '/r' }, changed), null) // changed tree: runs again
    assert.equal(calls.filter((c) => c === 'make check').length, 2)
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
  }
})

test('stop: a strained host or a check already running in the repo defers it, and the next stop runs it', async () => {
  const dir = tmp()
  process.env.CLAUDE_PLUGIN_DATA = dir
  try {
    const calls = []
    const events = []
    const report = (e) => events.push(e)
    const out = await stopCheck({ cwd: '/r' }, stopRun(calls, { status: 0 }), { strain: () => 'load 45', report })
    assert.match(out.systemMessage, /make check deferred \(host strained: load 45\)/)
    assert.equal(calls.filter((c) => c === 'make check').length, 0)
    const busy = async (cmd, args) => {
      assert.match((await stopCheck({ cwd: '/r' }, stopRun(calls, { status: 0 }), { strain: () => null, report })).systemMessage, /another stop check/)
      return stopRun(calls, { status: 0 })(cmd, args)
    }
    assert.equal(await stopCheck({ cwd: '/r' }, stopRun(calls, { status: 0 }), { exec: busy, strain: () => null, report }), null)
    assert.deepEqual(events.map((e) => e.result), ['deferred', 'deferred', 'pass'])
    assert.equal(typeof events[2].duration_ms, 'number')
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
  }
})

test('stop: a timeout is deferred, not blocked, and never marks green', async () => {
  const dir = tmp()
  process.env.CLAUDE_PLUGIN_DATA = dir
  process.env.GUARD_STOP_TIMEOUT_MS = '5000'
  try {
    const calls = []
    const make = { status: null, error: Object.assign(new Error('spawnSync make ETIMEDOUT'), { code: 'ETIMEDOUT' }) }
    const out = await stopCheck({ cwd: '/r' }, stopRun(calls, make))
    assert.equal(out.decision, undefined)
    assert.match(out.systemMessage, /make check deferred \(did not finish within 5 s\)/)
    await stopCheck({ cwd: '/r' }, stopRun(calls, { status: 0 }))
    assert.equal(calls.filter((c) => c === 'make check').length, 2) // not skipped
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
    delete process.env.GUARD_STOP_TIMEOUT_MS
  }
})

test('stop: GUARD_STOP_CHECK=force runs it on a strained host', async () => {
  process.env.CLAUDE_PLUGIN_DATA = tmp()
  process.env.GUARD_STOP_CHECK = 'force'
  try {
    const out = await stopCheck({ cwd: '/r' }, stopRun([], { status: 2 }), { strain: () => 'load 45' })
    assert.equal(out.decision, 'block')
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
    delete process.env.GUARD_STOP_CHECK
  }
})

test('stop: GUARD_STOP_CHECK=off disables it', async () => {
  process.env.GUARD_STOP_CHECK = 'off'
  try {
    assert.equal(await stopCheck({}, () => assert.fail('must not run')), null)
  } finally {
    delete process.env.GUARD_STOP_CHECK
  }
})

test('lint: shellcheck findings come back as context; clean, missing tool or other files pass', () => {
  const dir = lintTmp()
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
  const dir = lintTmp()
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
  const dir = lintTmp()
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

test('stop: make runs without a terminal, so a recipe reading /dev/tty fails at once', { skip: process.platform === 'win32' }, async () => {
  const started = Date.now()
  const r = await runDetached('sh', ['-c', 'read x < /dev/tty'], { cwd: tmp(), timeout: 20_000 })
  assert.notEqual(r.status, 0)
  assert.equal(r.timedOut, false)
  assert.ok(Date.now() - started < 10_000)
})

test('stop: a timeout kills the whole process group, grandchildren included', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp()
  const r = await runDetached('sh', ['-c', 'sleep 60 & echo $! > pid; wait'], { cwd: dir, timeout: 500 })
  assert.equal(r.timedOut, true)
  const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.throws(() => process.kill(pid, 0))
})

test('stop: a timeout resolves at once even when a surviving grandchild keeps the pipes open', async () => {
  const dir = tmp()
  // The middle process starts a grandchild in its own session holding stdout and stderr, then exits: no group or
  // tree kill reaches the grandchild, so 'close' would wait the full 10 s.
  const middle = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }); require('fs').writeFileSync('pid', String(c.pid)); c.unref()"
  const started = Date.now()
  const r = await runDetached(process.execPath, ['-e', middle], { cwd: dir, timeout: 500 })
  try {
    assert.equal(r.timedOut, true)
    assert.ok(Date.now() - started < 5000, `resolved after ${Date.now() - started} ms`)
  } finally {
    try {
      process.kill(Number(readFileSync(join(dir, 'pid'), 'utf8')))
    } catch {}
  }
})

test('stop: the fingerprint changes when an untracked file changes', () => {
  const dir = tmp()
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init')
  writeFileSync(join(dir, 'new.py'), 'a = 1\n')
  const before = fingerprint(dir)
  writeFileSync(join(dir, 'new.py'), 'a = 2\n')
  assert.ok(before)
  assert.notEqual(fingerprint(dir), before)
})

test("stop: of two stops taking over a dead holder's lock, only one wins", () => {
  const file = join(tmp(), 'x.lock')
  writeFileSync(file, '999999999')
  const first = takeLock(file)
  const second = takeLock(file)
  assert.equal(typeof first, 'function')
  assert.equal(second, null)
  first()
  assert.equal(existsSync(file), false)
})

test('lint: Codex apply_patch (`command`) is read; zsh scripts and temp files are skipped', () => {
  const dir = lintTmp()
  const findings = () => ({ status: 1, stdout: 'SC2086\n' })
  const bash = join(dir, 'b.sh')
  const zsh = join(dir, 'z.sh')
  writeFileSync(bash, '#!/usr/bin/env bash\necho $x\n')
  writeFileSync(zsh, '#!/bin/zsh\necho $x\n')
  const patch = `*** Begin Patch\n*** Add File: ${bash}\n+y\n*** End Patch\n`
  assert.match(lintFile({ tool_name: 'apply_patch', tool_input: { command: patch }, cwd: dir }, findings).additionalContext, /b\.sh/)
  assert.equal(lintFile({ tool_name: 'Write', tool_input: { file_path: zsh } }, findings), null)
  const scratch = join(tmp(), 's.sh')
  writeFileSync(scratch, 'echo $x\n')
  assert.equal(lintFile({ tool_name: 'Write', tool_input: { file_path: scratch } }, findings), null)
})
