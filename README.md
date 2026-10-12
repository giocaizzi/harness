<div align="center">

# harness

**Personal plugin marketplace for AI coding assistants.**

[![CI](https://github.com/giocaizzi/harness/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/giocaizzi/harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

My personal marketplace with plugins for AI coding assistants, including skills, agents, slash commands and more.

Compatible with most of AI harnesses — [Claude Code](https://code.claude.com/), [GitHub Copilot CLI](https://github.com/features/copilot/cli) and [VS Code](https://code.visualstudio.com/).

## Available plugins

| Plugin | Description |
|---|---|
| [`api`](plugins/api/README.md) | API development — FastAPI, SQLAlchemy, DDD; plus the `api-reviewer` agent. |
| [`python`](plugins/python/README.md) | Python development and testing best practices. |
| [`javascript`](plugins/javascript/README.md) | JavaScript/TypeScript, React, Next.js. |
| [`dev-tools`](plugins/dev-tools/README.md) | General development tooling — git, GitHub, conventional commits, semantic versioning. |
| [`guard`](plugins/guard/README.md) | Guardrail hooks for both harnesses — skill enforcer, commit-title guard, host guard, risky-command ask. |

Each plugin's README lists the skills, agents and hooks it ships.

## Compatibility

| Plugin / feature | Claude Code | GitHub Copilot CLI | VS Code Copilot (agent plugins) |
|---|---|---|---|
| Marketplace `.claude-plugin/marketplace.json` | yes | yes | yes, via `chat.plugins.marketplaces` |
| Skills (`api`, `python`, `javascript`, `dev-tools`) | yes | yes | yes |
| Agents (`api-reviewer`, `scout`, `escalate`) | yes, `agents/*.md` | yes, `copilot/*.agent.md` | yes, `agents/*.md` (Claude format): tool names and `sonnet`/`haiku`/`opus` are mapped; other model ids (`escalate`) use the picked model; `effort` is ignored |
| `dev-tools` `host-hygiene` scripts (`heavy.sh` macOS/Linux, `heavy.ps1` Windows) | yes | yes | yes |
| `guard` command hooks (skill enforcer, title guard, host guard, pip deny, risky ask, skill tracker) | yes | yes | yes, Local agent (`chat.useHooks`) |
| `guard` post-edit lint, stop `make check` | yes | yes | yes |
| `guard` keep-awake | yes | yes | yes, while the window is open |
| `guard` usage throttle | yes (mod) | no: no mods API, no rate-limit windows | no: no mods API |
| `guard` token weather | yes, band above the prompt (mod) | yes, status line (`statusLine.command`) | no: no status-line hook |

Hosts: everything runs on macOS, Linux and Windows; the hooks need `node` 22+ on PATH. Checked live on macOS only (`heavy.ps1` runs in CI under Linux PowerShell): Windows is pending ([#25](https://github.com/giocaizzi/harness/issues/25)) and the Linux and Windows keep-awake keepers are unit-tested only. Details per hook: [docs/guard.md](docs/guard.md).

---

## Install

Install the marketplace and plugins under your preferred harness:

```bash
# Add the marketplace
/plugin marketplace add giocaizzi/harness
# Then install the plugins you want to use
/plugin install api@giocaizzi-harness
/plugin install python@giocaizzi-harness
/plugin install javascript@giocaizzi-harness
/plugin install dev-tools@giocaizzi-harness
/plugin install guard@giocaizzi-harness
```

### VS Code Copilot

Add the marketplace to the settings (`chat.plugins.enabled` on):

```jsonc
"chat.plugins.marketplaces": ["giocaizzi/harness"]
```

Then install the plugins from `@agentPlugins` in the Extensions view, or run **Chat: Install Plugin From Source** with the repo URL. **Chat: Open Agent Customizations** lists what VS Code loaded. VS Code also picks up plugins installed by Copilot CLI.

### Local development

To run a plugin straight from a clone without installing it:

```bash
# Claude Code
claude --plugin-dir ./plugins/api

# GitHub Copilot CLI
copilot plugin install ./plugins/api
```

VS Code: `"chat.pluginLocations": { "/abs/path/plugins/api": true }`.

---

## References

- Claude Code — [plugins](https://code.claude.com/docs/en/plugins) · [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- GitHub Copilot CLI — [plugins overview](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins) · [marketplace setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace)
- Agent Skills - [specification](https://agentskills.io/specification)
- VSCode plugins - [plugins](https://code.visualstudio.com/docs/copilot/customization/agent-plugins)
