#!/usr/bin/env node
// End-to-end check of each installed harness against a scripted model (mock-llm.mjs), with no login and
// nothing touching the real config: every harness gets a throwaway home. For each one it installs this
// checkout the documented way, asks the model to run `pip install requests` in a uv project, and checks
// that the guard's deny reached the model, that every skill and agent is in its prompt, that a risky
// command is not run, and that a skill invoked with an argument gets it. A harness whose CLI is missing
// is skipped (failed with E2E_REQUIRE=1). Usage: node tests/e2e/run.mjs [harness...]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inventory } from '../../scripts/parity.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MOCK = join(REPO, 'tests', 'e2e', 'mock-llm.mjs')
// npm installs each CLI as a .cmd shim on Windows, which only runs through cmd.exe and its quoting. Run the
// package's own entry point instead: a .js bin under node, a native one directly. Elsewhere, the name on PATH.
const PACKAGES = { codex: '@openai/codex', opencode: 'opencode-ai', pi: '@earendil-works/pi-coding-agent' }
function cli(name) {
  if (process.platform !== 'win32' || !PACKAGES[name]) return [name]
  const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).stdout.trim()
  const pkg = join(root, PACKAGES[name])
  if (!existsSync(join(pkg, 'package.json'))) return [name]
  const bin = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).bin
  const file = join(pkg, typeof bin === 'string' ? bin : bin[name])
  return file.endsWith('.js') ? [process.execPath, file] : [file]
}

