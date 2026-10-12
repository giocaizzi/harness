# `hud` plugin

Heads-up display for Claude Code (a mod) and a status line for Claude Code and Copilot CLI. No skills or agents. Architecture and the install/verify runbook: [docs/hud.md](../../docs/hud.md).

## Parts

| Part | Where | Harness | What it shows |
|---|---|---|---|
| `token-weather` band | mod `AbovePrompt` | Claude | `[glyph] [ cache %] [ TTL] [sparkline]`: context as weather, last turn's cache hit rate, prompt-cache countdown, the last 8 turns. |
| PR and CI strip | mod `AbovePrompt` | Claude | `[ #56 ✓]` the branch's PR and its checks, `[↑2 ↓1]` unpushed work. |
| `/weather` pane | mod `Pane` | Claude | Context chart, per-turn table, last turn's tokens, 5h and 7d history, TTL gauge. |
| Spinner | mod `Spinner` | Claude | ` Running`, ` Searching`, ` Editing`, … while a tool runs. |
| Status line | `statusLine.command` | Claude, Copilot | Claude: two lines (user, host, git, GCP, session; path, model, context, 5h/7d batteries, cost). Copilot: context, cache hit rate, premium requests. |

## Install

```bash
/plugin install hud@giocaizzi-harness          # Claude Code
copilot plugin install hud@giocaizzi-harness   # Copilot CLI
```

Status-line settings for both CLIs: [docs/hud.md](../../docs/hud.md#install).
