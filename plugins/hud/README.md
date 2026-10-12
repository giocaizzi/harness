# `hud` plugin

Heads-up display for Claude Code (a mod) and a status line for Claude Code and Copilot CLI. No skills or agents. Architecture and the install/verify runbook: [docs/hud.md](../../docs/hud.md).

## Parts

| Part | Where | Harness | What it shows |
|---|---|---|---|
| `token-weather` band | mod `AbovePrompt` | Claude | `[ cache %] [ TTL] [sparkline]`: last turn's cache hit rate, prompt-cache countdown, context over the last 8 turns. Indented one column like the status line. |
| PR and CI strip | mod `AbovePrompt` | Claude | `[ #56 ✓ 3/3]` the branch's PR (click to open) and its passed checks, `[↑2 ↓1]` unpushed work, `[~3 +120 -30 ?2]` uncommitted changes (files, lines added and removed, untracked). |
| `/weather` pane | mod `Pane` | Claude | Context chart, per-turn table, last turn's tokens, 5h and 7d history, TTL gauge. |
| Spinner | mod `Spinner` | Claude | ` Running`, ` Searching`, ` Editing`, … while a tool runs. |
| Limit forecast | mod `AbovePrompt` | Claude | `[ 5h full ~16:40]` when a window fills before it resets at the pace of the last turns. |
| Subagents | mod `AbovePrompt`, `/subagents` pane | Claude | `[ 2]` running subagents; the pane lists each with type, task, model, time, tokens and how it ended. |
| Turn footer | mod `TurnDuration` | Claude | `Baked for 3s · 10.0k in · 1.2k out · 90% cached · $0.04`. |
| Tool rows | mod `ToolUse` | Claude | An icon per tool coloured by outcome, `+12 -4` on edits, the call's time. |
| `/ctx` pane | mod `Pane` | Claude | The context breakdown as a coloured grid with one row per category. |
| Status line | `statusLine.command` | Claude, Copilot | Claude: two lines (user, host, git, GCP, session; path, model, context with its weather glyph, 5h/7d batteries, cost). Copilot: context, cache hit rate, premium requests. |

## Install

```bash
/plugin install hud@giocaizzi-harness          # Claude Code
copilot plugin install hud@giocaizzi-harness   # Copilot CLI
```

Status-line settings for both CLIs: [docs/hud.md](../../docs/hud.md#install).
