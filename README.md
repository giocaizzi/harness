<div align="center">

# harness

**Personal plugin marketplace for AI coding assistants.**

[![CI](https://github.com/giocaizzi/harness/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/giocaizzi/harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

My personal marketplace with plugins for AI coding assistants, including skills, agents, slash commands and more.

Works with [Claude Code](https://code.claude.com/), [GitHub Copilot CLI](https://github.com/features/copilot/cli), [VS Code](https://code.visualstudio.com/) Copilot, [Codex CLI](https://github.com/openai/codex), [opencode](https://opencode.ai/) and [pi](https://pi.dev/), on macOS, Linux and Windows. What each harness gets: [docs/compatibility.md](docs/compatibility.md).

## Available plugins

| Plugin | Description |
|---|---|
| [`api`](plugins/api/README.md) | API development — FastAPI, SQLAlchemy, DDD; plus the `api-reviewer` agent. |
| [`python`](plugins/python/README.md) | Python development and testing best practices. |
| [`javascript`](plugins/javascript/README.md) | JavaScript/TypeScript, React, Next.js. |
| [`dev-tools`](plugins/dev-tools/README.md) | General development tooling — git, GitHub, conventional commits, semantic versioning. |
| [`guard`](plugins/guard/README.md) | Guardrail hooks for every harness — skill enforcer, commit-title guard, host guard, pip deny, risky-command ask, `make check` on stop. |
| [`hud`](plugins/hud/README.md) | Heads-up display — token-weather band and pane, PR and CI strip, tool-naming spinner (Claude Code); status line for Claude Code, Copilot CLI and pi. |
| [`sounds`](plugins/sounds/README.md) | Toasts and configurable sounds for limits, context, cache expiry and every way a turn ends (Claude Code; pi, Codex and opencode with the default clips). |

Each plugin's README lists the skills, agents and hooks it ships.

---

## Compatibility

| | Claude Code | Copilot CLI | VS Code | Codex | opencode | pi |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Skills | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Agents | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Guardrails (`guard`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Denial log to Grafana (`guard`) | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ |
| Confirm risky commands | ✅ | ✅ | ✅ | 🟡 denies | 🟡 denies | ✅ |
| Status line (`hud`) | ✅ | ✅ | — | — | — | ✅ |
| Live HUD band and pane (`hud`) | ✅ | — | — | — | — | — |
| Sounds and toasts (`sounds`) | ✅ | — | — | 🟡 | 🟡 | 🟡 |

✅ supported · 🟡 partial · — the harness has no way to do it. Runs on macOS, Linux and Windows. Details, reasons and open issues: [docs/compatibility.md](docs/compatibility.md).

---

## Install

| Harness | Install |
|---|---|
| Claude Code | `claude plugin marketplace add giocaizzi/harness`, then `claude plugin install <plugin>@giocaizzi-harness` |
| GitHub Copilot CLI | `copilot plugin marketplace add giocaizzi/harness`, then `copilot plugin install <plugin>@giocaizzi-harness` |
| VS Code Copilot | `"chat.plugins.marketplaces": ["giocaizzi/harness"]`, then install from `@agentPlugins` |
| Codex CLI | `codex plugin marketplace add giocaizzi/harness`, then `codex plugin add <plugin>@giocaizzi-harness`; agents: `make install HARNESS=codex` from a clone |
| opencode | `make install HARNESS=opencode` from a clone |
| pi | `pi install git:github.com/giocaizzi/harness` |

Updating, verifying, trusting Codex hooks and running from a checkout: [docs/install.md](docs/install.md).

---

## References

- Claude Code — [plugins](https://code.claude.com/docs/en/plugins) · [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- GitHub Copilot CLI — [plugins overview](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins) · [marketplace setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace)
- VS Code — [agent plugins](https://code.visualstudio.com/docs/copilot/customization/agent-plugins)
- Codex CLI — [plugins](https://learn.chatgpt.com/docs/plugins) · [hooks](https://learn.chatgpt.com/docs/hooks) · [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- opencode — [plugins](https://opencode.ai/docs/plugins/) · [skills](https://opencode.ai/docs/skills/) · [agents](https://opencode.ai/docs/agents/)
- pi — [packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) · [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- Agent Skills — [specification](https://agentskills.io/specification)
