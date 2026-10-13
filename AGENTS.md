# AGENTS.md — contributor guide

This repository is a **cross-harness plugin marketplace** for AI coding assistants. It distributes a set of plugins (each plugin contains skills and optionally agents and hooks) for **Claude Code**, **GitHub Copilot CLI**, **VS Code Copilot** (agent plugins), **Codex CLI**, **opencode** and **pi**. What each harness gets and why: [docs/compatibility.md](docs/compatibility.md); install runbook: [docs/install.md](docs/install.md).

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

VS Code Copilot (agent plugins) detects a plugin with `.claude-plugin/plugin.json` as **Claude format**: it reads `agents/*.md` (any `.md`, Claude frontmatter mapped), `skills/` and `hooks/hooks.json`, and never reads `.github/plugin/plugin.json` or `copilot/`. A `.plugin/plugin.json` or root `plugin.json` would switch it to another format, so neither may exist. Hook details: [docs/guard.md](docs/guard.md).

Empirically tested: if you put both `foo.md` and `foo.agent.md` in the same `agents/` directory, Claude double-loads and the second one wins. So the two harnesses' agent files **must live in different directories**, and each harness must read a `plugin.json` that points to its directory.

This repo treats everything that is identical (skills, plugin metadata) as one source of truth and **generates the per-harness artifacts** that diverge (agent files, the Copilot and Codex `plugin.json`, the Codex hooks file).

The other three harnesses read the same sources differently (details in [docs/compatibility.md](docs/compatibility.md)):

- **Codex** resolves `.claude-plugin/marketplace.json` and the plugins' skills as-is, but reads `.codex-plugin/plugin.json` first, rejects a hooks file with `modules`, and takes agents only as TOML in `~/.codex/agents`. So the build generates `.codex-plugin/plugin.json` (pointing at `hooks/codex.json`), `hooks/codex.json` (plus a plugin's Codex-only `hooks/codex-only.json`, e.g. sounds' Stop hook), and `codex/<name>.toml`, which `scripts/install.mjs` copies.
- **opencode** has no plugin bundles or marketplace: `scripts/install.mjs` copies skills and the generated `opencode/<name>.md` agents and writes plugin stubs that load `plugins/guard/hooks/opencode.mjs` and `plugins/sounds/hooks/opencode.mjs`.
- **pi** installs the whole repo as a package from the root `package.json` (`pi` key: skills and the extensions `guard`, `hud`, `sounds` `hooks/pi.mjs` and `dev-tools/pi/subagent.mjs`, which runs the Claude-format agents as a `subagent` tool).

---

## Repository layout

