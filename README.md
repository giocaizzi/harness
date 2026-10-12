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

After adding the marketplace, browse `@agentPlugins` in the Extensions sidebar.
To verify that VSCode loaded the plugins, see the "Setting > Customization" panel in the Copilot sidebar.

### Local development

To run a plugin straight from a clone without installing it:

```bash
# Claude Code
claude --plugin-dir ./plugins/api

# GitHub Copilot CLI
copilot plugin install ./plugins/api
```

---

## References

- Claude Code — [plugins](https://code.claude.com/docs/en/plugins) · [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- GitHub Copilot CLI — [plugins overview](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins) · [marketplace setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace)
- Agent Skills - [specification](https://agentskills.io/specification)
- VSCode plugins - [plugins](https://code.visualstudio.com/docs/copilot/customization/agent-plugins)
