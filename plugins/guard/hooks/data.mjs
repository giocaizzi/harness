// Where the guard keeps its files: the harness's plugin data dir (Claude Code, Copilot CLI), else a per-user dir
// under the temp dir (VS Code, opencode, pi), so another user's files are never read; created private (0700).
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

export const fallbackDataDir = () => join(tmpdir(), `guard-plugin-${process.getuid?.() ?? userInfo().username}`)
export const pluginDataDir = (env = process.env) => env.CLAUDE_PLUGIN_DATA || env.COPILOT_PLUGIN_DATA || fallbackDataDir()