```
.
├── .claude-plugin/
│   └── marketplace.json          ← ONE marketplace; both harnesses read here (Copilot uses .claude-plugin/ as a fallback for the marketplace)
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
│       ├── copilot/                   GENERATED — Copilot agents only, `<name>.agent.md`
│       │   └── <name>.agent.md
│       ├── codex/                     GENERATED — Codex agents, `<name>.toml`
│       ├── opencode/                  GENERATED — opencode subagents, `<name>.md`
│       ├── .codex-plugin/plugin.json  GENERATED — Codex reads this (Claude manifest + `hooks: ./hooks/codex.json`)
│       ├── hooks/                     AUTHORED — hooks.json (+ codex-only.json) + Node hook scripts; codex.json is GENERATED
│       └── core/                      AUTHORED — pure rule engine the hooks import (guard plugin)
│
├── scripts/
│   ├── build_agents.py           src/agents/ + manifests → agents/, copilot/, codex/, opencode/, .github/plugin/, .codex-plugin/, hooks/codex.json
│   ├── install.mjs               copies Codex agents / opencode skills, agents and guard/sounds stubs from a checkout
│   └── validate.py               full repo invariant checks
├── tests/e2e/                    drives Codex, opencode and pi against a scripted model (`make e2e`)
├── package.json                  pi package manifest (`pi` key)
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
| `plugins/<plugin>/codex/<name>.toml`, `opencode/<name>.md` | **Generated** | Codex and opencode agents. Never edit. |
| `plugins/<plugin>/.codex-plugin/plugin.json`, `hooks/codex.json` | **Generated** | Codex manifest and hooks file. Never edit. |
| `plugins/<plugin>/hooks/`, `core/` | Authored | Hooks: `hooks.json` for Claude, Copilot, VS Code; `opencode.mjs`, `pi.mjs` over `bridge.mjs` for the in-process harnesses. See [docs/guard.md](docs/guard.md). |
| `package.json` | Authored | pi package: `pi.skills` and `pi.extensions`. |
| `plugins/<plugin>/hooks/pi.mjs`, `plugins/dev-tools/pi/subagent.mjs` | Authored | pi extensions; tests beside them (`make test` globs `plugins/*/pi/*.test.mjs` too). |
| `.claude-plugin/marketplace.json` | Authored | One entry per plugin; versions must match per-plugin `plugin.json`. |

---

## Commands (Makefile is the only surface)

| Command | Purpose |
|---|---|
| `make help` | List all targets. |
| `make build` | Generate agent files **and** the per-plugin Copilot `plugin.json`. |
| `make validate` | Build sync + plugin manifest hygiene + SKILL.md spec + marketplace ↔ disk + README ↔ disk. |
| `make check` | `make lint` + `make test` (standard entrypoint, run by CI; `make lint` is an alias for `make validate`). |
| `make e2e` | Codex, opencode and pi against a scripted model in throwaway homes (skips a CLI that is missing; CI runs it on Linux, macOS and Windows). |
| `make install HARNESS="codex opencode"` | Copy what Codex and opencode cannot take from the marketplace into their config dirs. |
| `make new-agent NAME=<name> PLUGIN=<plugin>` | Scaffold a new agent under `src/agents/<name>/`. |
| `make new-skill PLUGIN=<plugin> NAME=<name>` | Scaffold `plugins/<plugin>/skills/<name>/SKILL.md`. |
| `make clean` | Remove all generated files. |

**Always run `make validate` before committing.** It catches drift between sources, generated agent files, Copilot manifests, the marketplace, and the README.

If `make validate` fails, check the common drift points first:
- version mismatch between `plugins/<plugin>/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and, when applicable, `pyproject.toml`
- missing or stale README table rows after adding or renaming a skill or agent
- stale generated files after editing `src/agents/`, plugin manifests or a `hooks/hooks.json`; rerun `make build`, then `make validate`

## Hooks (the `guard` plugin)

`plugins/guard/hooks/hooks.json` is read by all three harnesses: Claude Code natively, Copilot CLI and VS Code as Claude-format (PascalCase events, `tool_name`/`tool_input` payload, `hookSpecificOutput.permissionDecision`). Architecture, decisions and the install/verify runbook: [docs/guard.md](docs/guard.md).

- `make test` runs `node --test` over `plugins/*/core/*.test.mjs` and `plugins/*/hooks/*.test.mjs` (Node 22+), then `claude plugin test` for every plugin with `tests/*.test.ts` (the Claude mod). Add a test with every rule change.
- `hooks.json` may hold both `hooks` (command hooks, both harnesses) and `modules` (a Claude Code mod, which Copilot CLI and VS Code ignore). A mod module imports `claude-code`, so keep its logic in a pure sibling file node can test (`weather.mjs`), and keep functions that take `$` declared at the top level (`claude plugin validate` rejects `$` passed to a closure).
- A hook script must never exit non-zero by accident: Copilot denies a `PreToolUse` whose hook fails. Fail open for reminders; the risky-command ask fails closed on purpose.
- Use `${CLAUDE_PLUGIN_ROOT}` in commands and `CLAUDE_PLUGIN_DATA` for state: both CLIs set them; VS Code sets only `CLAUDE_PLUGIN_ROOT`, so read `CLAUDE_PLUGIN_DATA` with a fallback.
- VS Code ignores `matcher`: every hook of an event runs, so each script checks `tool_name` itself. One `command` field runs under bash and PowerShell, so keep it to `node "<path>" <args>`.
- Codex reads `hooks/codex.json`, generated from `hooks.json`; opencode and pi run `hooks/opencode.mjs` and `hooks/pi.mjs`, which go through `hooks/bridge.mjs` to the same handlers. A new hook script needs its event mapped in both adapters (and a case in `adapters.test.mjs`), or a row in docs/compatibility.md saying why not.
- Rules are data in `plugins/guard/core/rules.mjs`; `core/engine.mjs` stays pure (no I/O). Bump the `guard` version (plugin.json + marketplace entry) for every behaviour change: installed caches update only on a version change.

---

## How agents work (the 3-layer source format)

Each agent lives in `src/agents/<name>/`:

| File | Required | Purpose |
|---|---|---|
| `agent.yaml` | Yes | Shared frontmatter: `name`, `description`, `plugin`, `model`. Plus anything else identical for both harnesses. |
| `body.md` | Yes | The system prompt. Same for both harnesses. |
| `claude.yaml` | No | Keys to add or override for the Claude Code output. `make new-agent` creates it by default, but you may omit or delete it if you do not need Claude-specific overrides. |
| `copilot.yaml` | No | Keys to add or override for the Copilot CLI output. `make new-agent` creates it by default, but you may omit or delete it if you do not need Copilot-specific overrides. |
| `codex.yaml` | No | Codex-only keys (`model`, `model_reasoning_effort`, `sandbox_mode`, ...). Codex gets only `name`, `description` and the body from the shared files. |
| `opencode.yaml` | No | opencode-only frontmatter (`model` as `provider/id`, `permission`, ...). opencode gets only `description`, `mode: subagent` and the body from the shared files. |

### Build behavior

For each agent the build script produces:

```
plugins/<plugin>/agents/<name>.md          ← agent.yaml merged with claude.yaml  (Claude reads this)
plugins/<plugin>/copilot/<name>.agent.md   ← agent.yaml merged with copilot.yaml (Copilot reads this)
plugins/<plugin>/codex/<name>.toml         ← name, description + codex.yaml, body as developer_instructions (scripts/install.mjs copies it)
plugins/<plugin>/opencode/<name>.md        ← description, mode: subagent + opencode.yaml (scripts/install.mjs copies it)
```

Per-harness keys win over shared keys on conflict. The `plugin` field is stripped from every output (it's repo-level routing, not part of harness frontmatter). A shared `model` reaches Claude, Copilot and VS Code only: it names a Claude tier, which Codex and opencode do not understand.

For each plugin the build script also produces:

```
plugins/<plugin>/.github/plugin/plugin.json   ← copy of .claude-plugin/plugin.json + `"agents": ["./copilot/"]`
```

This is what makes Copilot CLI scan `copilot/` for `.agent.md` files instead of (incorrectly) scanning `agents/`.

### Recognised frontmatter keys

**Shared (`agent.yaml`)**
- `name` — kebab-case, must match the directory name, used as filename for both outputs.
- `description` — trigger phrase. Both harnesses use this to decide when to invoke the agent — write it as `"…Use when …"`.
- `plugin` — target plugin name. Defaults to the substring before the first `-` in `name`. If `name` contains no `-`, it defaults to the full `name` (e.g. `api-reviewer` → `api`, `linter` → `linter`).
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
| Marketplace.json sits at `.claude-plugin/marketplace.json` (repo root). | Claude reads here; Copilot CLI and VS Code fall back to `.claude-plugin/marketplace.json` when looking up marketplaces. |
| No `.plugin/plugin.json` or root `plugin.json` in a plugin. | VS Code would detect another plugin format and skip the Claude layout. |
| Skill `name` is kebab-case and equals its directory. | VS Code skips any other skill silently. |
| No Claude-only key (`modules`) reaches Codex. | Codex rejects the whole hooks file; `hooks/codex.json` is generated without it. |
| `package.json` `pi.skills` is `["./plugins/*/skills"]` and `pi.extensions` loads `plugins/guard/hooks/pi.mjs`. | pi installs the repo from it. |

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
2. Edit the scaffolded files under `src/agents/<agent-name>/`:
   - `agent.yaml` — set `description` (trigger phrase) and `model`.
   - `body.md` — write the system prompt.
   - `claude.yaml` — adjust the Claude `tools` list if you need Claude-specific overrides; otherwise you can leave it as scaffolded or delete it.
   - `copilot.yaml` — adjust the Copilot `tools` list and any display overrides if you need Copilot-specific overrides; otherwise you can leave it as scaffolded or delete it.
