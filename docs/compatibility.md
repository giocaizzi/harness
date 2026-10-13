# Compatibility

What each plugin does under each harness, why, and how it is checked. Install steps: [install.md](install.md). Hook details: [guard.md](guard.md), [hud.md](hud.md), [sounds.md](sounds.md).

Versions checked: Claude Code 2.1.296, Copilot CLI 1.0.95, VS Code 1.139, Codex CLI 0.162.1, opencode 1.19.0, pi 1.2.0 (October 2026).

## Matrix

| Plugin / feature | Claude Code | Copilot CLI | VS Code Copilot | Codex CLI | opencode | pi |
|---|---|---|---|---|---|---|
| Install | marketplace | marketplace | marketplace (`chat.plugins.marketplaces`) | marketplace (plugins) + `make install` (agents) | `make install` | `pi install git:…` |
| Skills (`api`, `python`, `javascript`, `dev-tools`) | yes | yes | yes | yes | yes, copied to `~/.config/opencode/skills` | yes |
| Agents (`api-reviewer`, `scout`, `escalate`) | yes, `agents/*.md` | yes, `copilot/*.agent.md` | yes, `agents/*.md` (Claude format) | yes, `codex/*.toml` in `~/.codex/agents` | yes, `opencode/*.md` in `~/.config/opencode/agents` | yes, through the `subagent` tool (`dev-tools/pi/subagent.mjs`): each call is its own `pi -p` session |
| `dev-tools` `host-hygiene` scripts (`.sh` macOS/Linux, `.ps1` Windows) | yes | yes | yes | yes | yes | yes |
| `guard` deny rules, title guard, host guard, pip deny | yes | yes | yes, Local agent (`chat.useHooks`) | yes | yes | yes |
| `guard` risky-command ask | yes, ask | yes, ask | yes, ask | deny with the reason: Codex hooks cannot ask ([#69](https://github.com/giocaizzi/harness/issues/69)) | deny with the reason: plugins cannot ask ([#69](https://github.com/giocaizzi/harness/issues/69)) | yes, confirm dialog; blocked without a UI (`-p`, JSON) |
| `guard` skill tracker | `Skill` tool, `/skill` | `skill` tool, `/skill` | `skill` tool | `$skill`, a read of its `SKILL.md` | `skill` tool, `/skill` | `/skill:name`, a read of its `SKILL.md` |
| `guard` post-edit lint | yes | yes | yes | yes | yes, appended to the tool output | yes, appended to the tool result |
| `guard` stop `make check` | yes, blocks the stop | yes | yes | yes, blocks the stop | yes, sends the failure back on idle | yes, sends the failure back when the run settles |
| `guard` keep-awake | yes | yes | yes, while the window is open | yes | yes | yes |
| `guard` usage throttle | yes (mod) | no: no mods API, no rate-limit windows | no: no mods API | no: no mods API ([#68](https://github.com/giocaizzi/harness/issues/68)) | no ([#68](https://github.com/giocaizzi/harness/issues/68)) | no: no plan rate-limit windows |
| `hud` band, pane, PR strip, spinner | yes (mod) | no: no mods API ([#47](https://github.com/giocaizzi/harness/issues/47)) | no: no mods API | no: no mods API, `Stop` output is a warning line only | no: TUI slots take SolidJS JSX, undocumented ([#68](https://github.com/giocaizzi/harness/issues/68)) | PR strip and context weather in the footer (`hud/hooks/pi.mjs`); no pane or spinner |
| `hud` status line | yes (`statusLine.command`) | yes (`statusLine.command`) | no: no status-line hook | no: `tui.status_line` takes built-in items only | no: no status-line command; TUI slots undocumented ([#68](https://github.com/giocaizzi/harness/issues/68)) | yes, the footer status (`ctx.ui.setStatus`) |
| `sounds` toasts and sounds | yes (mod), sounds on macOS only | no: no mods API | no: no mods API | turn and context alerts with the default clips (`Stop` hook, `sounds/hooks/codex.mjs`), notices as a `systemMessage` warning, sounds on macOS only; no limit or cache alerts | turn, subagent and context alerts with the default clips (`sounds/hooks/opencode.mjs`), notices as toasts, sounds on macOS only; no limit or cache alerts | yes (`sounds/hooks/pi.mjs`): turn and context alerts with the default clips, sounds on macOS only; no limit or cache alerts |

Hosts: everything runs on macOS, Linux and Windows; the hooks need `node` 22+ on PATH. CI drives Codex, opencode and pi on all three ([Verify](#verify)); Claude Code, Copilot CLI and VS Code are checked live on macOS only, Windows is pending ([#25](https://github.com/giocaizzi/harness/issues/25)).

## How each harness reads the repo

| Harness | Marketplace | Plugin manifest | Agents | Hooks |
|---|---|---|---|---|
| Claude Code | `.claude-plugin/marketplace.json` | `.claude-plugin/plugin.json` | `agents/*.md` | `hooks/hooks.json` (command hooks + `modules`) |
| Copilot CLI | same | `.github/plugin/plugin.json` (generated; it wins over `.claude-plugin/`) | `copilot/*.agent.md` | `hooks/hooks.json`, Claude format |
| VS Code Copilot | same | `.claude-plugin/plugin.json` (Claude format) | `agents/*.md` | `hooks/hooks.json`, Claude format, `matcher` ignored |
| Codex CLI | same (Codex reads the Claude marketplace) | `.codex-plugin/plugin.json` (generated; wins over `.claude-plugin/`) | `codex/*.toml`, copied by `scripts/install.mjs` (Codex plugins carry no agents) | `hooks/codex.json` (generated: `hooks.json` without `modules`, plus `hooks/codex-only.json`), named by the Codex manifest |
| opencode | none: no plugin bundles | none | `opencode/*.md`, copied by `scripts/install.mjs` | `guard` and `sounds` `hooks/opencode.mjs`, in-process plugins; `install.mjs` writes a stub per plugin into `~/.config/opencode/plugins/` that re-exports it |
| pi | none: packages | root `package.json` (`pi` key) | `agents/*.md` read at runtime by `dev-tools/pi/subagent.mjs` | `guard`, `hud`, `sounds` `hooks/pi.mjs` and `dev-tools/pi/subagent.mjs`, in-process extensions listed in `package.json` |

## Decisions

- **One engine, thin adapters.** The rules live in `plugins/guard/core/` and `hooks/guard.mjs#handle`. Command-hook harnesses (Claude, Copilot, VS Code, Codex) run `guard.mjs`; in-process ones (opencode, pi) go through `hooks/bridge.mjs`, which builds the same Claude-shaped payload and calls the same handlers. A rule change reaches all six harnesses.
- **Codex reads the Claude plugin, nearly.** Codex resolves `.claude-plugin/marketplace.json`, installs each plugin and discovers its skills, and runs `hooks/hooks.json` with the Claude payload (`tool_name: "Bash"`, `hookSpecificOutput.permissionDecision`) and `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` set. Two things break: it rejects the whole hooks file for the Claude-only `modules` key, and it does not support `ask` (it marks the hook failed and runs the command). So `build_agents.py` writes `hooks/codex.json` without `modules` and with `--no-ask` on the guard, and a `.codex-plugin/plugin.json` that points at it.
- **Codex hooks need trust.** Codex skips plugin hooks until they are trusted in `/hooks`, per hook hash, so each guard version needs one review. `--dangerously-bypass-hook-trust` skips that for one run (the e2e tests use it).
- **No ask means deny.** Where a harness cannot ask (Codex, opencode), a risky command is denied with the risky reason and "ask the user to run it". The user runs it with the harness's own shell escape.
- **opencode has no plugin bundles.** Its plugins are npm packages or local files, and it has no marketplace, so `scripts/install.mjs` copies the skills and agents and writes a one-line plugin stub that re-exports `hooks/opencode.mjs` from the checkout. A pull updates the hook code; re-run the installer for skills and agents.
- **pi installs the repo.** `pi install git:github.com/giocaizzi/harness` reads the root `package.json`: `pi.skills` loads every plugin's skills, `pi.extensions` the guard, the subagent tool, hud's footer and sounds' alerts.
- **pi subagents are a tool.** pi has no subagents by design; `dev-tools/pi/subagent.mjs` registers `subagent` (`agent`, `task`), which runs the agent in its own `pi -p --no-session` process with its prompt appended (`--append-system-prompt`), its Claude `tools` mapped to pi's (`--tools`; scout: read, grep, find, ls, bash) and the session's model, and returns the final text. Agents come from the Claude-format `agents/*.md`, so nothing else is generated.
- **Codex and opencode get sounds, not hud.** Codex's `Stop` hook names the turn and its rollout, which holds the start time, errors and token counts, so `sounds/hooks/codex.mjs` plays the turn and context clips and returns the notices as `systemMessage` (a warning line); it lives in `hooks/codex-only.json` so the other command-hook harnesses do not run it. opencode's `session.idle`, `session.error` and `message.updated` events and `client.tui.showToast` carry the same alerts in `sounds/hooks/opencode.mjs`. Neither has a status-line command or a documented UI slot for `hud`. Codex's `token_count` events also carry `rate_limits`, so limit alerts and the throttle may be possible there ([#68](https://github.com/giocaizzi/harness/issues/68)).
- **pi gets hud and sounds from its UI API.** The footer status (`ctx.ui.setStatus`) carries the context weather, the model and the PR strip, refreshed after each run; `ctx.ui.notify` and `afplay` carry the turn and context alerts. pi has no per-plugin settings, no plan rate-limit windows and no prompt-cache TTL, so the clips are the Claude defaults and the limit and cache alerts are left out.
- **Stop in-process.** opencode and pi have no stop hook that blocks; the guard runs `make check` when the session goes idle or the run settles and, on failure, sends the output back as a new message once. The check runs synchronously, so the harness waits for it as a command hook would.
- **Agents' models.** The shared `model` names a Claude tier, so Codex and opencode agents get none and inherit the session's model; `src/agents/<name>/codex.yaml` and `opencode.yaml` add harness-only keys (scout: read-only sandbox, edit denied).
- **No root `plugin.json`.** The Agent Plugins spec's root `plugin.json` would win Copilot's and VS Code's manifest lookup, so the repo keeps per-harness manifests instead.

## Verify

```bash
make check   # validate (incl. `claude plugin validate`) + node tests + `claude plugin test`
make e2e     # Codex, opencode and pi against a scripted model (tests/e2e), each in a throwaway home
```

`make e2e` needs the three CLIs (`npm install -g @openai/codex opencode-ai @earendil-works/pi-coding-agent`) but no login: `tests/e2e/mock-llm.mjs` speaks the Responses and Chat Completions APIs and scripts one shell call. For each harness it installs this checkout the documented way, then checks that a `pip install` in a uv project is denied with the guard's reason, that a risky `rm -rf ~/…` is not run, and that the skills and the `scout` agent are in the model's prompt; on Codex it also checks that sounds' `Stop` hook ran; on pi it also delegates to `scout` through the `subagent` tool and checks the child session ran. CI runs it on Linux, macOS and Windows (`e2e` job).

### With a real model

Run the same two prompts by hand on an installed harness, from a uv project (a directory with `pyproject.toml` and `uv.lock`; outside one the pip rule does not fire):

```bash
copilot -p "Run exactly this shell command: pip install requests" --allow-tool shell
opencode run -m opencode/nemotron-3-ultra-free "Run exactly this shell command with the bash tool: pip install requests"
# then the same with: rm -rf ~/harness-e2e-does-not-exist
```

Expected: the pip call is denied with "This repo uses uv", and the `rm` is denied as a risky recursive delete (Copilot CLI and opencode in `-p`/`run` mode cannot ask, so they deny). opencode's free models need no login. Codex (`codex exec`) and pi (`pi -p`) need a logged-in provider. Last run (2026-10-13, macOS): Copilot CLI and opencode passed both, Claude Code denied pip; Codex and pi were not run (no login).
