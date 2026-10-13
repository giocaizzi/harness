import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handle, pythonManager } from './guard.mjs'

const calm = async () => ({ load1: 1, freeGb: 100 })
const setup = (deps = {}) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'guard-test-'))
  return (input) => handle({ session_id: 's1', cwd: '/', ...input }, { dataDir, env: {}, hostFacts: calm, run: async () => null, pythonManager, ...deps })
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

test('Codex, pi and opencode ways of loading a skill count as loaded', async () => {
  for (const load of [
    { hook_event_name: 'UserPromptSubmit', prompt: '$ship now' },
    { hook_event_name: 'UserPromptSubmit', prompt: '/skill:ship' },
    pre('Bash', 'sed -n 1,200p /x/plugins/cache/h/dev-tools/1.0.0/skills/ship/SKILL.md'),
    { hook_event_name: 'PreToolUse', tool_name: 'read', tool_input: { path: 'C:\\h\\skills\\ship\\SKILL.md' } },
    { hook_event_name: 'PreToolUse', tool_name: 'skill', tool_input: { name: 'ship' } },
  ]) {
    const h = setup()
    await h(load)
    assert.equal(decision(await h(pre('Bash', 'git commit'))), undefined, JSON.stringify(load))
  }
})

test('noAsk turns a risky ask into a deny that tells the agent why', async () => {
  const d = decision(await setup({ noAsk: true })(pre('Bash', 'rm -rf ~/x')))
  assert.equal(d.permissionDecision, 'deny')
  assert.match(d.permissionDecisionReason, /cannot ask for confirmation/)
})

test('title guard denies a non-conventional commit every time, on bash and PowerShell', async () => {
  const h = setup()
  await h({ hook_event_name: 'UserPromptSubmit', prompt: '/ship' })
  for (const tool of ['Bash', 'bash', 'PowerShell', 'powershell', 'run_in_terminal']) {
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

// A throwaway repo with the given files (path -> content), returning its root.
const repo = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'guard-repo-'))
  mkdirSync(join(root, '.git'))
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(root, f, '..'), { recursive: true })
    writeFileSync(join(root, f), body)
  }
  return root
}

test('pythonManager reads the repo around cwd', () => {
  const cases = [
    [{ 'uv.lock': '', 'pyproject.toml': '[project]\n' }, 'uv'],
    [{ 'pyproject.toml': '[project]\nname = "x"\n' }, 'uv'],
    [{ 'pyproject.toml': '[project]\n', 'requirements-dev.txt': '' }, 'uv'],
    [{ 'pyproject.toml': '[tool.poetry]\n' }, 'poetry'],
    [{ 'pyproject.toml': '[project]\n', 'poetry.lock': '' }, 'poetry'],
    [{ 'Pipfile.lock': '' }, 'pipenv'],
    [{ 'requirements.txt': '' }, 'pip'],
    [{ 'pyproject.toml': '[tool.ruff]\n', 'requirements.txt': '' }, 'pip'],
    [{ 'README.md': '' }, null],
  ]
  for (const [files, want] of cases) assert.equal(pythonManager(repo(files)), want, JSON.stringify(files))
  const nested = repo({ 'uv.lock': '', 'src/pkg/a.py': '' })
  assert.equal(pythonManager(join(nested, 'src', 'pkg')), 'uv')
  assert.equal(pythonManager(join(nested, 'missing')), 'uv')
})

test('pip and poetry are denied in a uv repo, allowed with a note once in a poetry or pip repo', async () => {
  const h = setup()
  const uv = repo({ 'uv.lock': '' })
  for (const c of ['pip install x', 'poetry add x']) {
    const d = decision(await h({ ...pre('Bash', c), cwd: uv }))
    assert.equal(d.permissionDecision, 'deny', c)
    assert.match(d.permissionDecisionReason, /uses uv/)
  }
  for (const [files, manager] of [[{ 'poetry.lock': '' }, 'poetry'], [{ 'requirements.txt': '' }, 'pip']]) {
    const h2 = setup()
    const cwd = repo(files)
    const first = decision(await h2({ ...pre('PowerShell', 'pip install x'), cwd }))
    assert.equal(first.permissionDecision, undefined, manager)
    assert.match(first.additionalContext, new RegExp(`uses ${manager}.*uv is preferred`))
    assert.equal(decision(await h2({ ...pre('PowerShell', 'pip install x'), cwd })), undefined, 'note once per session')
  }
})

test('VS Code ignores matchers: a non-shell tool with a command passes untouched', async () => {
  const h = setup()
  assert.equal(decision(await h(pre('read_file', 'git commit -m "bad"'))), undefined)
  assert.equal(decision(await h(pre('run_in_terminal', 'git commit'))).permissionDecision, 'deny')
})

test('telemetry: a deny and an ask emit a decision record, an allow does not', async () => {
  const sent = []
  const run = setup({ emit: async (event, attrs) => sent.push([event, attrs.action]) })
  await run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "bad title"' } })
  assert.deepEqual(sent, [['guard.decision', 'deny']])
  await run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
  assert.equal(sent.length, 1)
})
