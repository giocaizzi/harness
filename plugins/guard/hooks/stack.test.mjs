// The stacked-PR hint through the hook: shown once per agent, off with GUARD_STACK_HINT, and the same in opencode and pi.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handle, pythonManager } from './guard.mjs'
import { GuardPlugin } from './opencode.mjs'
import guardExtension from './pi.mjs'

delete process.env.GUARD_STACK_HINT
delete process.env.GUARD_UNATTENDED
for (const k of ['FACTORY_RUN_ID', 'FACTORY_TICKET', 'FACTORY_ATTENDED_RUN_ID', 'FACTORY_ATTENDED_TICKET']) delete process.env[k]

// feat/b (HEAD) is built on feat/a (#7), which is not in main.
const fakeRun = () => {
  const calls = []
  const run = async (argv) => {
    const a = argv.join(' ')
    calls.push(a)
    if (argv[1] === 'symbolic-ref') return 'origin/main\n'
    if (argv[1] === 'rev-parse') return 'feat/b\n'
    if (argv[0] === 'gh' && argv[2] === 'view') return JSON.stringify({ headRefName: 'feat/b', baseRefName: 'main' })
    if (argv[0] === 'gh' && argv[2] === 'list') return JSON.stringify([{ number: 7, headRefName: 'feat/a' }])
    if (argv[1] === 'merge-base') return argv[4] === 'origin/main' ? null : ''
    return null
  }
  return { run, calls }
}
const tmp = () => mkdtempSync(join(tmpdir(), 'stack-test-'))
const stackCalls = (calls) => calls.filter((c) => /symbolic-ref|merge-base|gh pr list|gh pr view|gh repo view/.test(c))
const decision = (out) => (out.stdout ? JSON.parse(out.stdout).hookSpecificOutput : undefined)
const pre = (command, extra = {}) => ({ session_id: 's1', cwd: '/', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra })
const setup = (env = {}) => {
  const { run, calls } = fakeRun()
  const dataDir = tmp()
  const h = (input) => handle(input, { dataDir, env, hostFacts: async () => ({}), run, pythonManager })
  return { h, calls }
}
const load = (extra = {}) => ({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: '/ship', ...extra })

test('the stack hint comes once per agent, each agent getting its own', async () => {
  const { h } = setup()
  await h(load())
  const first = decision(await h(pre('gh pr create --fill')))
  assert.match(first.additionalContext, /#7 \(`feat\/a`\).*targets `main`/)
  assert.equal(first.permissionDecision, undefined)
  assert.equal(decision(await h(pre('gh pr create --fill'))), undefined)
  assert.match(decision(await h(pre('gh pr merge 9 --squash', { agent_id: 'a2' }))).additionalContext, /#7/)
  assert.equal(decision(await h(pre('gh pr merge 9 --squash', { agent_id: 'a2' }))), undefined)
})

test('GUARD_STACK_HINT off (also 0, false) gathers nothing and shows nothing', async () => {
  for (const v of ['off', '0', 'false']) {
    const { h, calls } = setup({ GUARD_STACK_HINT: v })
    await h(load())
    assert.equal(decision(await h(pre('gh pr create --fill'))), undefined, v)
    assert.deepEqual(stackCalls(calls), [], v)
  }
})

test('other commands and a spent hint cost no lookups', async () => {
  const { h, calls } = setup()
  await h(load())
  await h(pre('gh pr view 3'))
  await h(pre('git status'))
  assert.deepEqual(stackCalls(calls), [])
  await h(pre('gh pr create --fill'))
  const n = calls.length
  await h(pre('gh pr create --fill'))
  assert.equal(calls.length, n)
})

test('opencode and pi: the hint reaches the model through the tool output, once', async () => {
  const deps = () => ({ hostFacts: async () => ({}), run: fakeRun().run, emit: async () => {}, launch: () => null, dataDir: tmp() })
  const hooks = await GuardPlugin({ client: {}, directory: tmp() }, deps())
  // the first `gh pr create` is the skill rule's once-per-session deny, the retry carries the hint
  await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 'e', callID: 'c0' }, { args: { command: 'gh pr create --fill' } }))
  const output = { args: { command: 'gh pr create --fill' }, output: 'done' }
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'e', callID: 'c1' }, output)
  await hooks['tool.execute.after']({ tool: 'bash', callID: 'c1', args: output.args }, output)
  assert.match(output.output, /^done\n\n.*#7 \(`feat\/a`\)/)

  const handlers = {}
  guardExtension({ on: (e, f) => (handlers[e] = f), sendUserMessage: async () => {} }, deps())
  const ctx = { cwd: tmp(), sessionManager: { getSessionId: () => 'p' } }
  const call = (id) => handlers.tool_call({ toolName: 'bash', toolCallId: id, input: { command: 'gh pr create --fill' } }, ctx)
  const result = (id) => handlers.tool_result({ toolName: 'bash', toolCallId: id, input: {}, content: [] }, ctx)
  assert.equal((await call('t0'))?.block, true)
  await call('t1')
  assert.match((await result('t1')).content[0].text, /#7 \(`feat\/a`\)/)
  await call('t2')
  assert.equal(await result('t2'), undefined)
})
