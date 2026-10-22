import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { CODEX_RULES, codexAsks, codexReviewer, approvalLabel, handle, pythonManager, sessionStore, tail } from './guard.mjs'
import { fallbackDataDir } from './data.mjs'
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
    { hook_event_name: 'PreToolUse', tool_name: 'read', tool_input: { path: 'C:\\Users\\me\\.pi\\agent\\git\\harness\\plugins\\dev-tools\\skills\\ship\\SKILL.md' } },
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

test('GUARD_UNATTENDED set once by a command holds for the rest of the session, subagents included (G23)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'guard-test-'))
  const h = (input, env = {}) => handle({ session_id: 's1', cwd: '/', ...input }, { dataDir, env, hostFacts: calm, run: async () => null, pythonManager })
  assert.equal(decision(await h(pre('Bash', 'rm -rf ~/x'))).permissionDecision, 'ask')
  await h(pre('Bash', 'GUARD_UNATTENDED=1 git rebase origin/main'))
  for (const input of [pre('Bash', 'rm -rf ~/x'), { ...pre('Bash', 'git branch -D x'), agent_id: 'a1' }]) {
    const d = decision(await h(input))
    assert.equal(d.permissionDecision, 'deny', input.tool_input.command)
    assert.match(d.permissionDecisionReason, /Unattended run/)
  }
  assert.equal(decision(await h({ ...pre('Bash', 'rm -rf ~/x'), session_id: 's2' })).permissionDecision, 'ask', 'another session is not affected')
  await h(pre('Bash', 'export GUARD_UNATTENDED=0'))
  assert.equal(decision(await h(pre('Bash', 'rm -rf ~/x'))).permissionDecision, 'ask')
  assert.equal(decision(await h(pre('Bash', 'rm -rf ~/x'), { GUARD_UNATTENDED: '1' })).permissionDecision, 'deny', 'the launcher environment wins')
  assert.equal(decision(await h(pre('Bash', 'export GUARD_UNATTENDED=1; rm -rf ~/x'))).permissionDecision, 'deny', 'set in the same command')
  assert.equal(decision(await h(pre('Bash', 'rm -rf ~/x'))).permissionDecision, 'ask', 'a denied command does not switch the session')
  await h(pre('Bash', 'export GUARD_UNATTENDED=1'))
  assert.match(decision(await h(pre('Bash', 'rm -rf ~/x'))).permissionDecisionReason, /switched on by a command in this session/)
  await h(pre('Bash', 'unset GUARD_UNATTENDED'))
  assert.equal(decision(await h(pre('Bash', 'rm -rf ~/x'))).permissionDecision, 'ask')
})

test('a cd followed across ; only when its directory exists (G23 review)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-cd-'))
  const h = setup({ env: { TMPDIR: '/var/folders/ab/T/' } })
  assert.equal(decision(await h({ ...pre('Bash', 'cd sub; rm -rf /tmp/x/build'), cwd: dir })), undefined)
  mkdirSync(join(dir, 'sub'))
  const run = async (argv) => (argv.includes('rev-list') ? '0\n' : null)
  const h2 = setup({ run })
  assert.equal(decision(await h2({ ...pre('Bash', 'cd sub; git branch -D feat/x'), cwd: dir })), undefined, 'existing dir: followed')
  assert.equal(decision(await h2({ ...pre('Bash', 'cd gone; git branch -D feat/x'), cwd: dir })).permissionDecision, 'ask', 'missing dir: not followed')
})

