# AGENTS.md — Working with this repository

This file instructs AI agents (Claude Code, Copilot CLI, etc.) on how to work in this repository. Read this file before making any changes.

## Repository purpose

Personal collection of **skills** and **agents** for AI coding assistants. Distributed as:
- An [Agent Skills](https://agentskills.io) marketplace (`npx skills`)
- A Claude Code / Copilot CLI **plugin** (single install) via `.claude-plugin/plugin.json`
- A Claude Code / Copilot CLI **marketplace** (individual skill installs) via `.claude-plugin/marketplace.json`

## Directory structure

```
.
├── .claude-plugin/
│   ├── marketplace.json    ← marketplace manifest (lists all plugins)
│   └── plugin.json         ← root plugin manifest (single-install, all skills + agents)
├── agents/
│   ├── _src/               ← SOURCE (edit here)
│   │   └── <name>/
│   │       ├── body.md         shared system prompt
│   │       ├── copilot.yaml    Copilot CLI frontmatter
│   │       └── claude.yaml     Claude Code frontmatter
│   ├── plugin.json         ← agents-only sub-plugin manifest
│   ├── <name>.agent.md     ← GENERATED — do not edit
│   └── <name>.md           ← GENERATED — do not edit
├── skills/
│   └── <name>/
│       ├── .claude-plugin/
│       │   └── plugin.json     individual skill plugin manifest
│       ├── SKILL.md            skill content (follows agentskills.io spec)
│       └── references/         optional extended docs
├── scripts/
│   └── build_agents.py     ← agent build script
├── Makefile
├── README.md
└── skills-lock.json
```

## Build system

| Command | What it does |
|---|---|
| `make build` | Generate `agents/*.agent.md` and `agents/*.md` from `agents/_src/` |
| `make validate` | Exit 1 if generated files are out of sync with `_src/` source |

**Always run `make build` after editing anything in `agents/_src/`.** Commit both the source and generated files.

## File ownership

| Path | Owner | Rule |
|---|---|---|
| `agents/_src/<name>/` | Human / agent | Edit freely |
| `agents/<name>.agent.md` | **Generated** | Never edit directly |
| `agents/<name>.md` | **Generated** | Never edit directly |
| `skills/<name>/SKILL.md` | Human / agent | Edit freely |
| `.claude-plugin/marketplace.json` | Human / agent | Update when adding/removing skills or agents |
| `.claude-plugin/plugin.json` | Human / agent | Update version on releases |
| `agents/plugin.json` | Human / agent | Update version on releases |

## How to add a new skill

1. Create `skills/<name>/SKILL.md` following the [Agent Skills spec](https://agentskills.io/specification):
   ```markdown
   ---
   name: <name>
   description: <one-line description>
   version: 1.0.0
   ---

   Skill content here.
   ```
2. Create `skills/<name>/.claude-plugin/plugin.json`:
   ```json
   {
     "name": "<name>",
     "version": "1.0.0",
     "description": "<description>",
     "keywords": ["<tag>"]
   }
   ```
3. Add an entry to `.claude-plugin/marketplace.json` under `"plugins"`:
   ```json
   {
     "name": "<name>",
     "source": "./skills/<name>",
     "description": "<description>",
     "version": "1.0.0",
     "keywords": ["<tag>"]
   }
   ```
4. Add a row to the **Available Skills** table in `README.md`.
5. Run `make validate` to confirm nothing is broken.

## How to add a new agent

1. Create `agents/_src/<name>/body.md` — the shared system prompt (plain markdown, no frontmatter).
2. Create `agents/_src/<name>/copilot.yaml` — Copilot CLI frontmatter fields only (no `---` delimiters):
   ```yaml
   name: "Agent Name"
   description: Short description for Copilot CLI.
   tools: ['vscode', 'execute', 'read', 'edit', 'search', 'web', 'agent']
   ```
3. Create `agents/_src/<name>/claude.yaml` — Claude Code frontmatter fields only:
   ```yaml
   name: agent-name
   description: Short description. Include "Use when..." trigger phrase.
   tools: Read, Edit, Bash, Grep, Glob, WebSearch
   model: sonnet
   ```
4. Run `make build` to generate `agents/<name>.agent.md` and `agents/<name>.md`.
5. Add an entry to `.claude-plugin/marketplace.json` if exposing as a standalone installable agent (add to the `agents` plugin's description, or create a new plugin entry pointing to `./agents`).
6. Add a row to the **Available Agents** table in `README.md`.
7. Commit everything: `_src/`, generated files, updated `marketplace.json`, updated `README.md`.

## How to update an existing agent

1. Edit the relevant file(s) in `agents/_src/<name>/`.
2. Run `make build`.
3. Commit `_src/` changes + regenerated files together.
4. If the description changed, update `README.md`.

## How to update an existing skill

1. Edit `skills/<name>/SKILL.md` and/or files in `skills/<name>/references/`.
2. Bump the version in `skills/<name>/.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json`.
3. Update the version in `README.md` if it changed.
4. Run `make validate`.

## Version bumping

| What changed | Where to bump version |
|---|---|
| A skill's content | `skills/<name>/.claude-plugin/plugin.json` + marketplace entry |
| An agent's content | `agents/plugin.json` + marketplace `agents` entry |
| Any content | `agents/plugin.json` or per-skill plugin when relevant |
| Root plugin release | `.claude-plugin/plugin.json` |

Use semantic versioning (MAJOR.MINOR.PATCH).

## Plugin install reference

| Method | Command |
|---|---|
| Claude Code — all skills + agents | `/plugin install giocaizzi/skills` (uses `.claude-plugin/plugin.json`) |
| Copilot CLI — all skills + agents | `copilot plugin install giocaizzi/skills` |
| Claude Code — marketplace browse | `/plugin marketplace add giocaizzi/skills`, then install individual items |
| Copilot CLI — individual skill | `copilot plugin install giocaizzi/skills:skills/<name>` |
| npx skills | `npx skills add giocaizzi/skills --skill <name>` |

## Commit conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat(agents): add <name> agent`
- `feat(skills): add <name> skill`
- `fix(agents): fix <name> agent body`
- `chore: bump versions`

## README update rules

Update `README.md` when:
- Adding or removing a skill → update the **Available Skills** table
- Adding or removing an agent → update the **Available Agents** table
- A skill's version changes → update the version in the table
- Installation instructions change

Do not update `README.md` for internal refactors that don't affect the public interface.
