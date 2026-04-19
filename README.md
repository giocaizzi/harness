# Skills & Agents

My personal collection of skills and agents for AI coding assistants.

- Skills follow the [Agent Skills](https://agentskills.io) open standard
- Distributed as a [Claude Code / Copilot CLI plugin](https://code.claude.com/docs/en/plugins) (single-install) and marketplace (individual installs)

## Available Agents

| Agent | Version | Description |
|-------|---------|-------------|
| `api-reviewer` | 1.1 | Scans the API for vulnerabilities, RBAC leaks and compliance issues |

## Available Skills

| Skill | Version | Description |
|-------|---------|-------------|
| `ddd` | 2.0 | Domain-Driven Design with Hexagonal Architecture (Ports & Adapters) for Python |
| `fastapi` | 4.0 | FastAPI best practices with Pydantic v2 for production REST APIs |
| `sqlalchemy` | 4.0 | SQLAlchemy v2 best practices for ORM, Core, and migrations |
| `python-development` | 2.0 | Python development best practices and conventions |
| `python-testing` | 1.0 | Python testing best practices and conventions |
| `react` | 1.0 | ReactJS development standards and best practices |
| `nextjs` | 1.0 | Next.js best practices and conventions |
| `javascript-typescript` | 1.0 | JavaScript and TypeScript development with ES6+ and Node.js |

## Installation

### Claude Code / Copilot CLI (all skills + agents)

Install everything at once as a single plugin:

```bash
# Claude Code
/plugin marketplace add giocaizzi/skills

# Copilot CLI
copilot plugin install giocaizzi/skills
```

### Claude Code (marketplace — individual installs)

```bash
# Add this repo as a marketplace
/plugin marketplace add giocaizzi/skills

# Install a plugin group
/plugin install python@giocaizzi-skills
/plugin install api@giocaizzi-skills
/plugin install javascript@giocaizzi-skills
/plugin install agents@giocaizzi-skills
```

### Copilot CLI (marketplace — individual installs)

```bash
# Add this repo as a marketplace
copilot plugin marketplace add giocaizzi/skills

# Install a single skill
copilot plugin install giocaizzi/skills:skills/<skill_name>
```

### npx skills (agentskills.io)

Uses [`npx skills`](https://github.com/vercel-labs/skills) — the open agent skills package manager.

```bash
# install a specific skill to all detected agents
npx skills add giocaizzi/skills --skill <skill_name>

# install globally (available across all projects)
npx skills add giocaizzi/skills --skill <skill_name> -g

# list available skills without installing
npx skills add giocaizzi/skills --list
```

### Restore from lock file (fresh clone)

```bash
npx skills experimental_install
```

### Manual install (symlink)

```bash
ln -s /path/to/skills/<skill_name> /path/to/your/project/.agents/skills/<skill_name>
```

## Reference

- [agentskills.io/specification](https://agentskills.io/specification)
- [npx skills](https://github.com/vercel-labs/skills)
- [Claude Code Plugins](https://code.claude.com/docs/en/discover-plugins)