function sh(cmd, args, opts = {}) {
  const [exe, ...pre] = cmd === process.execPath ? [cmd] : cli(cmd)
  const r = spawnSync(exe, [...pre, ...args], { encoding: 'utf8', timeout: 180_000, ...opts })
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`)
  return r
}
// The runs must not reach the real collector: guard decisions from scripted sessions polluted the agent-ops data.
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GUARD_)?OTEL_/.test(k)))
const has = (cmd) => sh(cmd, ['--version'], { allowFail: true }).status === 0

// Start the mock on a free port with a scripted command; resolves to { port, log, stop }.
async function mock(command, root, extraEnv = {}) {
  const log = join(root, 'mock.jsonl')
  const entries = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  // Wait for the mock to listen: a fixed sleep raced slow Windows runners, whose harnesses then found no server.
  // A taken port, or no `ready` within 20 s, retries on another port; a crash prints its error to the CI log.
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 40_000 + Math.floor(Math.random() * 20_000)
    const child = spawn(process.execPath, [MOCK, String(port)], { env: { ...BASE_ENV, MOCK_COMMAND: command, MOCK_LOG: log, ...extraEnv }, stdio: ['ignore', 'pipe', 'inherit'] })
    const ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 20_000)
      child.stdout.on('data', (d) => String(d).includes('ready') && (clearTimeout(timer), resolve(true)))
      child.on('exit', () => (clearTimeout(timer), resolve(false)))
    })
    if (ready) return { port, entries, stop: () => child.kill() }
    child.kill()
  }
  throw new Error('mock LLM did not start')
}

const piModels = (env, port) =>
  writeFileSync(join(env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock' }] } } }))

const project = (root) => {
  const dir = join(root, 'proj')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'uv.lock'), '')
  return dir
}

// Per harness: install into `home`, then run one prompt against the mock in `cwd`.
const HARNESSES = {
  codex: {
    install(home) {
      const env = { ...BASE_ENV, CODEX_HOME: home }
      sh('codex', ['plugin', 'marketplace', 'add', REPO], { env })
      const market = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'))
      for (const { name } of market.plugins) sh('codex', ['plugin', 'add', `${name}@giocaizzi-harness`], { env })
      sh(process.execPath, [join(REPO, 'scripts', 'install.mjs'), 'codex'], { env })
      return env
    },
    run(env, cwd, port, prompt = ['run the command']) {
      const provider = `model_providers.mock={name="mock",base_url="http://127.0.0.1:${port}/v1",wire_api="responses"}`
      return sh('codex', ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-s', 'read-only', '-c', 'model_provider=mock', '-c', 'model=mock', '-c', provider, ...prompt], { env, cwd, input: '', allowFail: true })
    },
  },
  opencode: {
    install(home) {
      const env = { ...BASE_ENV, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), OPENCODE_DISABLE_CLAUDE_CODE: '1' }
      sh(process.execPath, [join(REPO, 'scripts', 'install.mjs'), 'opencode'], { env })
      return env
    },
    run(env, cwd, port, prompt = ['run the command']) {
      const config = {
        $schema: 'https://opencode.ai/config.json',
        model: 'mock/mock',
        permission: { bash: 'allow', edit: 'allow' },
        provider: { mock: { npm: '@ai-sdk/openai-compatible', name: 'mock', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'mock' }, models: { mock: { name: 'mock' } } } },
      }
      writeFileSync(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), JSON.stringify(config))
      return sh('opencode', ['run', ...prompt], { env: { ...env, PWD: cwd }, cwd, input: '', allowFail: true })
    },
  },
  pi: {
    install(home) {
      const env = { ...BASE_ENV, PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1' }
      sh('pi', ['install', REPO], { env })
      return env
    },
    run(env, cwd, port, prompt = ['run the command']) {
      piModels(env, port)
      return sh('pi', ['-p', '--no-session', '--model', 'mock/mock', ...prompt], { env: { ...env, PWD: cwd }, cwd, input: '', allowFail: true })
    },
    // RPC mode, for what only a UI shows (an extension's `setStatus` arrives as an event): one prompt, stdin held
    // open until the run ends, since pi exits on its end.
    rpc(env, cwd, port, prompt = 'run the command') {
      piModels(env, port)
      const [exe, ...pre] = cli('pi')
      return new Promise((resolve) => {
        const child = spawn(exe, [...pre, '--mode', 'rpc', '--no-session', '--model', 'mock/mock'], { env: { ...env, PWD: cwd }, cwd, windowsHide: true })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => child.kill(), 180_000)
        child.stdout.on('data', (d) => {
          stdout += d
          if (stdout.includes('"type":"agent_end"')) child.stdin.end()
        })
        child.stderr.on('data', (d) => (stderr += d))
        child.on('close', () => (clearTimeout(timer), resolve({ stdout, stderr })))
        child.stdin.write(`${JSON.stringify({ type: 'prompt', message: prompt })}\n`)
      })
    },
  },
}

// What each harness must show. `skill`/`agent`: how its prompt lists one (Codex `- plugin:skill: …` and
// `name: {`, opencode and pi `<name>skill</name>` and `- name: …`; pi lists the agents in the dev-tools
// `subagent` tool). `asked`: the harness's own prompt for a plain risky command, which a non-interactive run
// rejects (Codex's prompt rules, opencode's bash ask entries, pi's confirm dialog without a UI). `invoke`: the
// prompt argv that runs a skill with an argument (Codex needs the plugin prefix: a bare `$wt` loads nothing);
// `substitutes`: whether the harness replaces `$ARGUMENTS` in the skill body (pi and Codex append the text instead).
const EXPECT = {
  codex: { invoke: (skill, arg) => [`$dev-tools:${skill} ${arg}`], substitutes: false, skill: (s) => `- ${s.plugin}:${s.name}: `, agent: (a) => `${a.name}: {`, asked: /approval required by policy/ },
  opencode: { invoke: (skill, arg) => ['--command', skill, arg], substitutes: true, skill: (s) => `<name>${s.name}</name>`, agent: (a) => `- ${a.name}: `, asked: /permission requested: bash \(git reset --hard/ },
  pi: { invoke: (skill, arg) => [`/skill:${skill} ${arg}`], substitutes: false, skill: (s) => `<name>${s.name}</name>`, agent: (a) => `- ${a.name}: `, asked: /Risky command/ },
}
const { skills: SKILLS, agents: AGENTS } = inventory()
const ARG = 'e2e-arg-4242'
// A line of the wt skill's body, so the probe knows the skill itself (not just its listing) reached the model.
const WT_BODY = 'There is no fixed cap on worktrees or agents'

// Codex hook outputs only a live run can confirm: a failing stop check's block reaches the model (Codex rejects a
// Stop output with keys it does not know), and a PreToolUse hint reaches it as context.
async function codexOnly(h, env, root) {
  const failures = []
  const seen = async (command, cwd, runEnv, text) => {
    const m = await mock(command, root)
    const out = h.run(runEnv, cwd, m.port)
    m.stop()
    const ok = m.entries().some((e) => e.prompt.includes(text))
    rmSync(join(root, 'mock.jsonl'), { force: true })
    return ok ? null : `${out.stdout?.slice(-600)}\n${out.stderr?.slice(-600)}`
  }
  const dir = join(root, 'stopproj')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'Makefile'), 'check:\n\t@echo e2e-check-failed; exit 1\n')
  // `force`: a macOS CI runner sits above the guard's load cap (30-43), which would defer the check instead of blocking.
  const stop = await seen('echo hi', dir, { ...env, GUARD_STOP_CHECK: 'force' }, 'e2e-check-failed')
  if (stop) failures.push(`stop: the failed check did not reach the model\n${stop}`)
  // Through the heavy wrapper (the guard's documented bypass): on a loaded CI runner the host deny would otherwise
  // block the bare `pytest` before the hint is sent.
  const hint = await seen('scripts/heavy.sh pytest -q', project(root), env, 'Skill hint (')
  if (hint) failures.push(`hint: the pytest skill hint did not reach the model\n${hint}`)
  return failures
}

async function check(name) {
  const h = HARNESSES[name]
  const root = mkdtempSync(join(tmpdir(), `harness-e2e-${name}-`))
  const failures = []
  try {
    mkdirSync(join(root, 'home'), { recursive: true })
    const env = h.install(join(root, 'home'))
    const cwd = project(root)
    for (const [command, expect] of [
      ['pip install requests', /uses uv/],
      // Harmless: every harness runs in the throwaway project, which is no git repo (opencode takes its directory
      // from PWD, not the spawn cwd, so run() sets PWD for it and pi), and a wrongly allowed run changes nothing.
      ['git reset --hard', EXPECT[name].asked],
      // A form the harness's prompt rules do not cover: the guard denies it (pi still confirms).
      ['cd . && rm -rf ~/harness-e2e-does-not-exist', /cannot ask|Risky command/],
    ]) {
      const m = await mock(command, root)
      const out = h.run(env, cwd, m.port)
      m.stop()
      const entries = m.entries()
      const result = entries.map((e) => e.result).find((r) => r !== null) ?? ''
      // opencode ends the turn on a rejected ask; its `run` output names the request.
      const seen = expect === EXPECT[name].asked ? `${result}\n${out.stdout}\n${out.stderr}` : result
      if (!expect.test(seen)) failures.push(`${command}: tool result ${JSON.stringify(result.slice(0, 200))} does not match ${expect}\n${out.stdout?.slice(-600)}\n${out.stderr?.slice(-600)}`)
      if (command.startsWith('pip')) {
        const prompt = entries.map((e) => e.prompt).join('\n')
        const missing = [...SKILLS.filter((s) => !prompt.includes(EXPECT[name].skill(s))).map((s) => `skill ${s.name}`), ...AGENTS.filter((a) => !prompt.includes(EXPECT[name].agent(a))).map((a) => `agent ${a.name}`)]
        if (missing.length) failures.push(`not in the model prompt: ${missing.join(', ')}`)
      }
      rmSync(join(root, 'mock.jsonl'), { force: true })
    }
    // A skill invoked with an argument: its body and the argument both reach the model, and `$ARGUMENTS` is
    // substituted only where `substitutes` says so (the skills name the argument in words for the others).
    {
      const m = await mock('echo hello', root)
      const out = h.run(env, cwd, m.port, EXPECT[name].invoke('wt', ARG))
      m.stop()
      const prompt = m.entries().map((e) => e.prompt).join('\n')
      const seen = { body: prompt.includes(WT_BODY), arg: prompt.includes(ARG), literal: prompt.includes('$ARGUMENTS') }
      if (!seen.body || !seen.arg || seen.literal === EXPECT[name].substitutes) failures.push(`skill argument: ${JSON.stringify(seen)}\n${out.stdout?.slice(-600)}\n${out.stderr?.slice(-600)}`)
      rmSync(join(root, 'mock.jsonl'), { force: true })
    }
    // sounds' Stop hook ran from the installed plugin: it keeps the session's alert levels in the plugin data dir.
    if (name === 'codex' && !readdirSync(join(root, 'home'), { recursive: true }).some((f) => /sounds-codex-.*\.json$/.test(f))) failures.push('sounds: the Stop hook left no state')
    if (name === 'codex') failures.push(...(await codexOnly(h, env, root)))
    if (name === 'pi') {
      // The subagent tool: the parent delegates to scout, whose own session runs the command and answers "done";
      // meanwhile hud's footer names the running subagent and its model.
      const m = await mock('echo from-scout', root, { MOCK_SUBAGENT: '1' })
      const out = await h.rpc(env, cwd, m.port)
      m.stop()
      const results = m.entries().map((e) => e.result ?? '')
      if (!results.some((r) => r.includes('from-scout')) || !results.includes('done'))
        failures.push(`subagent: results ${JSON.stringify(results).slice(0, 300)}\n${out.stdout?.slice(-600)}\n${out.stderr?.slice(-600)}`)
      const footer = out.stdout.split('\n').filter((l) => l.includes('"statusKey":"hud"')).map((l) => JSON.parse(l).statusText)
      if (!footer.some((t) => t.includes('scout · mock'))) failures.push(`hud: no footer with the running subagent: ${JSON.stringify(footer).slice(0, 300)}\n${out.stderr?.slice(-600)}`)
    }
  } catch (err) {
    failures.push(String(err?.message ?? err))
  } finally {
    // A harness's background work (Codex's plugin clone) can still be writing here: retry, and never let cleanup fail the run.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    } catch {
      // a leftover temp dir is harmless
    }
  }
  return failures
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(HARNESSES)
let failed = false
for (const name of wanted) {
  if (!has(name)) {
    // CI sets E2E_REQUIRE=1: there a missing CLI is a failed install, not a skip.
    failed ||= Boolean(process.env.E2E_REQUIRE)
    console.log(`${process.env.E2E_REQUIRE ? '✗' : '-'} ${name}: CLI not installed`)
    continue
  }
  const failures = await check(name)
  failed ||= failures.length > 0
  console.log(failures.length ? `✗ ${name}\n  ${failures.join('\n  ')}` : `✓ ${name}`)
}
process.exit(failed ? 1 : 0)
