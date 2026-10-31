import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { CODEX_RULES, codexAsks, codexReviewer, factoryLabels, handle, protectFacts, inWorkTree, pythonManager, sessionStore, tail } from './guard.mjs'
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

test('FACTORY_EVENTS_FILE: a well-formed GUARD_TRACEPARENT adds trace_id and span_id to each line, a malformed one adds neither', async () => {
  const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  const lines = async (GUARD_TRACEPARENT) => {
    const file = join(mkdtempSync(join(tmpdir(), 'guard-events-')), 'events.jsonl')
    const out = await setup({ env: { FACTORY_EVENTS_FILE: file, GUARD_TRACEPARENT } })(pre('Bash', 'git commit -m "bad title"'))
    assert.equal(decision(out).permissionDecision, 'deny')
    return readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  }
  const [line] = await lines(tp)
  assert.deepEqual(Object.keys(line), ['ts', 'decision', 'rule', 'cmd_hash', 'trace_id', 'span_id'])
  assert.deepEqual([line.trace_id, line.span_id], ['4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7'])
  const [future] = await lines(`01${tp.slice(2)}-future`)
  assert.deepEqual([future.trace_id, future.span_id], ['4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7'])
  for (const bad of ['', 'garbage', tp.toUpperCase(), tp.slice(0, -3), `ff${tp.slice(2)}`, `${tp}-extra`, '00-00000000000000000000000000000000-00f067aa0ba902b7-01', '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01']) {
    const [plain] = await lines(bad)
    assert.deepEqual(Object.keys(plain), ['ts', 'decision', 'rule', 'cmd_hash'], bad)
  }
})

test('guard.decision: the trace context is never one of the record attributes', async () => {
  const sent = []
  const run = setup({ env: { GUARD_TRACEPARENT: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }, emit: (event, attrs) => sent.push([event, attrs]) })
  await run(pre('Bash', 'git commit -m "bad title"'))
  const [, attrs] = sent.find(([e]) => e === 'guard.decision')
  assert.ok(!JSON.stringify(attrs).includes('4bf92f3577b34da6a3ce929d0e0e4736'))
})

