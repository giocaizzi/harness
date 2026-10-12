# `guard` plugin

Agent guardrails as hooks: one `hooks/hooks.json` and one Node script that run the same rules under Claude Code, GitHub Copilot CLI and VS Code Copilot, on macOS, Linux and Windows. No skills or agents. Architecture and the install/verify runbook: [docs/guard.md](../../docs/guard.md).

## Hooks

| Hook | Event | Harness | What it does |
|---|---|---|---|
| `skill-enforcer` | PreToolUse (shell) | Claude, Copilot, VS Code | Before `git commit`, `gh pr`, `glab mr`, `az repos pr`, worktree, release and secrets commands, denies once per session until the matching skill is loaded. |
| `title-guard` | PreToolUse (shell) | Claude, Copilot, VS Code | Denies `git commit -m`, `gh pr create --title`, `glab mr create|update --title` or `az repos pr create|update --title` whose subject is not a Conventional Commit header, every time. |
| `host-guard` | PreToolUse (shell) | Claude, Copilot, VS Code | Denies a heavy build or test run once when load, CPU or free disk is past its cap, pointing to `host-hygiene`'s `heavy.sh` and `lease.sh`; commands already run through a heavy or lease wrapper pass. |
| `risky-ask` | PreToolUse (shell) | Claude, Copilot, VS Code | Asks before `rm -r`, force-push, `git reset --hard`, `terraform apply`, `gh pr merge --admin`, `az repos pr --bypass-policy`, with a blast-radius preview; deletes under a temp dir or of a clean worktree that is pushed or has a merged PR pass. |
| `pip-deny` | PreToolUse (shell) | Claude, Copilot, VS Code | In a uv repo, denies `pip`, `pip3`, `pipx`, `python -m pip` and `poetry` every time; `uv pip` passes. In a poetry, pipenv or pip repo they run, with one note per session. |
| `stop-check` | Stop | Claude, Copilot, VS Code | Runs `make check` before the agent stops; on failure blocks once with the output tail. |
| `post-edit-lint` | PostToolUse (edit tools) | Claude, Copilot, VS Code | shellcheck on edited `.sh`/`.bash`, PSScriptAnalyzer on `.ps1`; findings go back to the agent. Missing linter: skip. |
| `keep-awake` | SessionStart | Claude, Copilot, VS Code | Keeps the machine awake while the harness runs (VS Code: while the window is open): `caffeinate -w` (macOS), `systemd-inhibit` (Linux), `SetThreadExecutionState` (Windows). |
| `usage-throttle` | mod `agent.spawn` | Claude | Refuses new subagents at 90% of the worst plan window. Copilot exposes no rate-limit windows. |
| `token-weather` | mod `AbovePrompt` band, `Spinner` suffix, `/weather` pane | Claude | One line above the prompt in Nerd Font icons, dim while fine and coloured when not: a weather icon for the context fullness (the status line shows the %), last turn's cache hit rate, prompt-cache TTL countdown, a sparkline of the context over the last turns; hints `compact soon`, `cache cold`, `cache expired`. The spinner adds the TTL; `/weather` opens a pane with the per-turn history and a TTL gauge. Drawn on top of other plugins' bands. |
| `token-weather` (status line) | `statusLine.command` | Copilot | `hooks/statusline.mjs`: context % and the session's cache hit rate, hints `compact soon`, `cache cold`. Wired in Copilot settings, see [docs/guard.md](../../docs/guard.md#install). |
| `decision-log` | PreToolUse (shell), mod `agent.spawn` | Claude, Copilot, VS Code (throttle: Claude) | Sends each deny, ask and throttle denial as an OTLP log record to the collector in `OTEL_EXPORTER_OTLP_ENDPOINT`; nothing without it. See [docs/guard.md](../../docs/guard.md#grafana). |
| `skill-tracker` | PreToolUse (Skill), UserPromptSubmit | Claude, Copilot, VS Code | Records loaded skills and typed slash commands for the skill enforcer. |

## Install

```bash
/plugin install guard@giocaizzi-harness          # Claude Code
copilot plugin install guard@giocaizzi-harness   # Copilot CLI
```

VS Code: install `guard` from `@agentPlugins` after adding the marketplace (see [docs/guard.md](../../docs/guard.md#install)).

See the [repository README](../../README.md) for marketplace setup and local-development instructions.