test('a branch ref deleted through gh api passes once a merged PR holds its tip, looked up where the command cds (G23)', async () => {
  const calls = []
  const run = async (argv, cwd) => (calls.push([argv[1], cwd]), argv[0] === 'gh' ? 'abc\n' : null)
  const h = setup({ run })
  assert.equal(decision(await h({ ...pre('Bash', 'cd sub && gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/feat/x'), cwd: '/r' })), undefined)
  assert.deepEqual(calls, [['pr', resolve('/r/sub')], ['api', resolve('/r/sub')]])
  assert.equal(decision(await h(pre('Bash', 'gh api -X DELETE repos/o/r/git/refs/tags/v1'))).permissionDecision, 'ask')
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
  assert.ok(existsSync(join(dataDir, 'sessions', 'x.jsonl')))
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
  assert.ok(calls.some(([cmd, cwd]) => cmd === 'gh' && cwd === resolve('/r/.claude/worktrees/x')))
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

test('telemetry: a deny emits a decision record with its class; an allow only when sampled', async () => {
  const sent = []
  let roll = 0.5
  const run = setup({ emit: async (event, attrs) => sent.push([event, attrs]), random: () => roll })
  await run(pre('Bash', 'git commit -m "bad title"'))
  assert.deepEqual(sent.map(([e, a]) => [e, a.action, a.cmd_class]), [['guard.decision', 'deny', 'title']])
  await run(pre('Bash', 'ls'))
  assert.equal(sent.length, 1)
  roll = 0.05
  await run(pre('Bash', 'ls -la'))
  const [event, attrs] = sent[1]
  assert.deepEqual([event, attrs.action, attrs.via, attrs.sample_rate, attrs.cmd_class], ['guard.decision', 'allow', undefined, 10, 'list'])
  assert.ok(!JSON.stringify(sent).includes('ls -la'))
})

test('FACTORY_EVENTS_FILE: one JSON line per deny or ask with ts, decision, rule and cmd_hash, never the command', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'guard-events-')), 'events.jsonl')
  const run = setup({ env: { FACTORY_EVENTS_FILE: file } })
  await run(pre('Bash', 'git commit -m "bad title"'))
  await run(pre('Bash', 'ls'))
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  assert.deepEqual(Object.keys(lines[0]), ['ts', 'decision', 'rule', 'cmd_hash'])
  assert.equal(lines[0].decision, 'deny')
  assert.match(lines[0].cmd_hash, /^[0-9a-f]{12}$/)
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)))
  assert.doesNotMatch(readFileSync(file, 'utf8'), /bad title|git commit/)
})

test('FACTORY_EVENTS_FILE: a crashing guard logs its fail-closed deny as guard-error', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'guard-events-')), 'events.jsonl')
  const h = setup({ env: { FACTORY_EVENTS_FILE: file }, hostFacts: async () => { throw new Error('boom') } })
  assert.equal(decision(await h(pre('Bash', 'npm run build && rm -rf build'))).permissionDecision, 'deny')
  const [line] = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual([line.decision, line.rule], ['deny', 'guard-error'])
})

test('FACTORY_EVENTS_FILE: unset writes nothing, an unwritable path leaves the decision standing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-events-'))
  assert.equal(decision(await setup({ env: { FACTORY_EVENTS_FILE: join(dir, 'missing', 'events.jsonl') } })(pre('Bash', 'git commit -m "bad"'))).permissionDecision, 'deny')
  assert.equal(decision(await setup()(pre('Bash', 'git commit -m "bad"'))).permissionDecision, 'deny')
  assert.deepEqual(readdirSync(dir), [])
})

