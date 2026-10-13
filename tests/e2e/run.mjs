#!/usr/bin/env node
// End-to-end check of each installed harness against a scripted model (mock-llm.mjs), with no login and
// nothing touching the real config: every harness gets a throwaway home. For each one it installs this
// checkout the documented way, asks the model to run `pip install requests` in a uv project, and checks
// that the guard's deny reached the model, that the skills and the scout agent are in its prompt, and that a
// risky command is not run. A harness whose CLI is missing is skipped (failed with E2E_REQUIRE=1). Usage: node tests/e2e/run.mjs [harness...]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const has = (cmd) => sh(cmd, ['--version'], { allowFail: true }).status === 0

// Start the mock on a free port with a scripted command; resolves to { port, log, stop }.
async function mock(command, root, extraEnv = {}) {
  const log = join(root, 'mock.jsonl')
  const port = 40_000 + Math.floor(Math.random() * 20_000)
  const child = spawn(process.execPath, [MOCK, String(port)], { env: { ...process.env, MOCK_COMMAND: command, MOCK_LOG: log, ...extraEnv }, stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 300))
  const entries = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return { port, entries, stop: () => child.kill() }
}

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
      const env = { ...process.env, CODEX_HOME: home }
      sh('codex', ['plugin', 'marketplace', 'add', REPO], { env })
      for (const p of ['guard', 'dev-tools', 'sounds']) sh('codex', ['plugin', 'add', `${p}@giocaizzi-harness`], { env })
      sh(process.execPath, [join(REPO, 'scripts', 'install.mjs'), 'codex'], { env })
      return env
    },
    run(env, cwd, port) {
      const provider = `model_providers.mock={name="mock",base_url="http://127.0.0.1:${port}/v1",wire_api="responses"}`
      return sh('codex', ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-s', 'read-only', '-c', 'model_provider=mock', '-c', 'model=mock', '-c', provider, 'run the command'], { env, cwd, input: '', allowFail: true })
    },
  },
  opencode: {
    install(home) {
      const env = { ...process.env, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), OPENCODE_DISABLE_CLAUDE_CODE: '1' }
      sh(process.execPath, [join(REPO, 'scripts', 'install.mjs'), 'opencode'], { env })
      return env
    },
    run(env, cwd, port) {
      const config = {
        $schema: 'https://opencode.ai/config.json',
        model: 'mock/mock',
        permission: { bash: 'allow', edit: 'allow' },
        provider: { mock: { npm: '@ai-sdk/openai-compatible', name: 'mock', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'mock' }, models: { mock: { name: 'mock' } } } },
      }
      writeFileSync(join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), JSON.stringify(config))
      return sh('opencode', ['run', 'run the command'], { env, cwd, input: '', allowFail: true })
    },
  },
  pi: {
    install(home) {
      const env = { ...process.env, PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1' }
      sh('pi', ['install', REPO], { env })
      return env
    },
    run(env, cwd, port) {
      const models = { providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'mock' }] } } }
      writeFileSync(join(env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify(models))
      return sh('pi', ['-p', '--no-session', '--model', 'mock/mock', 'run the command'], { env, cwd, input: '', allowFail: true })
    },
  },
}

// What each harness must show; pi reaches the agents through the dev-tools `subagent` tool. `asked`: the
// harness's own prompt for a plain risky command, which a non-interactive run rejects (Codex's prompt rules,
// opencode's bash ask entries, pi's confirm dialog without a UI).
const EXPECT = {
  codex: { agents: true, asked: /approval required by policy/ },
  opencode: { agents: true, asked: /permission requested: bash \(git reset --hard/ },
  pi: { agents: true, asked: /Risky command/ },
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
      // Plain and harmless here (the project is no git repo), so a wrongly allowed run changes nothing.
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
        if (!entries.some((e) => e.skills)) failures.push('skills (conventional-commits) not in the model prompt')
        if (EXPECT[name].agents && !entries.some((e) => e.agent)) failures.push('agent scout not in the model prompt')
      }
      rmSync(join(root, 'mock.jsonl'), { force: true })
    }
    // sounds' Stop hook ran from the installed plugin: it keeps the session's alert levels in the plugin data dir.
    if (name === 'codex' && !readdirSync(join(root, 'home'), { recursive: true }).some((f) => /sounds-codex-.*\.json$/.test(f))) failures.push('sounds: the Stop hook left no state')
    if (name === 'pi') {
      // The subagent tool: the parent delegates to scout, whose own session runs the command and answers "done".
      const m = await mock('echo from-scout', root, { MOCK_SUBAGENT: '1' })
      const out = h.run(env, cwd, m.port)
      m.stop()
      const results = m.entries().map((e) => e.result ?? '')
      if (!results.some((r) => r.includes('from-scout')) || !results.includes('done'))
        failures.push(`subagent: results ${JSON.stringify(results).slice(0, 300)}\n${out.stdout?.slice(-600)}\n${out.stderr?.slice(-600)}`)
    }
  } catch (err) {
    failures.push(String(err?.message ?? err))
  } finally {
    rmSync(root, { recursive: true, force: true })
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
