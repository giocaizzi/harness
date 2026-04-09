# Agent Skills

My personal set of skills for AI Agents following the [Agent Skills](https://agentskills.io) open standard.

Also available as a [Claude Code plugin marketplace](https://code.claude.com/docs/en/discover-plugins).

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
| `smart-refactor` | 1.0 | Smart refactoring across multiple files and large codebases |

## Installation

### Claude Code (plugin marketplace)

```bash
# Add this repo as a marketplace
/plugin marketplace add giocaizzi/skills

# Install a skill
/plugin install <skill_name>@giocaizzi-skills
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
