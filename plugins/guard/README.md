# `guard` plugin

Agent guardrails as hooks: one `hooks/hooks.json` and one Node script that run the same rules under Claude Code and GitHub Copilot CLI, on macOS, Linux and Windows. No skills or agents. Architecture and the install/verify runbook: [docs/guard.md](../../docs/guard.md).

## Hooks

| Hook | Event | Harness | What it does |
|---|---|---|---|
| `skill-enforcer` | PreToolUse (shell) | Claude, Copilot | Before `git commit`, `gh pr`, worktree, release and secrets commands, denies once per session until the matching skill is loaded. |
| `title-guard` | PreToolUse (shell) | Claude, Copilot | Denies `git commit -m` / `gh pr create --title` whose subject is not a Conventional Commit header, every time. |
| `host-guard` | PreToolUse (shell) | Claude, Copilot | Denies a heavy build or test run once when load, CPU or free disk is past its cap. |
| `risky-ask` | PreToolUse (shell) | Claude, Copilot | Asks before `rm -r`, force-push, `git reset --hard`, `terraform apply`, `gh pr merge --admin`, with a blast-radius preview; deletes under a temp dir or of a clean, pushed worktree pass. |
| `skill-tracker` | PreToolUse (Skill), UserPromptSubmit | Claude, Copilot | Records loaded skills and typed slash commands for the skill enforcer. |

## Install

```bash
/plugin install guard@giocaizzi-skills          # Claude Code
copilot plugin install guard@giocaizzi-skills   # Copilot CLI
```

See the [repository README](../../README.md) for marketplace setup and local-development instructions.
