# Skills

My personal marketplace with plugins for AI coding assistants, including skills, agents, slash commands and more.

Compatible with most of AI harnesses — [Claude Code](https://code.claude.com/), [GitHub Copilot CLI](https://github.com/features/copilot/cli) and [VS Code](https://code.visualstudio.com/).

## Available plugins

| Plugin | Description |
|---|---|
| [`api`](plugins/api/README.md) | API development — FastAPI, SQLAlchemy, DDD; plus the `api-reviewer` agent. |
| [`python`](plugins/python/README.md) | Python development and testing best practices. |
| [`javascript`](plugins/javascript/README.md) | JavaScript/TypeScript, React, Next.js. |
| [`dev-tools`](plugins/dev-tools/README.md) | General development tooling — git, GitHub, conventional commits, semantic versioning. |

Each plugin's README lists the skills and agents it ships.

---

## Install

Install the marketplace and plugins under your preferred harness:

```bash
# Add the marketplace
/plugin marketplace add giocaizzi/skills
# Then install the plugins you want to use
/plugin install api@giocaizzi-skills
/plugin install python@giocaizzi-skills
/plugin install javascript@giocaizzi-skills
/plugin install dev-tools@giocaizzi-skills
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