test('telemetry: guard.skill once per loaded skill (typed /name only for marketplace skills), guard.reminder per hint', async () => {
  const events = []
  const h = setup({ emit: async (event, attrs) => events.push([event, attrs.skill ?? attrs.rule, attrs.via]), knownSkills: new Set(['ship', 'docs-sync']), random: () => 0.99 })
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
  assert.equal(decision(await setup({ readTool: false, noAsk: true })(pre('Bash', 'cat a.txt'))), undefined)
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

test('telemetry: a heavy command allowed on a calm host is always recorded, as rule host with its facts', async () => {
  const events = []
  await setup({ emit: async (event, attrs) => events.push(attrs), random: () => 0.99, hostFacts: async () => ({ load1: 1, freeGb: 100 }) })(pre('Bash', 'make test'))
  assert.deepEqual([events[0].action, events[0].rule, events[0].sample_rate, events[0].load1, events[0].free_gb], ['allow', 'host', 1, 1, 100])
})

test('telemetry: a heavy allow the host rule did not judge (wrapped, or after its deny) is only sampled', async () => {
  const events = []
  const run = setup({ emit: async (event, attrs) => events.push([attrs.action, attrs.rule, attrs.sample_rate]), random: () => 0.99, hostFacts: async () => ({ load1: 999, freeGb: 100 }) })
  await run(pre('Bash', 'make test'))
  await run(pre('Bash', 'make test'))
  await run(pre('Bash', 'scripts/heavy.sh make test'))
  assert.deepEqual(events, [['deny', 'host', undefined]])
})

test('telemetry: the allow sample keeps random() below 1/ALLOW_SAMPLE only', async () => {
  for (const [roll, sent] of [[0.0999, 1], [0.1, 0]]) {
    const events = []
    await setup({ emit: async (event, attrs) => events.push(attrs), random: () => roll })(pre('Bash', 'ls'))
    assert.equal(events.length, sent, String(roll))
  }
})

test('telemetry: a host deny carries the host facts it was judged on', async () => {
  const events = []
  await setup({ emit: async (event, attrs) => events.push(attrs), hostFacts: async () => ({ load1: 45, freeGb: 100 }) })(pre('Bash', 'make test'))
  assert.deepEqual([events[0].rule, events[0].load1, events[0].free_gb], ['host', 45, 100])
})

test('a risky step buried in a long chain is denied with "split it out" and logged via=split', async () => {
  const events = []
  const out = decision(await setup({ emit: async (event, attrs) => events.push(attrs) })(pre('Bash', 'cd a && make && make test && rm -rf src')))
  assert.equal(out.permissionDecision, 'deny')
  assert.match(out.permissionDecisionReason, /own simple command/)
  assert.deepEqual([events[0].action, events[0].via, events[0].rule], ['deny', 'split', 'rm'])
})

test('the pip deny judges the repo the command cds into, not the session cwd (G06)', async () => {
  const uv = mkdtempSync(join(tmpdir(), 'guard-uv-'))
  writeFileSync(join(uv, 'uv.lock'), '')
  const out = decision(await setup()({ ...pre('Bash', `cd ${uv} && pip install x`), cwd: mkdtempSync(join(tmpdir(), 'guard-plain-')) }))
  assert.equal(out.permissionDecision, 'deny')
  assert.match(out.permissionDecisionReason, /uses uv/)
})

test('parallel hooks keep every loaded skill: facts are appended, not rewritten', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'guard-test-'))
  const deps = { dataDir, env: {}, hostFacts: calm, run: async () => null, knownSkills: new Set() }
  const names = Array.from({ length: 30 }, (_, i) => `skill-${i}`)
  await Promise.all(names.map((n) => handle({ session_id: 'p', hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: n } }, deps)))
  assert.deepEqual(sessionStore(dataDir, 'p').load().loaded.sort(), names.sort())
})

test('parallel hook processes keep every loaded skill', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'guard-test-'))
  const script = fileURLToPath(new URL('./guard.mjs', import.meta.url))
  const names = Array.from({ length: 20 }, (_, i) => `skill-${i}`)
  await Promise.all(
    names.map(
      (n) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [script], { env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, GUARD_OTEL: 'off' }, stdio: ['pipe', 'ignore', 'ignore'] })
          child.on('exit', resolve)
          child.stdin.end(JSON.stringify({ session_id: 'q', cwd: dataDir, hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: n } }))
        }),
    ),
  )
  assert.deepEqual(sessionStore(dataDir, 'q').load().loaded.sort(), names.sort())
})

test('skills count for the whole session, reminders per agent; the read and edit hints once per session (G24)', async () => {
  const h = setup()
  await h({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'ship' }, agent_id: 'a1' })
  assert.equal(decision(await h(pre('Bash', 'git commit -m "fix: x"'))), undefined, "a subagent's skill load covers the main agent")
  const hinted = async (command, agent_id) => Boolean(decision(await h({ ...pre('Bash', command), agent_id }))?.additionalContext)
  assert.equal(await hinted('pytest -q', 'a1'), true)
  assert.equal(await hinted('pytest -q', 'a1'), false, 'once per agent')
  assert.equal(await hinted('pytest -q', undefined), true, 'the main agent gets its own')
  for (const command of ['cat README.md', 'echo x > notes.txt']) {
    assert.equal(await hinted(command, 'a1'), true, command)
    assert.equal(await hinted(command, 'a2'), false, `${command}: once per session`)
    assert.equal(await hinted(command, undefined), false, `${command}: once per session`)
  }
})

