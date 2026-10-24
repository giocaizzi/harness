# `hud` plugin

Heads-up display for Claude Code (a mod), a status line for Claude Code and Copilot CLI, a footer and reply rewrites for pi (`hooks/pi.mjs`, loaded through `hooks/pi-entry.mjs`), and running subagents in opencode's TUI (`hooks/opencode-tui.mjs`). No skills or agents. Architecture and the install/verify runbook: [docs/hud.md](../../docs/hud.md).

## Parts

| Part | Where | Harness | What it shows |
|---|---|---|---|
| `token-weather` band | mod `AbovePrompt` | Claude | `[ cache %] [ TTL] [sparkline]`: last turn's cache hit rate, prompt-cache countdown, context over the last 8 turns. Indented one column like the status line. |
| PR and CI strip | mod `AbovePrompt` | Claude | `[ #56 ✓ 3/3]` the branch's PR or MR on GitHub, GitLab or Azure DevOps (click to open) and its passed checks (an hourglass while some still run; `merged` or `closed` once it is), `[↑2 ↓1]` unpushed work, `[~3 +120 -30 ?2]` uncommitted changes (files, lines added and removed, untracked). |
| `/weather` pane | mod `Pane` | Claude | Context chart, per-turn table, last turn's tokens, 5h and 7d history, TTL gauge. |
| Spinner | mod `Spinner` | Claude | ` Running`, ` Searching`, ` Editing`, … while a tool runs. |
| Limit forecast | mod `AbovePrompt` | Claude | `[ 5h full ~16:40]` when a window fills before it resets at the pace of the last turns. |
| Subagents | mod `AbovePrompt`, `/subagents` pane | Claude | `[ 2]` running subagents; the pane lists each with type, task, model, time, tokens and how it ended. |
| Turn footer | mod `TurnDuration` | Claude | `Baked for 3s · ↑10.0k ↓1.2k ↺90% $0.04` (↑ in, ↓ out, ↺ cache hit). |
| Tool rows | mod `ToolUse` | Claude | An icon per tool coloured by outcome, `+12 -4` on edits, the call's time. |
| `/ctx` pane | mod `Pane` | Claude | The context breakdown as a coloured grid with one row per category. |
| Reply rewrites | mod `AssistantMessage`; pi `message_end` | Claude, pi | Each a setting, with its glyph and colour (no colour on pi): `#123` / `!45` / `owner/repo#12` / `AB#77` as links with their open, merged, closed or draft state; absolute paths as `<repo> › path` and `file:line` opening the editor (`editor`: vscode, cursor, zed, idea, sublime, file, custom); commit SHAs as links; long URLs as `owner/repo#12`; ISO times as `13 Oct 20:56 (5h ago)`; ✓ ✗ ⊘ statuses with counts; tokens and keys masked to their prefix. Settings and defaults: [docs/hud.md](../../docs/hud.md#reply-rewrites). |
| `/refresh-refs` | mod `command.run`; pi command | Claude, pi | Forgets the looked-up states, files and commits so replies ask again (states also refresh by themselves after 5 minutes). |
| pi footer | pi extension (`hooks/pi.mjs`) | pi | Context weather, model, PR with checks, unpushed and uncommitted work, after each run; each running `subagent` call with its model and reported thinking level: `[ scout · <model> · <thinking>]`. |
| Status line | `statusLine.command` | Claude, Copilot | Claude: `┌[ user@host] [ branch *] [ gcp] [ session]` and `└[ path] [ model] [ 55%] [ 5h 62% 2h15m] [ 7d 5% 3d4h] [ 1.84]`. Copilot: `[ 9%] [ 50%] [ 3 req]`, and each running subagent with its model and effort: `[ scout · gpt-6-luna · low · 1m 3s]`. |
| opencode subagents | TUI plugin (`hooks/opencode-tui.mjs`, slot `session_prompt_right`) | opencode | Each running subagent beside the prompt: `[ scout · <model> · <variant>]`. |
| Agent-panel rows | `subagentStatusLine.command` | Claude | The default subagent row with the subagent's model and effort before the time: `ticket-103  Ticket-run #103  Sonnet 5.5 · high · 3m 49s · ↓ 286.1k tokens`. |

## Install

```bash
/plugin install hud@giocaizzi-harness          # Claude Code
copilot plugin install hud@giocaizzi-harness   # Copilot CLI
pi install git:github.com/giocaizzi/harness      # pi (the whole repo)
make install HARNESS=opencode                    # opencode, from a clone (TUI plugin in tui.json)
```

Status-line settings for both CLIs: [docs/hud.md](../../docs/hud.md#install).
