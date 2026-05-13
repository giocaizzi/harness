# Skills & Agents

A personal collection of skills and agents for AI coding assistants, distributed as a **cross-harness plugin marketplace** that works under both [Claude Code](https://code.claude.com/docs/en/plugins) and [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins).

A single repository, one `marketplace.json` at the root, and each plugin ships the manifests both harnesses need.

## Available plugins

| Plugin | Description |
|---|---|
| `api` | API development — FastAPI, SQLAlchemy, DDD; plus the `api-reviewer` agent. |
| `python` | Python development and testing best practices. |
| `javascript` | JavaScript/TypeScript, React, Next.js. |

## Available skills

| Skill | Plugin | Description |
|---|---|---|
| `ddd` | `api` | Domain-Driven Design with Hexagonal Architecture (Ports & Adapters). |
| `fastapi` | `api` | FastAPI best practices with Pydantic v2 for production REST APIs. |
| `sqlalchemy` | `api` | SQLAlchemy v2 best practices for ORM, Core, and migrations. |
| `python-development` | `python` | Python development best practices and conventions. |
| `python-testing` | `python` | Python testing best practices and conventions. |
| `javascript-typescript` | `javascript` | JavaScript and TypeScript development with ES6+ and Node.js. |
| `react` | `javascript` | ReactJS development standards and best practices. |
| `nextjs` | `javascript` | Next.js best practices and conventions. |

## Available agents

| Agent | Plugin | Description |
|---|---|---|
| `api-reviewer` | `api` | Scans the API for vulnerabilities, RBAC leaks and compliance issues. |

---

## Install

### Claude Code

```bash
# Add the marketplace, then install whichever plugins you want:
/plugin marketplace add giocaizzi/skills
/plugin install api@giocaizzi-skills
/plugin install python@giocaizzi-skills
/plugin install javascript@giocaizzi-skills
```

### GitHub Copilot CLI

```bash
copilot plugin marketplace add giocaizzi/skills
copilot plugin install api@giocaizzi-skills
copilot plugin install python@giocaizzi-skills
copilot plugin install javascript@giocaizzi-skills
```

### VS Code Copilot

After adding the marketplace, browse `@agentPlugins` in the Extensions sidebar, or use **Chat: Install Plugin From Source** pointing at this repository.

### Local development

To run a plugin straight from a clone without installing it:

```bash
# Claude Code
claude --plugin-dir ./plugins/api

# GitHub Copilot CLI
copilot plugin install ./plugins/api
```

---

## Contributing

See [AGENTS.md](./AGENTS.md) for the architecture, build pipeline, conventions, and the precise rules each harness imposes on plugin layout. Quick start:

```bash
make help          # list all targets
make build         # regenerate agents and the per-plugin Copilot manifest
make validate      # check every repo invariant before committing
```

## References

- Claude Code — [plugins](https://code.claude.com/docs/en/plugins) · [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- GitHub Copilot CLI — [plugins overview](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins) · [marketplace setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace)
- [Agent Skills specification](https://agentskills.io/specification)
- [VSCode Plugins](https://code.visualstudio.com/docs/copilot/customization/agent-plugins)