test('auto mode, which tells the agent to read and edit through the shell, gets no read or edit hint (G24)', async () => {
  const h = setup()
  const ctx = async (command, permission_mode) => decision(await h({ ...pre('Bash', command), permission_mode }))?.additionalContext
  assert.equal(await ctx('cat README.md', 'auto'), undefined)
  assert.equal(await ctx("sed -i 's/a/b/' f.txt", 'auto'), undefined)
  assert.match(await ctx('cat README.md', 'default'), /read tool/, 'held back, not spent')
  assert.match(await ctx("sed -i 's/a/b/' f.txt", 'acceptEdits'), /edit tool/)
})

test('a plain read of non-secret files is allowed outright, so no harness prompt stalls it (G24)', async () => {
  const h = setup()
  for (const c of ['sed -n 36,56p internal/contract/testdata/harness/factory.md', 'cd sub && sed -n 36,56p internal/contract/x.md', 'head -n 20 README.md', 'cat a.txt b.txt', 'tail -50 log/app.log']) {
    const d = decision(await h(pre('Bash', c)))
    assert.equal(d?.permissionDecision, 'allow', c)
  }
  for (const c of ['cat .env', 'cat ~/.ssh/config', 'head internal/token/token.go', 'cat secrets.yaml', 'cat a.txt > b.txt', 'cat $F', "sed -n '1w out' f", 'sed -n 1,5p f | sh', 'cat a; rm -rf b', 'cat /dev/stdin', 'less ~/.aws/config', 'cat id_ed25519', 'cd /r/.claude/worktrees/m4 && sed -n 36,56p x.md', 'cat /etc/hosts', 'cat env:GH_PAT', 'cat C:/Users/me/AppData/Roaming/gh/hosts.yml'])
    assert.notEqual(decision(await h(pre('Bash', c)))?.permissionDecision, 'allow', c)
  assert.equal(decision(await setup({ noAsk: true })(pre('Bash', 'cat a.txt')))?.permissionDecision, undefined, 'Codex: no allow, it has no prompt for this')
})

test('without a session id nothing is kept, and the fallback data dir is per user', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'guard-test-'))
  await handle({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'ship' } }, { dataDir, env: {}, hostFacts: calm, run: async () => null })
  assert.equal(existsSync(join(dataDir, 'sessions')), false)
  assert.match(fallbackDataDir(), new RegExp(`guard-plugin-${process.getuid?.() ?? userInfo().username}$`))
})

test('lookups that outrun the budget are dropped: the risky command still gets a decision, an ask', async () => {
  const h = setup({ run: () => new Promise(() => {}), factsMs: 100, previewMs: 100 })
  const started = Date.now()
  const d = decision(await h(pre('Bash', 'rm -rf node_modules')))
  assert.ok(Date.now() - started < 2000)
  assert.equal(d.permissionDecision, 'ask')
  assert.match(d.permissionDecisionReason, /Checks unfinished/)
})

test('a decision does not wait for telemetry', async () => {
  const h = setup({ emit: () => new Promise(() => {}) })
  assert.equal(decision(await h(pre('Bash', 'rm -rf build'))).permissionDecision, 'ask')
})

test("Codex's reviewer is read from the rollout's last 256 KB only", () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-test-'))
  const ctx = (reviewer) => JSON.stringify({ type: 'turn_context', payload: { approvals_reviewer: reviewer } })
  const filler = `${JSON.stringify({ type: 'event', payload: 'x'.repeat(1000) })}\n`.repeat(400)
  writeFileSync(join(dir, 'recent.jsonl'), `${ctx('agent')}\n${filler}${ctx('user')}\n`)
  writeFileSync(join(dir, 'old.jsonl'), `${ctx('user')}\n${filler}`)
  assert.equal(codexReviewer(tail(join(dir, 'recent.jsonl'))), 'user')
  assert.equal(codexReviewer(tail(join(dir, 'old.jsonl'))), undefined, 'older than the tail: unknown, so denied')
})

