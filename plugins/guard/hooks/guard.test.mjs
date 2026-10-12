import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handle } from './guard.mjs'

const calm = async () => ({ load1: 1, freeGb: 100 })
const setup = (deps = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'guard-test-'))
  return (input) => handle({ session_id: 's1', cwd: '/', ...input }, { dataDir, env: {}, hostFacts: calm, run: async () => null, ...deps })
}
const pre = (tool_name, command) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command } })
const decision = (out) => (out.stdout ? JSON.parse(out.stdout).hookSpecificOutput : undefined)

test('a skill rule denies once per session, then lets the command through', async () => {
  const h = setup()
  const first = decision(await h(pre('Bash', 'git commit')))
  assert.equal(first.permissionDecision, 'deny')
  assert.match(first.permissionDecisionReason, /conventional-commits/)
  assert.equal(decision(await h(pre('Bash', 'git commit'))), undefined)
})

test('the Skill tool (either harness spelling) and a typed slash command count as loaded', async () => {
  for (const load of [
    { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'dev-tools:conventional-commits' } },
    { hook_event_name: 'PreToolUse', tool_name: 'skill', tool_input: { skill: 'ship' } },
    { hook_event_name: 'UserPromptSubmit', prompt: '/ship please' },
  ]) {
    const h = setup()
    await h(load)
    assert.equal(decision(await h(pre('Bash', 'git commit'))), undefined, load.tool_name ?? load.prompt)
  }
})

test('title guard denies a non-conventional commit every time, on bash and PowerShell', async () => {
  const h = setup()
  await h({ hook_event_name: 'UserPromptSubmit', prompt: '/ship' })
  for (const tool of ['Bash', 'bash', 'PowerShell', 'powershell']) {
    const d = decision(await h(pre(tool, 'git commit -m "bad"')))
    assert.equal(d.permissionDecision, 'deny', tool)
    assert.match(d.permissionDecisionReason, /not a Conventional Commit/)
  }
})

test('risky commands ask every time; safe temp deletes pass', async () => {
  const h = setup({ env: { TMPDIR: '/var/folders/ab/T/' } })
  for (let i = 0; i < 2; i++) assert.equal(decision(await h(pre('Bash', 'rm -rf ~/x'))).permissionDecision, 'ask')
  for (const c of ['rm -rf /tmp/x', 'rm -rf $TMPDIR/x']) assert.equal(decision(await h(pre('Bash', c))), undefined, c)
})

test('heavy command on a strained host is denied once', async () => {
  const h = setup({ hostFacts: async () => ({ load1: 50, freeGb: 100 }) })
  assert.equal(decision(await h(pre('Bash', 'npm run build'))).permissionDecision, 'deny')
  assert.equal(decision(await h(pre('Bash', 'npm run build'))), undefined)
})

test('blast radius: the ask carries a preview; a failing preview still asks', async () => {
  const h = setup({ run: async (argv) => (argv[0] === 'du' ? '4.0K\tbuild\n' : null) })
  assert.match(decision(await h(pre('Bash', 'rm -rf build'))).permissionDecisionReason, /Would affect:\n4\.0K\tbuild/)
  const failing = setup({ run: async () => { throw new Error('boom') } })
  const d = decision(await failing(pre('Bash', 'rm -rf build')))
  assert.equal(d.permissionDecision, 'ask')
})

test('a crashing guard fails closed for risky commands, open for the rest', async () => {
  const h = setup({ hostFacts: async () => { throw new Error('boom') } })
  assert.equal(decision(await h(pre('Bash', 'npm run build && rm -rf build'))).permissionDecision, 'deny')
  assert.equal(decision(await h(pre('Bash', 'npm run build'))), undefined)
})

test('other tools and empty commands are ignored', async () => {
  const h = setup()
  assert.deepEqual(await h({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { command: 'git commit' } }), {})
  assert.deepEqual(await h({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }), {})
})

test('SessionEnd drops the session state', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'guard-test-'))
  const deps = { dataDir, env: {}, hostFacts: calm, run: async () => null }
  await handle({ session_id: 'x', hook_event_name: 'UserPromptSubmit', prompt: '/ship' }, deps)
  assert.ok(existsSync(join(dataDir, 'sessions', 'x.json')))
  await handle({ session_id: 'x', hook_event_name: 'SessionEnd' }, deps)
  assert.ok(!existsSync(join(dataDir, 'sessions', 'x.json')))
})

test('a squash-merged worktree (merged PR found by gh in the worktree) is not asked about', async () => {
  const calls = []
  const run = async (argv, cwd) => {
    calls.push([argv[0], cwd])
    if (argv[0] === 'gh') return 'abc\n'
    const sub = argv[3]
    if (sub === 'rev-parse') return '/r/.git/worktrees/x\n/r/.git\n\n/r/.claude/worktrees/x\n'
    return sub === 'rev-list' ? '2\n' : sub === 'branch' ? 'fix/x\n' : ''
  }
  const h = setup({ run })
  assert.equal(decision(await h(pre('Bash', 'rm -rf /r/.claude/worktrees/x'))), undefined)
  assert.ok(calls.some(([cmd, cwd]) => cmd === 'gh' && cwd === '/r/.claude/worktrees/x'))
})
