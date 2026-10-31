import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, resultGate, runDetached, stopCheck, takeLock } from './stop.mjs'
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
// Nor a factory run's own variables: the result gate would hold every stop test to its result file.
for (const k of ['FACTORY_RUN_ID', 'FACTORY_TICKET', 'FACTORY_ATTENDED_RUN_ID', 'FACTORY_ATTENDED_TICKET', 'FACTORY_RUN_FILE', 'GUARD_RESULT_GATE']) delete process.env[k]

const stopRun = (calls, make, git = { status: 0, stdout: 'x' }, targets = ['check']) => (cmd, args) => {
  calls.push(`${cmd} ${args.join(' ')}`)
  if (cmd === 'git') return git
  if (args[0] === '-n') return { status: targets.includes(args[1]) ? 0 : 2 }
  return make
}

test('stop: blocks once with the output tail when make check fails', async () => {
  const calls = []
  const make = { status: 2, stdout: 'ok\n'.repeat(50) + 'FAIL x\n', stderr: '' }
  const out = await stopCheck({ cwd: '/r' }, stopRun(calls, make, { status: 2 }), { strain: () => null })
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
  const out = await stopCheck({ cwd: '/r' }, stopRun(calls, make, { status: 2 }, ['check-fast', 'check']), { strain: () => null })
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
    assert.equal(await stopCheck({}, () => ({ status: 0 }), { strain: () => null }), null)
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
    assert.equal(await stopCheck({ cwd: '/r' }, run, { strain: () => null }), null)
    assert.equal(calls.filter((c) => c === 'make check').length, 1)
    assert.equal(await stopCheck({ cwd: '/r' }, run, { strain: () => null }), null) // same fingerprint: skipped
    assert.equal(calls.filter((c) => c === 'make check').length, 1)
    const changed = stopRun(calls, { status: 0 }, { status: 0, stdout: 'y' })
    assert.equal(await stopCheck({ cwd: '/r' }, changed, { strain: () => null }), null) // changed tree: runs again
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
    const out = await stopCheck({ cwd: '/r' }, stopRun(calls, make), { strain: () => null })
    assert.equal(out.decision, undefined)
    assert.match(out.systemMessage, /make check deferred \(did not finish within 5 s\)/)
    await stopCheck({ cwd: '/r' }, stopRun(calls, { status: 0 }), { strain: () => null })
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

// A git repo with a factory result for ticket 12 (none when `result` is undefined); the gate's counter in its own dir.
const gateRepo = (result) => {
  const repo = tmp()
  execFileSync('git', ['init', '-q', repo])
  if (result !== undefined) {
    mkdirSync(join(repo, '.factory', 'runs', '12'), { recursive: true })
    writeFileSync(join(repo, '.factory', 'runs', '12', 'result.json'), typeof result === 'string' ? result : JSON.stringify(result))
  }
  process.env.CLAUDE_PLUGIN_DATA = tmp()
  return repo
}
const validResult = (over = {}) => ({
  schema: 2,
  ticket: 'acme/app#12',
  run_id: 'run-1',
  end_state: 'done',
  reason: '',
  reason_code: null,
  phases: [{ name: 'gate', started_at: '2026-10-25T10:00:00Z', ended_at: '2026-10-25T10:01:00Z' }],
  finished_at: '2026-10-25T10:02:00Z',
  ...over,
})
const RUNTIME = { FACTORY_RUN_ID: 'run-1', FACTORY_TICKET: 'acme/app#12' }
const ATTENDED = { FACTORY_ATTENDED_RUN_ID: 'run-1', FACTORY_ATTENDED_TICKET: 'acme/app#12' }

test('result gate: a runtime run with no result.json is blocked twice, then may stop', async () => {
  const cwd = gateRepo()
  try {
    const first = await resultGate({ cwd }, undefined, RUNTIME)
    assert.match(first, /block 1 of 2\): .*result\.json is not a valid result for run run-1:\nno such file\n/)
    assert.match(first, /write-result\.mjs, never by hand/)
    const events = []
    assert.match(await resultGate({ cwd, stop_hook_active: true }, undefined, RUNTIME, (e) => events.push(e)), /block 2 of 2[\s\S]*A subagent \(such as the verifier\) ignores this/)
    assert.equal(await resultGate({ cwd }, undefined, RUNTIME, (e) => events.push(e)), null)
    assert.deepEqual(events, [{ result: 'block', target: 'result-gate', runner: 'runtime', blocks: 2 }, { result: 'capped', target: 'result-gate', runner: 'runtime' }])
    // The count is per run id: another run starts over.
    assert.match(await resultGate({ cwd }, undefined, { ...RUNTIME, FACTORY_RUN_ID: 'run-2' }), /block 1 of 2/)
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
  }
})

test("result gate: a runtime run's invalid result, broken JSON or another run's file blocks with the errors; a valid one passes", async () => {
  try {
    assert.match(await resultGate({ cwd: gateRepo(validResult({ ticket: 12 })) }, undefined, RUNTIME), /ticket must be a string of the form/)
    assert.match(await resultGate({ cwd: gateRepo('{"schema": 2,') }, undefined, RUNTIME), /not valid JSON/)
    assert.match(await resultGate({ cwd: gateRepo(validResult({ run_id: 'run-0' })) }, undefined, RUNTIME), /run_id "run-0" differs from FACTORY_RUN_ID "run-1"/)
    assert.equal(await resultGate({ cwd: gateRepo(validResult()) }, undefined, RUNTIME), null)
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
  }
})

test("result gate: a group run's tasks follow FACTORY_RUN_FILE, a relative path read from the session's directory", async () => {
  const task = (n) => ({ ticket: `acme/app#${n}`, outcome: 'done', reason: '', reason_code: null, pr_link: 'closes' })
  const group = validResult({ schema: 3, pr: 'https://github.com/acme/app/pull/20', tasks: [task(12), task(13)] })
  const withRun = (members) => {
    const cwd = gateRepo(group)
    writeFileSync(join(cwd, 'run.json'), JSON.stringify({ schema: 1, run_id: 'run-1', lead: 'acme/app#12', members: members.map((n) => ({ ticket: `acme/app#${n}` })) }))
    return cwd
  }
  const env = { ...RUNTIME, FACTORY_RUN_FILE: 'run.json' }
  try {
    assert.equal(await resultGate({ cwd: withRun([12, 13]) }, undefined, env), null)
    assert.match(await resultGate({ cwd: withRun([12, 14]) }, undefined, env), /block 1 of 2[\s\S]*differ from the run file's members/)
    assert.match(await resultGate({ cwd: gateRepo(group) }, undefined, env), /block 1 of 2[\s\S]*cannot check against the run file/)
    // A result without tasks under a run file is a group run recorded as one ticket: held, unless it stopped at the gate.
    const single = (over) => { const cwd = gateRepo(validResult(over)); writeFileSync(join(cwd, 'run.json'), JSON.stringify({ schema: 1, run_id: 'run-1', lead: 'acme/app#12', members: [{ ticket: 'acme/app#12' }] })); return cwd }
    assert.match(await resultGate({ cwd: single() }, undefined, env), /block 1 of 2[\s\S]*FACTORY_RUN_FILE is set, so this group run's result needs tasks/)
    assert.equal(await resultGate({ cwd: single({ end_state: 'failed', reason: 'refuse: not approved', reason_code: 'auth' }) }, undefined, env), null)
    // A member left parked makes the group parked, never done.
    const mixed = validResult({ schema: 3, pr: 'https://github.com/acme/app/pull/20', tasks: [task(12), { ...task(13), outcome: 'parked', reason: 'waits', reason_code: 'question', pr_link: 'refs' }] })
    const mixedRepo = () => { const cwd = gateRepo(mixed); writeFileSync(join(cwd, 'run.json'), JSON.stringify({ schema: 1, run_id: 'run-1', lead: 'acme/app#12', members: [{ ticket: 'acme/app#12' }, { ticket: 'acme/app#13' }] })); return cwd }
    assert.match(await resultGate({ cwd: mixedRepo() }, undefined, env), /block 1 of 2[\s\S]*make end_state parked, got "done"/)
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
  }
})

test("result gate: an attended run is held only to an invalid file carrying its own run id", async () => {
  try {
    assert.equal(await resultGate({ cwd: gateRepo() }, undefined, ATTENDED), null)
    assert.equal(await resultGate({ cwd: gateRepo('not json') }, undefined, ATTENDED), null)
    assert.equal(await resultGate({ cwd: gateRepo(validResult({ run_id: 'other', ticket: 12 })) }, undefined, ATTENDED), null)
    assert.equal(await resultGate({ cwd: gateRepo(validResult()) }, undefined, ATTENDED), null)
    assert.match(await resultGate({ cwd: gateRepo(validResult({ ticket: 12 })) }, undefined, ATTENDED), /block 1 of 2[\s\S]*ticket must be a string/)
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
  }
})

test('result gate: off, a subagent, no factory run, a bad ticket or no git checkout pass', async () => {
  try {
    const cwd = gateRepo()
    assert.equal(await resultGate({ cwd }, undefined, { ...RUNTIME, GUARD_RESULT_GATE: 'off' }), null)
    assert.equal(await resultGate({ cwd, agent_id: 'a1' }, undefined, RUNTIME), null)
    assert.equal(await resultGate({ cwd, hook_event_name: 'SubagentStop' }, undefined, RUNTIME), null)
    assert.equal(await resultGate({ cwd }, undefined, {}), null)
    assert.equal(await resultGate({ cwd }, undefined, { ...RUNTIME, FACTORY_TICKET: '12' }), null)
    assert.equal(await resultGate({ cwd }, () => ({ status: 128, stdout: '' }), RUNTIME), null)
    const events = []
    assert.equal(await resultGate({ cwd }, () => assert.fail('a gate error fails open'), RUNTIME, (e) => events.push(e)), null)
    assert.deepEqual(events.map((e) => [e.result, e.target]), [['error', 'result-gate']])
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
  }
})

test('result gate: runs before make check, and both reasons go in one block', async () => {
  const cwd = gateRepo()
  Object.assign(process.env, RUNTIME)
  try {
    const run = (cmd, args, opts) => (cmd === 'make' ? stopRun([], { status: 2, stdout: 'FAIL z\n' }, { status: 2 })(cmd, args) : spawnSync(cmd, args, opts))
    const events = []
    const out = await stopCheck({ cwd }, run, { strain: () => null, report: (e) => events.push(e) })
    assert.deepEqual(events.map((e) => `${e.target}:${e.result}`), ['result-gate:block', 'check:fail'])
    assert.equal(out.decision, 'block')
    assert.match(out.reason, /^Factory result gate \(block 1 of 2\)[\s\S]*\n\nmake check failed[\s\S]*FAIL z$/)
    assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'Stop', decision: 'block', reason: out.reason })
    // stop_hook_active skips make check, not the gate.
    assert.match((await stopCheck({ cwd, stop_hook_active: true }, run, { strain: () => null })).reason, /^Factory result gate \(block 2 of 2\)[^]*write-result\.mjs[^]*\.$/)
    assert.equal(await stopCheck({ cwd, stop_hook_active: true }, run, { strain: () => null }), null)
  } finally {
    for (const k of Object.keys(RUNTIME)) delete process.env[k]
    delete process.env.CLAUDE_PLUGIN_DATA
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

// A real git repo with a committed Makefile and source file; make is stubbed (status `make.status`), git is real.
const docsRepo = () => {
  const dir = tmp()
  const git = (...args) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'Makefile'), 'check:\n\t@true\n')
  writeFileSync(join(dir, 'src', 'a.py'), 'a = 1\n')
  writeFileSync(join(dir, 'README.md'), '# r\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  const checks = []
  const run = (cmd, args, opts) => {
    if (cmd !== 'make') return spawnSync(cmd, args, opts)
    if (args[0] === '-n') return { status: args[1] === 'check' ? 0 : 2 }
    checks.push(args[0])
    return { status: 0, stdout: '', stderr: '' }
  }
  const stop = () => stopCheck({ cwd: dir }, run, { strain: () => null })
  return { dir, git, checks, stop, write: (p, s) => (mkdirSync(dirname(join(dir, p)), { recursive: true }), writeFileSync(join(dir, p), s)) }
}

const withData = async (fn) => {
  process.env.CLAUDE_PLUGIN_DATA = tmp()
  try {
    await fn()
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA
  }
}

test('stop: a docs-only change skips make check; a code change, a mixed one or none runs it', () =>
  withData(async () => {
    const r = docsRepo()
    await r.stop() // clean tree, no green run yet: an empty change set runs it, as before
    assert.equal(r.checks.length, 1)
    r.write('README.md', '# changed\n')
    r.write('docs/guide.md', 'new\n') // untracked
    r.write('docs/a.png', 'x')
    await r.stop()
    assert.equal(r.checks.length, 1, 'docs only: skipped')
    r.write('src/a.py', 'a = 2\n')
    await r.stop()
    assert.equal(r.checks.length, 2, 'mixed: runs')
  }))

test('stop: a code commit since the last green run is not hidden by a docs-only working tree', () =>
  withData(async () => {
    const r = docsRepo()
    await r.stop()
    r.write('src/a.py', 'a = 3\n')
    r.git('commit', '-qam', 'code')
    r.write('README.md', '# after\n')
    await r.stop()
    assert.equal(r.checks.length, 2, 'the diff is taken against the green run, not HEAD')
    r.write('README.md', '# docs commit\n')
    r.git('commit', '-qam', 'docs')
    await r.stop()
    assert.equal(r.checks.length, 2, 'only a docs commit since the last green run: skipped')
  }))

test('stop: a code file renamed into docs/ still runs the check (renames count as delete and add)', () =>
  withData(async () => {
    const r = docsRepo()
    r.git('mv', 'src/a.py', 'docs/a.py')
    await r.stop()
    assert.equal(r.checks.length, 1)
  }))

test("stop: the repo's .stop-check-ignore keeps matching docs checked and extends the skip list", () =>
  withData(async () => {
    const r = docsRepo()
    r.write('.stop-check-ignore', '!docs/**\nsite/**\n')
    r.git('add', '.stop-check-ignore')
    r.git('commit', '-qm', 'rules')
    r.write('site/index.html', '<p>')
    await r.stop()
    assert.equal(r.checks.length, 0, 'extended skip list')
    r.write('docs/guide.md', 'x\n')
    await r.stop()
    assert.equal(r.checks.length, 1, '`!docs/**`: runs')
  }))

test('stop: GUARD_STOP_CHECK=off still disables it and force still skips only the strain deferral', () =>
  withData(async () => {
    const r = docsRepo()
    r.write('README.md', '# x\n')
    process.env.GUARD_STOP_CHECK = 'force'
    try {
      await stopCheck({ cwd: r.dir }, (c, a, o) => (c === 'make' && a[0] !== '-n' ? assert.fail('docs only') : c === 'make' ? { status: a[1] === 'check' ? 0 : 2 } : spawnSync(c, a, o)), { strain: () => 'load 99' })
    } finally {
      delete process.env.GUARD_STOP_CHECK
    }
  }))

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