test('through the real hook and its real emit, the OTLP guard.decision record carries traceId and spanId', async () => {
  const bodies = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => (bodies.push(JSON.parse(body)), res.end('{}')))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const script = fileURLToPath(new URL('./guard.mjs', import.meta.url))
    const child = spawn(process.execPath, [script, 'PreToolUse'], { env: { ...process.env, GUARD_OTEL: '', OTEL_EXPORTER_OTLP_ENDPOINT: '', GUARD_OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.address().port}`, GUARD_UNATTENDED: '', FACTORY_RUN_ID: '', FACTORY_EVENTS_FILE: '', GUARD_TRACEPARENT: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'guard-test-')) } })
    let stdout = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "bad title"' }, cwd: tmpdir(), session_id: 's' }))
    assert.equal(await new Promise((r) => child.on('close', r)), 0)
    assert.match(stdout, /"permissionDecision":"deny"/)
  } finally {
    server.close()
  }
  const records = bodies.flatMap((b) => b.resourceLogs[0].scopeLogs[0].logRecords)
  const rec = records.find((r) => r.body.stringValue === 'guard.decision')
  assert.deepEqual([rec.traceId, rec.spanId], ['4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7'])
})

test('through the real hook (Claude, Copilot CLI, VS Code; Codex with --harness=codex), GUARD_TRACEPARENT reaches the events file', () => {
  const script = fileURLToPath(new URL('./guard.mjs', import.meta.url))
  for (const args of [['PreToolUse'], ['PreToolUse', '--harness=codex']]) {
    const file = join(mkdtempSync(join(tmpdir(), 'guard-events-')), 'events.jsonl')
    const r = spawnSync(process.execPath, [script, ...args], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m "bad title"' }, cwd: tmpdir(), session_id: 's' }), encoding: 'utf8', timeout: 20000, env: { ...process.env, GUARD_OTEL: 'off', GUARD_UNATTENDED: '', FACTORY_RUN_ID: '', FACTORY_EVENTS_FILE: file, GUARD_TRACEPARENT: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'guard-test-')) } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /"permissionDecision":"deny"/)
    const [line] = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual([line.trace_id, line.span_id], ['4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7'], args.join(' '))
  }
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

test('a spawn that bypasses the typed agents gets a routing hint, never a decision (Claude Agent and Task, Copilot task)', async () => {
  const spawn = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input: { prompt: 'p', description: 'd', ...tool_input } })
  const events = []
  const h = setup({ emit: async (event, attrs) => events.push([event, attrs.rule, attrs.cmd_class]) })
  const plan = decision(await h(spawn('Agent', { subagent_type: 'Plan' })))
  assert.equal(plan.permissionDecision, undefined)
  assert.match(plan.additionalContext, /Routing hint.*dev-tools:driver/)
  assert.equal(decision(await h(spawn('Task', { subagent_type: 'Plan' }))), undefined) // once per session
  assert.match(decision(await h(spawn('Task', { subagent_type: 'general-purpose', model: 'opus' }))).additionalContext, /untyped spawn on opus/)
  assert.match(decision(await setup()(spawn('task', { agent_type: 'dev-tools:driver', model: 'claude-opus-4.7' }))).additionalContext, /overrides it/)
  assert.equal(decision(await setup()(spawn('Agent', { subagent_type: 'dev-tools:driver' }))), undefined)
  assert.equal(decision(await setup()(spawn('task', { subagent_type: 'general' }))), undefined) // opencode: no model on a spawn
  assert.match(decision(await setup()(spawn('spawn_agent', { agent_type: 'default', model: 'gpt-6-astra' }))).additionalContext, /untyped spawn on gpt-6-astra/) // Codex
  assert.match(decision(await setup()(spawn('runSubagent', { agentName: 'driver', model: 'Claude Opus 4.7 (copilot)' }))).additionalContext, /overrides it/) // VS Code
  assert.equal(decision(await setup()(spawn('runSubagent', {}))), undefined) // VS Code: no agentName runs a copy of the current agent
  assert.deepEqual(events, [['guard.reminder', 'routing-plan', 'routing'], ['guard.reminder', 'routing-model', 'routing']])
})

test('a malformed spawn input gets no decision and keeps the session state', async () => {
  const h = setup()
  await h({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'ship' } })
  for (const tool_input of [undefined, null, 'Plan', ['Plan'], { subagent_type: 42, model: {} }, { subagent_type: null, model: ['opus'] }]) {
    const out = await h({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input })
    assert.equal(decision(out)?.permissionDecision, undefined, JSON.stringify(tool_input))
  }
  // The state was saved through each: the skill still counts, and a well-formed hint still fires.
  assert.equal(decision(await h(pre('Bash', 'git commit -m "fix: x"'))), undefined)
  assert.match(decision(await h({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'Plan' } })).additionalContext, /Routing hint/)
})

test('a payload that is not an object exits 0 with no output', async () => {
  const script = fileURLToPath(new URL('./guard.mjs', import.meta.url))
  for (const payload of ['null', '42', '"x"', '[]', 'true']) {
    const r = spawnSync(process.execPath, [script, 'PreToolUse'], { input: payload, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'guard-test-')), GUARD_OTEL: 'off' } })
    assert.equal(r.status, 0, `${payload}: ${r.stderr}`)
    assert.equal(r.stdout, '', payload)
  }
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

test('Copilot CLI: a subagent hook names its own session and the parent in parent_agent_id; skills are shared, reminders its own (#172)', async () => {
  const h = setup()
  const child = { session_id: 'c1', agent_id: 'c1', parent_agent_id: 's1' }
  await h({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'ship' }, ...child })
  assert.equal(decision(await h(pre('Bash', 'git commit -m "fix: x"'))), undefined, "the subagent's skill load covers the main agent")
  const hinted = async (extra) => Boolean(decision(await h({ ...pre('Bash', 'pytest -q'), ...extra }))?.additionalContext)
  assert.equal(await hinted(child), true)
  assert.equal(await hinted(child), false, 'once for the subagent')
  assert.equal(await hinted({}), true, 'the main agent gets its own')
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
  const repoDir = mkdtempSync(join(tmpdir(), 'guard-repo-'))
  mkdirSync(join(repoDir, '.git'))
  const h0 = setup()
  const h = (input) => h0({ cwd: repoDir, ...input })
  for (const c of ['sed -n 36,56p internal/contract/testdata/harness/factory.md', 'cd sub && sed -n 36,56p internal/contract/x.md', 'head -n 20 README.md', 'cat a.txt b.txt', 'tail -50 log/app.log']) {
    const d = decision(await h(pre('Bash', c)))
    assert.equal(d?.permissionDecision, 'allow', c)
  }
  for (const c of ['cat .env', 'cat ~/.ssh/config', 'head internal/token/token.go', 'cat secrets.yaml', 'cat a.txt > b.txt', 'cat $F', "sed -n '1w out' f", 'sed -n 1,5p f | sh', 'cat a; rm -rf b', 'cat /dev/stdin', 'less ~/.aws/config', 'cat id_ed25519', 'cd /r/.claude/worktrees/m4 && sed -n 36,56p x.md', 'cat /etc/hosts', 'cat env:GH_PAT', 'cat C:/Users/me/AppData/Roaming/gh/hosts.yml'])
    assert.notEqual(decision(await h(pre('Bash', c)))?.permissionDecision, 'allow', c)
  assert.equal(decision(await setup({ noAsk: true })({ cwd: repoDir, ...pre('Bash', 'cat a.txt') }))?.permissionDecision, undefined, 'Codex: no allow, it has no prompt for this')
  // #208: only inside a work tree that is not the home directory's.
  const home = mkdtempSync(join(tmpdir(), 'guard-home-'))
  const inHome = setup({ env: { HOME: home } })
  assert.equal(decision(await inHome({ cwd: home, ...pre('Bash', 'cat .codex/auth2.json') }))?.permissionDecision, undefined, 'cwd at $HOME')
  mkdirSync(join(home, '.git'))
  mkdirSync(join(home, '.config'))
  assert.equal(decision(await inHome({ cwd: join(home, '.config'), ...pre('Bash', 'cat glab-cli/config.yml') }))?.permissionDecision, undefined, 'a dotfiles repo at $HOME')
  assert.equal(decision(await h0(pre('Bash', 'cat a.txt')))?.permissionDecision, undefined, 'no cwd')
  const plain = mkdtempSync(join(tmpdir(), 'guard-plain-'))
  assert.equal(decision(await inHome({ cwd: plain, ...pre('Bash', 'cat a.txt') }))?.permissionDecision, undefined, 'an existing dir outside any work tree')
  // Windows: a home spelled in another case is still home.
  assert.equal(inWorkTree(home, { HOME: home.toUpperCase() }, 'win32'), false)
  assert.equal(inWorkTree(home, { HOME: home.toUpperCase() }, 'linux'), true)
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

test('FACTORY_RUN_ID set: a shell write to a protected path is denied; FACTORY_PROTECTED_PATHS adds globs (#213)', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'guard-protect-'))
  mkdirSync(join(repo, '.git'))
  mkdirSync(join(repo, 'src'))
  const sub = join(repo, 'src')
  const slash = (p) => p.replace(/\\/g, '/')
  assert.deepEqual(protectFacts({}, sub), { extra: [], root: slash(repo), cwd: slash(sub) }, 'unset: no extra globs, root found above cwd')
  assert.deepEqual(protectFacts({ FACTORY_PROTECTED_PATHS: '' }, repo).extra, [], 'set but empty: no extra globs (the defaults stay)')
  assert.deepEqual(protectFacts({ FACTORY_PROTECTED_PATHS: ' infra/** \r\n\n deploy/*.tf\n' }, repo).extra, ['infra/**', 'deploy/*.tf'], 'one glob per line, blanks dropped')
  const write = (command, cwd = repo) => ({ ...pre('Bash', command), cwd })
  const inRun = (paths) => setup({ env: { FACTORY_RUN_ID: 'r1', ...(paths === undefined ? {} : { FACTORY_PROTECTED_PATHS: paths }) } })
  for (const paths of [undefined, '', 'infra/**']) {
    const d = decision(await inRun(paths)(write('echo x > .github/workflows/ci.yml')))
    assert.equal(d.permissionDecision, 'deny', `defaults always on (${JSON.stringify(paths)})`)
    assert.match(d.permissionDecisionReason, /protected path/)
    assert.equal(decision(await inRun(paths)(write('echo x > ../.factory/config.yaml', sub))).permissionDecision, 'deny', 'relative to the repo root, from a subdirectory')
  }
  assert.equal(decision(await inRun('infra/**')(write('echo x > infra/main.tf'))).permissionDecision, 'deny', 'an added glob')
  assert.notEqual(decision(await inRun('')(write('echo x > infra/main.tf')))?.permissionDecision, 'deny', 'not added: allowed')
  assert.equal(decision(await inRun('infra/**')(write('echo x > ../infra/main.tf', sub))).permissionDecision, 'deny', 'an added glob from a subdirectory')
  assert.equal(decision(await inRun(undefined)(write(`echo x > ${slash(repo)}/.github/x`, sub))).permissionDecision, 'deny', 'an absolute path inside the repo')
  assert.notEqual(decision(await inRun(undefined)(write('cat .github/workflows/ci.yml')))?.permissionDecision, 'deny', 'reads pass')
  // The run's own files under .factory/runs pass in every spelling; the rest of .factory stays protected; a listed glob wins (#302).
  for (const c of ['echo x > .factory/runs/12/checklist.md', `echo x > ${slash(repo)}/.factory/runs/12/result.json`, 'echo x > $(git rev-parse --git-common-dir)/../.factory/runs/12/verdict-1.md', 'printf x | tee ./.factory/runs/12/a']) assert.notEqual(decision(await inRun(undefined)(write(c, sub)))?.permissionDecision, 'deny', c)
  assert.notEqual(decision(await inRun(undefined)(write('echo x > ../.factory/runs/12/result.json', sub)))?.permissionDecision, 'deny', 'relative to the root, from a subdirectory')
  for (const c of ['echo x > .factory/config.yaml', 'echo x > .factory/runs/../config.yaml', 'echo x > .factory/runs/x/../../config.yaml', 'echo x > .factory/runs', 'echo x > .factory/runs/12', "Move-Item '.factory\\runs\\12\\.. ' C:\\tmp\\x", 'Move-Item .factory\\runs\\12\\... C:\\tmp\\x', 'rm -r .factory/runs/12', 'mv .factory/runs /tmp/x', 'mv .factory/runs/12 /tmp/x', `echo x > ${slash(repo)}/.factory/runs/../config.yaml`]) assert.equal(decision(await inRun(undefined)(write(c)))?.permissionDecision, 'deny', c)
  assert.equal(decision(await inRun('.factory/runs/*/result.json')(write('echo x > .factory/runs/12/result.json')))?.permissionDecision, 'deny', 'a listed glob under runs/ protects it')
  assert.notEqual(decision(await inRun('.factory/runs/*/result.json')(write('echo x > .factory/runs/12/checklist.md')))?.permissionDecision, 'deny', 'only what the glob names')
  assert.notEqual(decision(await setup({ env: {} })(write('echo x > .github/workflows/ci.yml')))?.permissionDecision, 'deny', 'no factory run: allowed')
})

test('FACTORY_RUN_ID set: the protected-path check denies within the hook budget on worst cases (#213 review)', () => {
  // Through the real entry point, in a child with a timeout: a hook that times out lets the command through.
  const script = fileURLToPath(new URL('./guard.mjs', import.meta.url))
  const repo = mkdtempSync(join(tmpdir(), 'guard-protect-'))
  mkdirSync(join(repo, '.git'))
  // Past the cap the globs are short: Linux caps one environment string at 128 KB, and spawnSync fails past it.
  const globs = (n) => Array.from({ length: n }, (_, i) => (n > 256 ? `p${i}/**` : i % 3 === 0 ? `**/${'d'.repeat(30)}${i}/**/*.yml` : i % 3 === 1 ? `p${i}/**/**/q/**` : `[a-c]*${i}?/x*/**`)).join('\n')
  const deep = 'a/'.repeat(300) + 'b'
  const cases = [
    [254, 'sed -i s/a/b/ ' + Array(3000).fill(deep).join(' ')],
    [254, 'mv ' + Array.from({ length: 3000 }, (_, i) => `$V${i}/${deep}`).join(' ') + ' dist/'],
    [254, 'cp ' + Array.from({ length: 3000 }, (_, i) => `s${i}/${deep}`).join(' ') + ' dist/'],
    [254, 'rm ' + Array.from({ length: 500 }, (_, i) => `x${i}/${'*/'.repeat(40)}y`).join(' ')],
    [254, 'echo x > ' + '*a'.repeat(50000)],
    [254, Array(500).fill('cd src && echo x > a/b/c').join('; ')],
    [254, 'echo ' + '{a,b}'.repeat(4000)],
    [254, 'rm ' + '{a,b}'.repeat(4000)],
    [5000, 'echo x > a'],
  ]
  for (const [n, plain] of cases) {
    // Each case ends in a protected write, so the only right answer is a deny, whatever limit it hits first.
    const command = `${plain}; echo x > .github/workflows/ci.yml`
    const started = Date.now()
    const r = spawnSync(process.execPath, [script, 'PreToolUse'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: 's' }), encoding: 'utf8', timeout: 20000, env: { ...process.env, FACTORY_RUN_ID: 'r1', FACTORY_PROTECTED_PATHS: globs(n), GUARD_OTEL: 'off', FACTORY_EVENTS_FILE: '', CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'guard-test-')) } })
    assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`)
    assert.equal(r.signal, null, `timed out: ${command.slice(0, 40)}`)
    assert.equal(r.status, 0, r.stderr)
    assert.ok(Date.now() - started < 10000, `${Date.now() - started} ms: ${command.slice(0, 40)}`)
    assert.match(r.stdout, /"permissionDecision":"deny"/, `no deny: ${command.slice(0, 40)}`)
  }
})

