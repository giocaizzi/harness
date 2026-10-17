// The guard for harnesses that load plugins in-process (opencode, pi) rather than running command hooks: each
// event is turned into the Claude-shaped payload the command hooks get and passed to the same handlers, so the
// rules behave alike everywhere. opencode.mjs and pi.mjs only map their harness's events onto these calls.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keepAwake } from './awake.mjs'
import { handle, hostFacts, pythonManager, run } from './guard.mjs'
import { lintFile } from './lint.mjs'
import { stopCheck } from './stop.mjs'
import { emit } from '../core/otel.mjs'

// Neither harness gives plugins a data dir; the same fallback as VS Code.
export const DATA_DIR = join(tmpdir(), 'guard-plugin')

const launchDetached = (argv) => {
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  child.unref()
  return child.pid
}

// `harness` names it in telemetry; `noAsk` turns an ask into a deny where the harness cannot ask, unless
// `deps.nativeAsk(command, rule, input)` says the harness's own prompt covers it.
export function createGuard({ harness, noAsk = false, dataDir = DATA_DIR, deps = {} }) {
  const d = {
    dataDir,
    env: process.env,
    hostFacts,
    run,
    pythonManager,
    noAsk,
    emit: (event, attrs) => emit(process.env, event, { ...attrs, harness }),
    // The harness's own usage, as the harness (service.name opencode or pi): neither exports telemetry itself.
    report: (event, attrs) => emit(process.env, event, attrs, fetch, harness),
    ...deps,
  }
  const call = async (input) => {
    try {
      const out = await handle(input, d)
      return out.stdout ? JSON.parse(out.stdout).hookSpecificOutput ?? {} : {}
    } catch {
      return {}
    }
  }
  return {
    // { decision: 'deny'|'ask'|undefined, reason, context } for a tool call. `tool` is the harness's tool name,
    // lower-cased; `input` its arguments (a shell call carries `command`).
    async preTool({ sessionId, cwd, tool, input }) {
      const o = await call({ hook_event_name: 'PreToolUse', session_id: sessionId, cwd, tool_name: tool, tool_input: input })
      return { decision: o.permissionDecision, reason: o.permissionDecisionReason, context: o.additionalContext }
    },
    prompt: ({ sessionId, cwd, prompt }) => call({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd, prompt }),
    sessionEnd: ({ sessionId }) => call({ hook_event_name: 'SessionEnd', session_id: sessionId }),
    // Lint findings for an edit, or null.
    postTool({ cwd, tool, input }) {
      try {
        return lintFile({ cwd, tool_name: tool, tool_input: input }, d.spawnSync)?.additionalContext ?? null
      } catch {
        return null
      }
    },
    // The reason to keep going (make check failed), or null. `active` is true when the last stop was already blocked.
    // ponytail: synchronous, so the harness's UI waits for make check like a command hook would; async spawn if it hurts.
    stop({ cwd, active }) {
      try {
        const out = stopCheck({ cwd, stop_hook_active: active }, d.spawnSync, { report: (attrs) => void d.emit('guard.stop', attrs) })
        return out?.decision === 'block' ? out.reason : null
      } catch {
        return null
      }
    },
    // One model response: { sessionId, model, provider, tokens: { input, output, cacheRead, cacheWrite, reasoning }, costUsd }.
    // Named like Claude Code's api_request, so one query covers every harness. Never throws.
    usage({ sessionId, model, provider, tokens = {}, costUsd }) {
      const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined)
      return Promise.resolve(
        d.report?.('api_request', {
          'session.id': sessionId,
          model,
          provider,
          input_tokens: n(tokens.input),
          output_tokens: n(tokens.output),
          cache_read_tokens: n(tokens.cacheRead),
          cache_creation_tokens: n(tokens.cacheWrite),
          reasoning_tokens: n(tokens.reasoning),
          cost_usd: n(costUsd),
        }),
      ).catch(() => {})
    },
    // In-process: the harness is this process.
    awake() {
      try {
        return keepAwake({ dataDir, start: process.pid, launch: d.launch ?? launchDetached })
      } catch {
        return null
      }
    },
  }
}
