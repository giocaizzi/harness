# AGENTS.md — contributor guide

This repository is a **cross-harness plugin marketplace** for AI coding assistants. It distributes a set of plugins (each plugin contains skills and optionally agents) that work identically under **Claude Code** and **GitHub Copilot CLI**, and is compatible with VS Code Copilot's agent-plugins preview.

Read this file before making changes. Then run `make help` to see the build/validate commands.

---

## Why a single repo for two harnesses

Claude Code and GitHub Copilot CLI have converged on a shared plugin format:

- Both consume the **agentskills.io** open standard for `SKILL.md`.
- Both read a `marketplace.json` with the same schema (`name`, `owner`, `metadata`, `plugins[]`).
- The plugin manifest (`plugin.json`) is structurally similar.

But they differ in two important ways:

1. **Plugin manifest location.** Claude Code reads `.claude-plugin/plugin.json` (only). Copilot CLI tries `.plugin/plugin.json` → `plugin.json` → `.github/plugin/plugin.json` → `.claude-plugin/plugin.json` in that order.
2. **Agent file format and discovery.** Claude scans the `agents/` directory and loads **any `*.md` file** (including ones named `*.agent.md`). Copilot loads only `*.agent.md` files from its configured `agents` directory.

Empirically tested: if you put both `foo.md` and `foo.agent.md` in the same `agents/` directory, Claude double-loads and the second one wins. So the two harnesses' agent files **must live in different directories**, and each harness must read a `plugin.json` that points to its directory.

This repo treats everything that is identical (skills, plugin metadata) as one source of truth and **generates the per-harness artifacts** that diverge (agent files + the Copilot-specific `plugin.json`).

---

## Repository layout

```
.
├── .claude-plugin/
│   ├── marketplace.json          ← ONE marketplace; both harnesses read here (Copilot uses .claude-plugin/ as a fallback for the marketplace)
│   └── plugin.json               ← root single-install manifest
│
├── src/                          ← AUTHORED — humans edit here only
│   └── agents/
│       └── <agent>/
│           ├── body.md                shared system prompt
│           ├── agent.yaml             shared frontmatter (name, description, plugin, model)
│           ├── claude.yaml            Claude-only frontmatter overrides (optional)
│           └── copilot.yaml           Copilot-only frontmatter overrides (optional)
│
├── plugins/                      ← PUBLISHED PLUGINS (authored skills + generated agents + generated Copilot manifest)
│   └── <plugin>/
│       ├── .claude-plugin/
│       │   └── plugin.json            AUTHORED — Claude reads this. MUST NOT contain `skills` or `agents` fields.
│       ├── .github/plugin/
│       │   └── plugin.json            GENERATED — Copilot reads this. Identical to the Claude one plus `agents: ["./copilot/"]`.
│       ├── skills/                    AUTHORED — agentskills.io spec, identical for both harnesses
│       │   └── <skill>/
│       │       ├── SKILL.md
│       │       ├── references/        optional
│       │       └── scripts/           optional
│       ├── agents/                    GENERATED — Claude agents only, `<name>.md`
│       │   └── <name>.md
│       └── copilot/                   GENERATED — Copilot agents only, `<name>.agent.md`
│           └── <name>.agent.md
│
├── scripts/
│   ├── build_agents.py           src/agents/ + .claude-plugin/plugin.json → agents/, copilot/, .github/plugin/plugin.json
│   └── validate.py               full repo invariant checks
│
├── Makefile                      canonical command surface
├── AGENTS.md                     this file
├── CLAUDE.md → AGENTS.md         symlink (Claude Code convention)
└── README.md                     user-facing install + plugin/skill/agent index
```

### File ownership

