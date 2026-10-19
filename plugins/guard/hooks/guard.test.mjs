import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CODEX_RULES, codexAsks, handle, pythonManager } from './guard.mjs'
import { codexRules } from '../core/engine.mjs'
import { rules } from '../core/rules.mjs'

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

test('noAsk leaves a risky command the harness prompts for to the harness, denies the rest', async () => {
  const h = setup({ noAsk: true, nativeAsk: async (command, rule) => command === 'rm -rf ~/x' && rule === 'rm' })
  assert.equal(decision(await h(pre('Bash', 'rm -rf ~/x'))), undefined)
  assert.equal(decision(await h(pre('Bash', 'cd / && rm -rf ~/x'))).permissionDecision, 'deny')
})

const turnContext = (reviewer) => JSON.stringify({ type: 'turn_context', payload: { approval_policy: 'on-request', approvals_reviewer: reviewer } }) + '\n'
const transcript = (...lines) => {
  const file = join(mkdtempSync(join(tmpdir(), 'codex-rollout-')), 'rollout.jsonl')
  writeFileSync(file, lines.join(''))
  return file
}

test('Codex prompts only with this version of the installed prompt rules', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  const human = transcript(turnContext('user'))
  assert.equal(codexAsks({ CODEX_HOME: home }, human), null)
  mkdirSync(join(home, 'rules'))
  writeFileSync(join(home, 'rules', CODEX_RULES), 'prefix_rule(pattern = ["rm", "-r"], decision = "prompt")\n')
  assert.equal(codexAsks({ CODEX_HOME: home }, human), null)
  writeFileSync(join(home, 'rules', CODEX_RULES), codexRules(rules))
  const asks = codexAsks({ CODEX_HOME: home }, human)
  assert.equal(asks('git reset --hard', 'reset'), true)
  assert.equal(asks('git reset --hard; ls', 'reset'), false)
  assert.equal(asks('git reset --hard $NOPE', 'reset'), false)
  // Forms Codex runs without consulting its prompt rules (security review of #76): the guard denies them.
  const h = setup({ noAsk: true, nativeAsk: asks })
  for (const command of ['rm -r $PWD/victim', 'rm -r victim*', 'rm -R "$PWD"/victim', 'rm -r vic\\tim', 'rm -r ~/x', 'git reset --hard $NOPE', 'git push --force origin $NOPE', 'terraform apply $NOPE'])
    assert.equal(decision(await h(pre('Bash', command)))?.permissionDecision, 'deny', command)
})

test('Codex: only a human approvals reviewer in the latest turn context gets the native ask', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  mkdirSync(join(home, 'rules'))
  writeFileSync(join(home, 'rules', CODEX_RULES), codexRules(rules))
  assert.notEqual(codexAsks({ CODEX_HOME: home }, transcript(turnContext('user'))), null)
  // An AI reviewer from any source (config, profile, -c, --approve-for-me) shows here; the latest turn wins.
  assert.equal(codexAsks({ CODEX_HOME: home }, transcript(turnContext('auto_review'))), null)
  assert.equal(codexAsks({ CODEX_HOME: home }, transcript(turnContext('user'), turnContext('guardian_subagent'))), null)
  // No turn context, no field, no readable transcript: fail closed.
  assert.equal(codexAsks({ CODEX_HOME: home }, transcript('{"type":"session_meta"}\n')), null)
  assert.equal(codexAsks({ CODEX_HOME: home }, transcript(JSON.stringify({ type: 'turn_context', payload: {} }) + '\n')), null)
  assert.equal(codexAsks({ CODEX_HOME: home }, join(home, 'missing.jsonl')), null)
  assert.equal(codexAsks({ CODEX_HOME: home }, undefined), null)
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

test('GUARD_UNATTENDED turns a risky ask into a deny, with or without a native ask; safe deletes still pass', async () => {
  const env = { GUARD_UNATTENDED: '1', TMPDIR: '/var/folders/ab/T/' }
  for (const deps of [{ env }, { env, noAsk: true, nativeAsk: async () => true }]) {
    const h = setup(deps)
    const d = decision(await h(pre('Bash', 'rm -rf ~/x')))
    assert.equal(d.permissionDecision, 'deny')
    assert.match(d.permissionDecisionReason, /Unattended run/)
    assert.equal(decision(await h(pre('Bash', 'rm -rf /tmp/x'))), undefined)
  }
  assert.equal(decision(await setup({ env: { GUARD_UNATTENDED: '0' } })(pre('Bash', 'rm -rf ~/x'))).permissionDecision, 'ask')
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

test('SessionEnd keeps the session state, so a resumed session remembers its skills', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'guard-test-'))
  const deps = { dataDir, env: {}, hostFacts: calm, run: async () => null }
  await handle({ session_id: 'x', hook_event_name: 'UserPromptSubmit', prompt: '/ship' }, deps)
  await handle({ session_id: 'x', hook_event_name: 'SessionEnd' }, deps)
  assert.ok(existsSync(join(dataDir, 'sessions', 'x.json')))
  assert.equal(decision(await handle({ ...pre('Bash', 'git commit -m "fix: x"'), session_id: 'x' }, deps)), undefined)
})