3. Run `make build` to generate the per-harness files.
4. Add a row to the **Agents** table in `README.md`.
5. Run `make validate`.

## How to update a skill or agent

| Change | Steps |
|---|---|
| Edit a skill body | Edit `plugins/<plugin>/skills/<skill>/SKILL.md`. Bump plugin version. Run `make validate`. |
| Edit an agent prompt | Edit `src/agents/<agent>/body.md`. Run `make build`, then `make validate`. |
| Add a tool to an agent | Edit `claude.yaml` and/or `copilot.yaml`. Run `make build`, then `make validate`. |
| Bump a plugin version | Edit `plugins/<plugin>/.claude-plugin/plugin.json` + the matching marketplace entry. If the change also bumps the marketplace metadata version, keep the root `pyproject.toml` version in sync with that repo version. Run `make build` to refresh `.github/plugin/plugin.json`, then `make validate`. |
| Rename or remove a plugin | Update `marketplace.json`, delete the plugin dir, update the README tables, run `make validate`. |

---

## Versioning

Use semantic versioning (MAJOR.MINOR.PATCH) at three levels:

| What changed | Bump the version in |
|---|---|
| Skill content (in any plugin) | `plugins/<plugin>/.claude-plugin/plugin.json` **and** the matching entry in `.claude-plugin/marketplace.json`. The Copilot manifest is regenerated by `make build`. |
| Agent body or frontmatter | The plugin that owns the agent (same as above). |
| Cross-cutting / new plugin / marketplace shape | `.claude-plugin/marketplace.json#metadata.version`, the root `pyproject.toml#project.version`, plus any affected per-plugin `plugin.json` files. |