| Path | Authored / Generated | Notes |
|---|---|---|
| `src/agents/<name>/` | Authored | Source of truth for agents. |
| `plugins/<plugin>/skills/<skill>/` | Authored | `SKILL.md` follows the [agentskills.io spec](https://agentskills.io/specification). |
| `plugins/<plugin>/.claude-plugin/plugin.json` | Authored | Read by Claude. **No `skills` field** (Claude rejects it) and **no `agents` field** (build provides the Copilot override separately). |
| `plugins/<plugin>/.github/plugin/plugin.json` | **Generated** | Read by Copilot. Identical to the Claude manifest plus `"agents": ["./copilot/"]`. Never edit. |
| `plugins/<plugin>/agents/<name>.md` | **Generated** | Claude agent. Never edit. |
| `plugins/<plugin>/copilot/<name>.agent.md` | **Generated** | Copilot agent. Never edit. |
| `.claude-plugin/marketplace.json` | Authored | One entry per plugin; versions must match per-plugin `plugin.json`. |
| `.claude-plugin/plugin.json` | Authored | Root single-install manifest. |

---

## Commands (Makefile is the only surface)

| Command | Purpose |
|---|---|
| `make help` | List all targets. |
| `make build` | Generate agent files **and** the per-plugin Copilot `plugin.json`. |
| `make validate` | Build sync + plugin manifest hygiene + SKILL.md spec + marketplace ↔ disk + README ↔ disk. |
| `make new-agent NAME=<name> PLUGIN=<plugin>` | Scaffold a new agent under `src/agents/<name>/`. |
| `make new-skill PLUGIN=<plugin> NAME=<name>` | Scaffold `plugins/<plugin>/skills/<name>/SKILL.md`. |
| `make clean` | Remove all generated files. |

**Always run `make validate` before committing.** It catches drift between sources, generated agent files, Copilot manifests, the marketplace, and the README.

---

## How agents work (the 3-layer source format)

Each agent lives in `src/agents/<name>/`:

| File | Required | Purpose |
|---|---|---|
| `agent.yaml` | Yes | Shared frontmatter: `name`, `description`, `plugin`, `model`. Plus anything else identical for both harnesses. |
| `body.md` | Yes | The system prompt. Same for both harnesses. |
| `claude.yaml` | No | Keys to add or override for the Claude Code output. |
| `copilot.yaml` | No | Keys to add or override for the Copilot CLI output. |

### Build behavior

For each agent the build script produces:

```
plugins/<plugin>/agents/<name>.md          ← agent.yaml merged with claude.yaml  (Claude reads this)
plugins/<plugin>/copilot/<name>.agent.md   ← agent.yaml merged with copilot.yaml (Copilot reads this)
```

Per-harness keys win over shared keys on conflict. The `plugin` field is stripped from both outputs (it's repo-level routing, not part of harness frontmatter).

For each plugin the build script also produces:

```
plugins/<plugin>/.github/plugin/plugin.json   ← copy of .claude-plugin/plugin.json + `"agents": ["./copilot/"]`
```

This is what makes Copilot CLI scan `copilot/` for `.agent.md` files instead of (incorrectly) scanning `agents/`.

### Recognised frontmatter keys

**Shared (`agent.yaml`)**
- `name` — kebab-case, must match the directory name, used as filename for both outputs.
- `description` — trigger phrase. Both harnesses use this to decide when to invoke the agent — write it as `"…Use when …"`.
- `plugin` — target plugin name. Defaults to first `-` segment of `name` (e.g. `api-reviewer` → `api`).
- `model` — model identifier (e.g. `sonnet`).

**Claude-only (`claude.yaml`)** — see the [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference#agents).
- `tools` — comma-separated string, e.g. `Read, Edit, Bash`.
- `effort`, `maxTurns`, `disallowedTools`, `skills`, `memory`, `background`, `isolation`.

**Copilot-only (`copilot.yaml`)** — see the [Copilot custom-agent reference](https://docs.github.com/en/copilot/reference/custom-agents-configuration).
- `name` — override the shared kebab-case identifier with a pretty display label (e.g. `"API Reviewer"`).
- `tools` — YAML array, e.g. `[read, edit, execute]`.
- `argument-hint`, `target`, `disable-model-invocation`, `user-invocable`, `mcp-servers`, `metadata`.

---

## Design constraints (do not violate)

These are load-bearing — the layout breaks if any of them slip.

| Constraint | Why |
|---|---|
| `.claude-plugin/plugin.json` must NOT contain a `skills` field. | Claude Code rejects the manifest outright. Both harnesses auto-discover `skills/` when the field is absent. |
| `.claude-plugin/plugin.json` must NOT contain an `agents` field. | Claude's `agents` field expects file paths and overrides auto-discovery. The Copilot override (`["./copilot/"]`) lives only in `.github/plugin/plugin.json`. |
| No `.agent.md` files in `agents/`. | Claude scans `agents/` for any `*.md`; a `foo.agent.md` would be loaded and shadow `foo.md`. Empirically tested. |
| No `.md` files in `copilot/`. | Symmetric — keeps Copilot's discovery clean and removes ambiguity. |
| Marketplace.json sits at `.claude-plugin/marketplace.json` (repo root). | Claude reads here; Copilot CLI falls back to `.claude-plugin/marketplace.json` when looking up marketplaces. |

`validate.py` enforces each of these.

---

## How to add a new skill

1. Pick a target plugin (see `README.md` or `ls plugins/`).
2. Scaffold:
   ```bash
   make new-skill PLUGIN=<plugin> NAME=<skill-name>
   ```
3. Fill in the `description` (10–1024 chars, agent-triggering phrase) and the body of `SKILL.md`.
4. Bump the plugin version in `plugins/<plugin>/.claude-plugin/plugin.json` and the matching entry in `.claude-plugin/marketplace.json`.
5. Add a row to the **Skills** table in `README.md`.
6. Run `make validate`.

## How to add a new agent

1. Scaffold:
   ```bash
   make new-agent NAME=<agent-name> PLUGIN=<plugin>
   ```
2. Edit the four files under `src/agents/<agent-name>/`:
   - `agent.yaml` — set `description` (trigger phrase) and `model`.
   - `claude.yaml` — pick the Claude `tools` list.
   - `copilot.yaml` — pick the Copilot `tools` list and any display overrides.
   - `body.md` — write the system prompt.
3. Run `make build` to generate the per-harness files.
4. Add a row to the **Agents** table in `README.md`.
5. Run `make validate`.

## How to update a skill or agent

| Change | Steps |
|---|---|
| Edit a skill body | Edit `plugins/<plugin>/skills/<skill>/SKILL.md`. Bump plugin version. Run `make validate`. |
| Edit an agent prompt | Edit `src/agents/<agent>/body.md`. Run `make build`, then `make validate`. |
| Add a tool to an agent | Edit `claude.yaml` and/or `copilot.yaml`. Run `make build`, then `make validate`. |
| Bump a plugin version | Edit `plugins/<plugin>/.claude-plugin/plugin.json` + the matching marketplace entry. Run `make build` to refresh `.github/plugin/plugin.json`, then `make validate`. |
| Rename or remove a plugin | Update `marketplace.json`, delete the plugin dir, update the README tables, run `make validate`. |

---

## Versioning

Use semantic versioning (MAJOR.MINOR.PATCH) at three levels:

| What changed | Bump the version in |
|---|---|
| Skill content (in any plugin) | `plugins/<plugin>/.claude-plugin/plugin.json` **and** the matching entry in `.claude-plugin/marketplace.json`. The Copilot manifest is regenerated by `make build`. |
| Agent body or frontmatter | The plugin that owns the agent (same as above). |
| Cross-cutting / new plugin / marketplace shape | `.claude-plugin/plugin.json` (root manifest) **and** `.claude-plugin/marketplace.json#metadata.version`. |

`validate.py` flags any mismatch between per-plugin Claude `plugin.json`, Copilot `plugin.json`, and the marketplace entry.

---

## Installation reference

| Harness | Install marketplace | Install one plugin |
|---|---|---|
| Claude Code | `/plugin marketplace add giocaizzi/skills` | `/plugin install <plugin>@giocaizzi-skills` |
| GitHub Copilot CLI | `copilot plugin marketplace add giocaizzi/skills` | `copilot plugin install <plugin>@giocaizzi-skills` |
| VS Code Copilot | Browse `@agentPlugins` in the Extensions sidebar after adding the marketplace, or use **Chat: Install Plugin From Source** with the repo URL. | — |

The repo-root `.claude-plugin/marketplace.json` is what both CLI harnesses fetch. Each plugin then exposes the right manifest to the right harness via `.claude-plugin/plugin.json` (Claude) and `.github/plugin/plugin.json` (Copilot).

---

## Commit conventions

Conventional Commits 1.0.0:

- `feat(agents): add <name> agent`
- `feat(skills/<plugin>): add <name> skill`
- `fix(agents): correct <name> frontmatter`
- `chore: bump <plugin> to 1.0.2`

Mark breaking changes with `!` in the header or a `BREAKING CHANGE:` footer.

---

## Reference

- Claude Code — [plugins](https://code.claude.com/docs/en/plugins) · [plugin reference](https://code.claude.com/docs/en/plugins-reference) · [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) · [subagents](https://code.claude.com/docs/en/sub-agents)
- GitHub Copilot CLI — [about plugins](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins) · [plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference) · [custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- VS Code Copilot — [agent plugins (preview)](https://code.visualstudio.com/docs/copilot/customization/agent-plugins) · [agent skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- Agent Skills standard — [agentskills.io](https://agentskills.io/specification)
