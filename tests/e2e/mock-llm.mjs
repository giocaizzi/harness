// A scripted model for end-to-end hook tests, so no harness needs a login. It speaks the OpenAI Responses API
// (Codex) and Chat Completions (opencode, pi). The first turn of a conversation calls the harness's shell tool
// with MOCK_COMMAND; once the request carries that call's result, it records the result in MOCK_LOG and answers
// "done". Usage: MOCK_COMMAND='pip install x' MOCK_LOG=/tmp/log.jsonl node mock-llm.mjs <port>
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createServer } from 'node:http'

const command = process.env.MOCK_COMMAND ?? 'echo hello'
const log = (entry) => process.env.MOCK_LOG && appendFileSync(process.env.MOCK_LOG, JSON.stringify(entry) + '\n')

// The shell tool each harness offers, and the arguments it takes.
function shellCall(tools = []) {
  const names = tools.map((t) => t.name ?? t.function?.name)
  // MOCK_SUBAGENT=1: delegate to scout through pi's `subagent` tool or opencode's `task`, so its child session runs too.
  if (process.env.MOCK_SUBAGENT && names.includes('subagent')) return { name: 'subagent', args: { agent: 'scout', task: 'run the command' } }
  if (process.env.MOCK_SUBAGENT && names.includes('task')) return { name: 'task', args: { description: 'run the command', prompt: 'run the command', subagent_type: 'scout' } }
  // MOCK_SPAWN='{"agent_type":…}': call Codex's spawn_agent (in its multi_agent namespace) with those arguments.
  const spawnNs = tools.find((t) => t.type === 'namespace' && t.tools?.some((f) => f.name === 'spawn_agent'))
  if (process.env.MOCK_SPAWN && spawnNs) return { name: 'spawn_agent', namespace: spawnNs.name, args: JSON.parse(process.env.MOCK_SPAWN) }
  if (names.includes('exec_command')) return { name: 'exec_command', args: { cmd: command } }
  const bash = names.find((n) => /^bash$/i.test(n))
  if (bash) return { name: bash, args: { command, description: 'run the command' } }
  return null
}

// The text of the shell call's result, when the conversation already has one.
function toolResult(body) {
  for (const item of body.input ?? []) if (item.type === 'function_call_output') return String(item.output?.content ?? item.output ?? '')
  for (const m of body.messages ?? []) if (m.role === 'tool') return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  return null
}

const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])

const sse = (res, data, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)

function responses(res, call, text) {
  const ev = (type, d) => sse(res, { type, ...d }, type)
  ev('response.created', { response: { id: 'r1' } })
  const item = call
    ? { type: 'function_call', id: 'fc1', call_id: 'call_1', name: call.name, ...(call.namespace ? { namespace: call.namespace } : {}), arguments: JSON.stringify(call.args) }
    : { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text }] }
  ev('response.output_item.done', { item })
  ev('response.completed', { response: { id: 'r1', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
}

function chat(res, call, text) {
  const chunk = (delta, finish = null) =>
    sse(res, { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })
  if (call) chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] })
  else chunk({ role: 'assistant', content: text })
  chunk({}, call ? 'tool_calls' : 'stop')
  sse(res, { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  sse(res, '[DONE]')
}

createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      // not JSON: answer with text
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }))
    }
    // MOCK_PLUGIN_UPDATE=<dir>: a plugin version that appears once the session runs (a manifest only), as an update would.
    if (process.env.MOCK_PLUGIN_UPDATE && !existsSync(process.env.MOCK_PLUGIN_UPDATE)) {
      mkdirSync(join(process.env.MOCK_PLUGIN_UPDATE, '.claude-plugin'), { recursive: true })
      writeFileSync(join(process.env.MOCK_PLUGIN_UPDATE, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: basename(process.env.MOCK_PLUGIN_UPDATE) }))
    }
    const result = toolResult(body)
    const call = result === null ? shellCall(body.tools) : null
    // prompt: every string the harness sent, so run.mjs can look for each skill and agent it must offer.
    log({ url: req.url, call: call?.name ?? null, result, prompt: strings(body).join('\n') })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    ;(req.url.includes('/responses') ? responses : chat)(res, call, 'done')
    res.end()
  })
})
  // A taken port exits non-zero; `ready` on stdout tells the runner it may start the harness.
  .on('error', () => process.exit(1))
  .listen(Number(process.argv[2] ?? 4011), '127.0.0.1', () => process.stdout.write('ready\n'))