test('a deny or ask is logged with the tool_use_id, to join it with the harness tool decision', async () => {
  const events = []
  const h = setup({ emit: async (event, attrs) => events.push([event, attrs]) })
  await h({ ...pre('Bash', 'rm -rf build'), tool_use_id: 'toolu_1' })
  assert.equal(events[0][1].tool_use_id, 'toolu_1')
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

test('telemetry: guard.skill once per loaded skill (typed /name only for marketplace skills), guard.reminder per hint', async () => {
  const events = []
  const h = setup({ emit: async (event, attrs) => events.push([event, attrs.skill ?? attrs.rule, attrs.via]), knownSkills: new Set(['ship', 'docs-sync']) })
  await h({ hook_event_name: 'UserPromptSubmit', prompt: '/model opus' })
  await h({ hook_event_name: 'UserPromptSubmit', prompt: '/ship' })
  await h({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'dev-tools:land' } })
  await h({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'dev-tools:land' } })
  await h(pre('Bash', 'gh pr view 3 --comments'))
  const edit = await h({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/docs/a.md' } })
  assert.match(decision(edit).additionalContext, /docs-sync/)
  assert.deepEqual(events, [['guard.skill', 'ship', 'prompt'], ['guard.skill', 'land', 'tool'], ['guard.reminder', 'docs', undefined]])
})

test('Codex has no read tool, so a shell read gets no hint there', async () => {
  assert.equal(decision(await setup({ readTool: false })(pre('Bash', 'cat a.txt'))), undefined)
  assert.match(decision(await setup()(pre('Bash', 'cat a.txt'))).additionalContext, /read tool/)
})

test('telemetry: the logged action is the effective one, with via, a command hash and never the command', async () => {
  const events = []
  const emit = async (event, attrs) => events.push(attrs)
  await setup({ emit, env: { GUARD_UNATTENDED: '1' } })(pre('Bash', 'rm -rf build'))
  await setup({ emit, noAsk: true, nativeAsk: async () => false })(pre('Bash', 'rm -rf build'))
  await setup({ emit, noAsk: true, nativeAsk: async () => true })(pre('Bash', 'rm -rf build'))
  await setup({ emit })(pre('Bash', 'rm -rf build'))
  assert.deepEqual(events.map((e) => [e.action, e.via]), [['deny', 'unattended'], ['deny', 'no-ask'], ['ask', 'native-ask'], ['ask', undefined]])
  for (const e of events) {
    assert.match(e.cmd_hash, /^[0-9a-f]{12}$/)
    assert.ok(!Object.values(e).includes('rm -rf build'))
  }
})

test('telemetry: a host deny carries the host facts it was judged on', async () => {
  const events = []
  await setup({ emit: async (event, attrs) => events.push(attrs), hostFacts: async () => ({ load1: 45, freeGb: 100 }) })(pre('Bash', 'make test'))
  assert.deepEqual([events[0].rule, events[0].load1, events[0].free_gb], ['host', 45, 100])
})
