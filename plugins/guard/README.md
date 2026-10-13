# `guard` plugin

Agent guardrails as hooks: one rule engine that runs under Claude Code, GitHub Copilot CLI, VS Code Copilot and Codex as command hooks (`hooks/hooks.json`, `hooks/codex.json`) and under opencode and pi as in-process plugins (`hooks/opencode.mjs`, `hooks/pi.mjs`), on macOS, Linux and Windows. Per-harness differences: [docs/compatibility.md](../../docs/compatibility.md). No skills or agents. Architecture and the install/verify runbook: [docs/guard.md](../../docs/guard.md). The UI moved to [`hud`](../hud/README.md) and toasts and sounds to [`sounds`](../sounds/README.md).

## Hooks

| Hook | Event | Harness | What it does |
|---|---|---|---|
| `skill-enforcer` | PreToolUse (shell) | all | Before `git commit`, `gh pr`, `glab mr`, `az repos pr`, worktree, release and secrets commands, denies once per session until the matching skill is loaded. |
| `title-guard` | PreToolUse (shell) | all | Denies `git commit -m`, `gh pr create --title`, `glab mr create|update --title` or `az repos pr create|update --title` whose subject is not a Conventional Commit header, every time. |
| `host-guard` | PreToolUse (shell) | all | Denies a heavy build or test run once when load, CPU or free disk is past its cap, pointing to `host-hygiene`'s `heavy.sh` and `lease.sh`; commands already run through a heavy or lease wrapper pass. |
| `risky-ask` | PreToolUse (shell) | all; Codex and opencode deny instead of asking | Asks before `rm -r`, force-push, `git reset --hard`, `terraform apply`, `gh pr merge --admin`, `az repos pr --bypass-policy`, with a blast-radius preview; deletes under a temp dir or of a clean worktree that is pushed or has a merged PR pass. |
| `pip-deny` | PreToolUse (shell) | all | In a uv repo, denies `pip`, `pip3`, `pipx`, `python -m pip` and `poetry` every time; `uv pip` passes. In a poetry, pipenv or pip repo they run, with one note per session. |
| `stop-check` | Stop | all; opencode and pi send the failure back as a message | Runs `make check` before the agent stops, only when the repo changed since the last green run; on failure blocks once with the output tail. A timeout (default 1750 s, `GUARD_STOP_TIMEOUT_MS`) is reported, not blocked; `GUARD_STOP_CHECK=off` disables it. |
| `post-edit-lint` | PostToolUse (edit tools) | all | shellcheck on edited `.sh`/`.bash`, PSScriptAnalyzer on `.ps1`; findings go back to the agent. Missing linter: skip. |
| `keep-awake` | SessionStart | all | Keeps the machine awake while the harness runs (VS Code: while the window is open): `caffeinate -w` (macOS), `systemd-inhibit` (Linux), `SetThreadExecutionState` (Windows). |
| `usage-throttle` | mod `agent.spawn` | Claude | Refuses new subagents at 90% of the worst plan window. Copilot exposes no rate-limit windows. |
| `decision-log` | PreToolUse (shell), mod `agent.spawn` | all (throttle: Claude) | Sends each deny, ask and throttle denial as an OTLP log record to the collector in `OTEL_EXPORTER_OTLP_ENDPOINT` (or its `GUARD_` copy, since Claude Code and Copilot strip `OTEL_*` from hooks); nothing without it. See [docs/guard.md](../../docs/guard.md#grafana). |
| `skill-tracker` | PreToolUse (Skill, a read of `SKILL.md`), UserPromptSubmit (`/skill`, `/skill:name`, `$skill`) | all | Records loaded skills and typed slash commands for the skill enforcer. |

## Install

```bash
/plugin install guard@giocaizzi-harness          # Claude Code
copilot plugin install guard@giocaizzi-harness   # Copilot CLI
codex plugin add guard@giocaizzi-harness         # Codex, then trust its hooks in /hooks
make install HARNESS=opencode                    # opencode, from a clone
pi install git:github.com/giocaizzi/harness      # pi
```

VS Code and the details per harness: [docs/install.md](../../docs/install.md).