test('through the real hook, a risky command behind a wrapper option asks; the safe one passes (#282)', () => {
  const script = fileURLToPath(new URL('./guard.mjs', import.meta.url))
  const run = (command) => {
    const r = spawnSync(process.execPath, [script, 'PreToolUse'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/', session_id: 's' }), encoding: 'utf8', timeout: 20000, env: { ...process.env, GUARD_OTEL: 'off', GUARD_UNATTENDED: '', FACTORY_RUN_ID: '', FACTORY_EVENTS_FILE: '', CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'guard-test-')) } })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow'
  }
  for (const c of ["sudo -E bash -c 'rm -rf /x'", "caffeinate -i bash -c 'rm -rf /x'", "time -p bash -c 'git reset --hard'", "timeout -s KILL 5 bash -c 'rm -rf /x'", "env -S 'rm -rf /x'", "watch 'rm -rf /x'", "stdbuf -oL bash -c 'rm -rf /x'", "taskset 1 bash -c 'rm -rf /x'", 'sudo --frobnicate ls']) assert.equal(run(c), 'ask', c)
  for (const c of ['sudo -E git status', 'watch -n 2 git status', 'time -p git status']) assert.equal(run(c), 'allow', c)
})

test('through the real hook, time before a reserved word and chrt without a priority hide no command (#282 review)', () => {
  const script = fileURLToPath(new URL('./guard.mjs', import.meta.url))
  const repo = mkdtempSync(join(tmpdir(), 'guard-time-'))
  mkdirSync(join(repo, '.git'))
  const run = (command, factory) => {
    const r = spawnSync(process.execPath, [script, 'PreToolUse'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: 's' }), encoding: 'utf8', timeout: 20000, env: { ...process.env, GUARD_OTEL: 'off', GUARD_UNATTENDED: '', FACTORY_RUN_ID: factory ? 'r1' : '', FACTORY_PROTECTED_PATHS: '', FACTORY_EVENTS_FILE: '', CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'guard-test-')) } })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'allow'
  }
  const label = 'GH api repos/o/r/issues/1/labels --input b.json'
  // In a factory run: the protected-path check and the label check see the command inside the group or after `!`.
  for (const c of ['time { tee .github/workflows/ci.yml < b; }', 'time ! tee .github/workflows/ci.yml < b', 'time { rm -rf .factory/runs/12; }', `time { ${label}; }`, `time { sudo -E ${label}; }`, `time ! ${label}`, `time -p { ${label}; }`, `time -p ${label}`, `chrt --idle ${label}`]) assert.equal(run(c, true), 'deny', c)
  assert.equal(run('time make', true), 'allow')
  // Out of a run: a recursive delete still asks, a write to .github is not protected.
  for (const c of ['time { rm -rf .factory/runs/12; }', 'time ! rm -rf src', "time -p bash -c 'rm -rf x'", "chrt -i bash -c 'rm -rf x'", "chrt --other bash -c 'rm -rf x'", "chrt -f 10 bash -c 'rm -rf x'"]) assert.equal(run(c, false), 'ask', c)
  for (const c of ['time { tee .github/workflows/ci.yml < b; }', 'time make', 'chrt -b make']) assert.equal(run(c, false), 'allow', c)
})

