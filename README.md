# Skills & Agents

My personal collection of skills and agents for AI coding assistants, distributed as a [Claude Code / Copilot CLI plugin](https://code.claude.com/docs/en/plugins).

## Available Agents

| Agent | Plugin | Description |
|-------|--------|-------------|
| `api-reviewer` | `api` | Scans the API for vulnerabilities, RBAC leaks and compliance issues |

## Available Skills

| Skill | Plugin | Description |
|-------|--------|-------------|
| `ddd` | `api` | Domain-Driven Design with Hexagonal Architecture (Ports & Adapters) for Python |
| `fastapi` | `api` | FastAPI best practices with Pydantic v2 for production REST APIs |
| `sqlalchemy` | `api` | SQLAlchemy v2 best practices for ORM, Core, and migrations |
| `python-development` | `python` | Python development best practices and conventions |
| `python-testing` | `python` | Python testing best practices and conventions |
| `react` | `javascript` | ReactJS development standards and best practices |
| `nextjs` | `javascript` | Next.js best practices and conventions |
| `javascript-typescript` | `javascript` | JavaScript and TypeScript development with ES6+ and Node.js |

## Installation

### Add marketplace

```bash
# Claude Code
/plugin marketplace add giocaizzi/skills

# Copilot CLI
copilot plugin marketplace add giocaizzi/skills
```

### Install a plugin

```bash
# Claude Code
/plugin install python@giocaizzi-skills
/plugin install api@giocaizzi-skills
/plugin install javascript@giocaizzi-skills
```

## Reference

- [Claude Code Plugins](https://code.claude.com/docs/en/discover-plugins)
