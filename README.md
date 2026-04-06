# Agents Skills

My personal set of skills for AI Agents following the [Agent Skills](https://agentskills.io) open standard.

## Usage

### Install a skill via CLI (recommended)

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

Symlink keeps the skill in sync if you update this repo.

```bash
ln -s /path/to/skills/<skill_name> /path/to/your/project/.agents/skills/<skill_name>
```

## Reference

- [agentskills.io/specification](https://agentskills.io/specification)
- [npx skills](https://github.com/vercel-labs/skills)