test('a long chain of commands is judged in linear time, and the decision is the same as for a short one', () => {
  const script = fileURLToPath(new URL('./guard.mjs', import.meta.url))
  const run = (command) => {
    const started = Date.now()
    const r = spawnSync(process.execPath, [script, 'PreToolUse'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/', session_id: 's' }), encoding: 'utf8', timeout: 20000, env: { ...process.env, GUARD_OTEL: 'off', FACTORY_EVENTS_FILE: '', CLAUDE_PLUGIN_DATA: mkdtempSync(join(tmpdir(), 'guard-test-')) } })
    assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`)
    assert.equal(r.status, 0, r.stderr)
    return { out: r.stdout, ms: Date.now() - started }
  }
  const chain = (n) => 'echo x;'.repeat(n)
  assert.equal(run(chain(50)).out, '')
  assert.match(run(`${chain(50)} rm -rf /`).out, /"permissionDecision":"deny"/)
  // Quadratic, 20,000 segments took ~49 s; linear takes ~0.8 s locally. 8 s leaves ~10x for a slow CI runner.
  const big = run(chain(20000))
  assert.equal(big.out, '')
  assert.ok(big.ms < 8000, `${big.ms} ms for 20,000 segments`)
  assert.match(run(`${chain(20000)} rm -rf /`).out, /"permissionDecision":"deny"/)
})

test('FACTORY_RUN_ID set: the approval and takeover labels (default or the repo\'s configured ones) cannot be added; unset, they can', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'guard-factory-'))
  const configured = mkdtempSync(join(tmpdir(), 'guard-factory-'))
  mkdirSync(join(configured, '.factory'))
  writeFileSync(join(configured, '.factory', 'config.yaml'), 'labels:\n  approval: go-ahead\n  claimed: x\n  takeover: hand-over # set by an approver\n')
  const crlf = mkdtempSync(join(tmpdir(), 'guard-factory-'))
  mkdirSync(join(crlf, '.factory'))
  writeFileSync(join(crlf, '.factory', 'config.yaml'), 'labels:\r\n  approval: "go ahead"\r\n  claimed: x\r\n')
  assert.deepEqual(factoryLabels(crlf), { approval: 'go ahead', takeover: 'factory-takeover' }, 'CRLF and a quoted name with a space; an unset key keeps its default')
  assert.deepEqual(factoryLabels(configured), { approval: 'go-ahead', takeover: 'hand-over' })
  assert.deepEqual(factoryLabels(cwd), { approval: 'agent-ok', takeover: 'factory-takeover' }, 'no config: the defaults')
  const config = (text) => {
    const d = mkdtempSync(join(tmpdir(), 'guard-factory-'))
    mkdirSync(join(d, '.factory'))
    if (text === null) mkdirSync(join(d, '.factory', 'config.yaml'))
    else writeFileSync(join(d, '.factory', 'config.yaml'), text)
    return d
  }
  assert.deepEqual(factoryLabels(config('version: 1\n')), { approval: 'agent-ok', takeover: 'factory-takeover' }, 'no labels key: the defaults')
  assert.deepEqual(factoryLabels(config('labels: {approval: go-ahead, takeover: hand-over}\n')), { approval: 'agent-ok', takeover: 'factory-takeover', unsure: true, extra: ['go-ahead', 'hand-over'] }, 'flow style: fail closed')
  assert.deepEqual(factoryLabels(config('labels:\n  approval:\n    - x\n')), { approval: 'agent-ok', takeover: 'factory-takeover', unsure: true, extra: [] }, 'a key without a plain value: fail closed')
  assert.deepEqual(factoryLabels(config(null)), { approval: 'agent-ok', takeover: 'factory-takeover', unsure: true, extra: [] }, 'unreadable: fail closed')
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
  const takeover = decision(await inRun(add('factory-takeover', cwd)))
  assert.equal(takeover.permissionDecision, 'deny')
  assert.match(takeover.permissionDecisionReason, /takeover label/)
  assert.equal(decision(await inRun(add('hand-over', configured))).permissionDecision, 'deny', 'the configured takeover label')
  assert.equal(decision(await setup({ env: {} })(add('factory-takeover', cwd))), undefined, 'an attended run removes or adds it freely')
  const flow = config('labels: {approval: go-ahead}\n')
  const unsure = decision(await inRun(add('needs-owner', flow)))
  assert.equal(unsure.permissionDecision, 'deny', 'an unparsable config denies every label change in a run')
  assert.match(unsure.permissionDecisionReason, /could not be read/)
  assert.equal(decision(await inRun({ ...pre('Bash', 'gh issue view 70 --json labels'), cwd: flow })), undefined, 'reads still pass')
  assert.equal(decision(await setup({ env: {} })(add('needs-owner', flow))), undefined, 'outside a run: unchanged')
  assert.equal(decision(await setup({ env: {} })(add('agent-ok', cwd))), undefined, 'no run active: allowed')
})

test('SessionStart: one guard.session per session and process, with the plugin versions', async () => {
  const cache = join(mkdtempSync(join(tmpdir(), 'guard-test-')), 'cache', 'mkt')
  for (const [p, v] of [['guard', '1.2.3'], ['dev-tools', '4.5.6']]) {
    mkdirSync(join(cache, p, v, '.claude-plugin'), { recursive: true })
    writeFileSync(join(cache, p, v, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: p, version: v }))
  }
  const events = []
  const dataDir = mkdtempSync(join(tmpdir(), 'guard-test-'))
  const h = (processId, pluginRoot = join(cache, 'guard', '1.2.3')) =>
    handle({ session_id: 's1', cwd: '/', hook_event_name: 'SessionStart', source: 'startup' }, { dataDir, env: {}, hostFacts: calm, run: async () => null, pythonManager, processId, pluginRoot, emit: async (...a) => events.push(a) })
  const out = await h(10)
  assert.deepEqual(out, {})
  assert.deepEqual(events.map(([e, a]) => [e, a.session_id, a.source, a.plugin_version_guard, a.plugin_version_dev_tools]), [['guard.session', 's1', 'startup', '1.2.3', '4.5.6']])
  await h(10)
  assert.equal(events.length, 1, 'a compact or second hook of the same process is silent')
  await h(11)
  assert.equal(events.length, 2, 'a resume is a new process')
  assert.deepEqual(await h(12, join(cache, 'missing', 'nothing')), {}, 'an unreadable plugin root never throws and prints nothing')
})