test('a SKILL.md counts as loaded only when read under a skill root, never when written', async () => {
  const committed = async (load) => {
    const h = setup()
    await h(load)
    return decision(await h(pre('Bash', 'git commit')))?.permissionDecision
  }
  const cached = '/Users/me/.claude/plugins/cache/giocaizzi-harness/dev-tools/1.24.0/skills/ship/SKILL.md'
  assert.equal(await committed({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: cached, content: 'x' } }), 'deny')
  assert.equal(await committed(pre('Bash', `sed -i s/a/b/ ${cached}`)), 'deny')
  assert.equal(await committed({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/scratch/skills/ship/SKILL.md' } }), 'deny')
  assert.equal(await committed(pre('Bash', 'echo skills/ship/SKILL.md')), 'deny')
  assert.equal(await committed({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: cached } }), undefined)
  assert.equal(await committed(pre('Bash', 'cat plugins/dev-tools/skills/ship/SKILL.md')), undefined)
})

test('a skill loaded by its namespaced and its bare name is one guard.skill', async () => {
  const events = []
  const h = setup({ emit: (event, attrs) => events.push([event, attrs]), knownSkills: new Set(['ship']) })
  await h({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'dev-tools:ship' } })
  await h({ hook_event_name: 'UserPromptSubmit', prompt: '/ship' })
  assert.deepEqual(events.filter(([e]) => e === 'guard.skill').map(([, a]) => a.skill), ['ship'])
})

test('VS Code task tools are judged by the command they run', async () => {
  const h = setup()
  const ws = mkdtempSync(join(tmpdir(), 'guard-test-'))
  mkdirSync(join(ws, '.vscode'))
  writeFileSync(join(ws, '.vscode', 'tasks.json'), '{\n  // build tasks\n  "version": "2.0.0",\n  "tasks": [\n    { "label": "wipe", "type": "shell", "command": "rm", "args": ["-rf", "src"], },\n  ],\n}\n')
  const task = (tool_name, tool_input) => h({ hook_event_name: 'PreToolUse', tool_name, tool_input })
  assert.equal(decision(await task('create_and_run_task', { workspaceFolder: ws, task: { label: 'x', type: 'shell', command: 'rm', args: ['-rf', 'src'] } })).permissionDecision, 'ask')
  assert.equal(decision(await task('run_task', { id: 'shell: wipe', workspaceFolder: ws })).permissionDecision, 'ask')
  assert.equal(decision(await task('run_task', { id: 'wipe', workspaceFolder: ws })).permissionDecision, 'ask')
  assert.equal(decision(await task('create_and_run_task', { workspaceFolder: ws, task: { label: 'b', type: 'shell', command: 'npm', args: ['run', 'build'] } })), undefined)
  assert.match(decision(await task('run_task', { id: 'shell: missing', workspaceFolder: ws })).additionalContext, /could not read the command/)
})

test('FACTORY_RUN_ID set: the approval label (default or the repo\'s configured one) cannot be added; unset, it can', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'guard-factory-'))
  const configured = mkdtempSync(join(tmpdir(), 'guard-factory-'))
  mkdirSync(join(configured, '.factory'))
  writeFileSync(join(configured, '.factory', 'config.yaml'), 'labels:\n  approval: go-ahead\n  claimed: x\n')
  const crlf = mkdtempSync(join(tmpdir(), 'guard-factory-'))
  mkdirSync(join(crlf, '.factory'))
  writeFileSync(join(crlf, '.factory', 'config.yaml'), 'labels:\r\n  approval: "go ahead"\r\n  claimed: x\r\n')
  assert.equal(approvalLabel(crlf), 'go ahead', 'CRLF and a quoted name with a space')
  const inRun = setup({ env: { FACTORY_RUN_ID: 'r1' } })
  const add = (label, dir) => ({ ...pre('Bash', `gh issue edit 70 --add-label ${label}`), cwd: dir })
  const denied = decision(await inRun(add('agent-ok', cwd)))
  assert.equal(denied.permissionDecision, 'deny')
  assert.match(denied.permissionDecisionReason, /approval label/)
  assert.equal(decision(await inRun({ ...pre('Bash', 'gh api repos/o/r/issues/70/labels -f labels[]=agent-ok'), cwd })).permissionDecision, 'deny')
  assert.equal(decision(await inRun({ ...pre('Bash', 'gh pr edit 3 --add-label agent-ok'), cwd })).permissionDecision, 'deny')
  assert.equal(decision(await inRun(add('go-ahead', configured))).permissionDecision, 'deny')
  assert.equal(decision(await inRun(add('agent-ok', configured))), undefined, 'the configured name replaces the default')
  assert.equal(decision(await inRun(add('needs-owner', cwd))), undefined)
  assert.equal(decision(await setup({ env: {} })(add('agent-ok', cwd))), undefined, 'no run active: allowed')
})