`validate.py` flags any mismatch between per-plugin Claude `plugin.json`, Copilot `plugin.json`, the marketplace entry, and the root `pyproject.toml` repo version.

---

## Installation reference

Full runbook: [docs/install.md](docs/install.md).

| Harness | Install marketplace | Install one plugin |
|---|---|---|
| Claude Code | `/plugin marketplace add giocaizzi/harness` | `/plugin install <plugin>@giocaizzi-harness` |
| GitHub Copilot CLI | `copilot plugin marketplace add giocaizzi/harness` | `copilot plugin install <plugin>@giocaizzi-harness` |
| VS Code Copilot | Add `giocaizzi/harness` to `chat.plugins.marketplaces` | `@agentPlugins` in the Extensions view, or **Chat: Install Plugin From Source** |
| Codex CLI | `codex plugin marketplace add giocaizzi/harness` | `codex plugin add <plugin>@giocaizzi-harness`; agents: `make install HARNESS=codex` |
| opencode | — | `make install HARNESS=opencode` from a clone |
| pi | — | `pi install git:github.com/giocaizzi/harness` (the whole repo) |

The repo-root `.claude-plugin/marketplace.json` is what both CLI harnesses fetch. Each plugin then exposes the right manifest to the right harness via `.claude-plugin/plugin.json` (Claude) and `.github/plugin/plugin.json` (Copilot).

---

## Reference

- Claude Code — [plugins](https://code.claude.com/docs/en/plugins) · [plugin reference](https://code.claude.com/docs/en/plugins-reference) · [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) · [subagents](https://code.claude.com/docs/en/sub-agents)
- GitHub Copilot CLI — [about plugins](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins) · [plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference) · [custom agents](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- VS Code Copilot — [agent plugins (preview)](https://code.visualstudio.com/docs/copilot/customization/agent-plugins) · [agent skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- Codex CLI — [plugins](https://learn.chatgpt.com/docs/plugins) · [hooks](https://learn.chatgpt.com/docs/hooks) · [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- opencode — [plugins](https://opencode.ai/docs/plugins/) · [agents](https://opencode.ai/docs/agents/) · [skills](https://opencode.ai/docs/skills/)
- pi — [packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) · [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- Agent Skills standard — [agentskills.io](https://agentskills.io/specification)
