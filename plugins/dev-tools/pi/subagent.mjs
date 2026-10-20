// pi extension: the plugins' agents (scout, escalate, api-reviewer, verifier) as a `subagent` tool, since pi has no subagents.
// Each call runs the agent in its own `pi -p --no-session` process with the agent's prompt appended and its tools
// narrowed, on the session's model; the final text comes back as the tool result. Loaded from the root package.json.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Claude tool names in an agent's `tools` -> pi's built-in tools. No `tools` key: pi's defaults.
const TOOLS = { read: ['read'], grep: ['grep'], glob: ['find', 'ls'], bash: ['bash'], powershell: ['powershell'], edit: ['edit'], multiedit: ['edit'], write: ['write'] }

// The Claude-format agents every plugin ships (agents/*.md): name, description, pi tools, prompt body.
export function loadAgents(root = PLUGINS) {
  const agents = []
  for (const plugin of readdirSync(root)) {
    const dir = join(root, plugin, 'agents')
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(readFileSync(join(dir, file), 'utf8'))
      if (!m) continue
      const fm = Object.fromEntries([...m[1].matchAll(/^(\w+):\s*(.*)$/gm)].map(([, k, v]) => [k, v.trim()]))
      const tools = fm.tools ? [...new Set(fm.tools.split(',').flatMap((t) => TOOLS[t.trim().toLowerCase()] ?? []))] : null
      agents.push({ name: fm.name || basename(file, '.md'), description: fm.description ?? '', tools, prompt: m[2].trim() })
    }
  }
  return agents
}

// argv for one run, after the pi entry point.
export function piArgs(agent, task, promptFile, model) {
  return ['-p', '--no-session', ...(model ? ['--model', model] : []), ...(agent.tools?.length ? ['--tools', agent.tools.join(',')] : []), '--append-system-prompt', promptFile, `Task: ${task}`]
}

// How to start pi again: the running entry point under the same node, else `pi` on PATH.
const piCommand = () => (process.argv[1] && existsSync(process.argv[1]) ? [process.execPath, process.argv[1]] : ['pi'])

function run(argv, cwd, signal) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => resolve({ code: 1, out, err: err + e.message }))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

export default function subagentExtension(pi, deps = {}) {
  const agents = (deps.loadAgents ?? loadAgents)()
  if (!agents.length) return
  const list = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n')
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: `Run a task in a separate pi session as one of these agents, and get its final answer:\n${list}`,
    parameters: {
      type: 'object',
      properties: { agent: { type: 'string', enum: agents.map((a) => a.name), description: 'Agent name' }, task: { type: 'string', description: 'Self-contained brief: goal, scope, what to report' } },
      required: ['agent', 'task'],
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const agent = agents.find((a) => a.name === params.agent)
      if (!agent) throw new Error(`Unknown agent ${params.agent}; one of ${agents.map((a) => a.name).join(', ')}`)
      const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-'))
      try {
        const file = join(dir, `${agent.name}.md`)
        writeFileSync(file, agent.prompt)
        const model = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined
        const r = await (deps.run ?? run)([...piCommand(), ...piArgs(agent, params.task, file, model)], ctx?.cwd, signal)
        if (r.code !== 0) throw new Error(`${agent.name} failed (exit ${r.code}): ${(r.err || r.out).trim().slice(-2000)}`)
        return { content: [{ type: 'text', text: r.out.trim() || '(no output)' }], details: undefined }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  })
}
