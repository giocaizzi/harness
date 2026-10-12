# guard plugin

Agent rules enforced as hooks, from one plugin, for Claude Code, Copilot CLI and VS Code Copilot (agent plugins) on macOS, Linux and Windows.

## Architecture

| Piece | Role |
|---|---|
| `core/rules.mjs` | Data: skill rules (command pattern -> skill), deny rules, heavy and risky command patterns, title types, host caps, usage thresholds. |
| `core/engine.mjs` | Pure decisions: `evaluateCommand` (risky ask, title guard, host guard, skill reminder), `evaluateSpawn`, blast-radius preview argv, safe-delete facts through an injected runner. |
| `core/host.mjs` | Host-fact parsers (load average, free disk, Windows CPU percent). |
| `hooks/hooks.json` | Command hooks, Claude format. All three harnesses load it from the installed plugin. |
| `hooks/guard.mjs` | The command guard: reads the event on stdin, gathers facts (host, worktrees, the repo's Python manager), asks the engine, writes `hookSpecificOutput` on stdout. |
| `hooks/stop.mjs` | `make check` before the agent stops (was the dotfiles `stop-make-check.sh`/`.ps1`). |
| `hooks/lint.mjs` | shellcheck / PSScriptAnalyzer after an edit (was the dotfiles `post-edit-lint.sh`/`.ps1`). |
| `hooks/awake.mjs` | Keep-awake keeper tied to the harness process. |
| `hooks/mod.mjs` | Claude Code mod (`modules` in `hooks.json`, ignored by Copilot CLI and VS Code): usage throttle, the token-weather band, `/weather` pane, and the toasts and alert sound (`sounds/alert.wav`). `hooks/weather.mjs` holds its pure display logic, shared with `hooks/statusline.mjs`; `types/index.d.ts` declares its `$.state`. |
| `hooks/statusline.mjs` | Status line for both CLIs (`statusLine.command`), from the status JSON piped on stdin: `claude` argument draws Claude Code's two lines (user, git, GCP project, path, model, context, 5h and 7d battery with reset, cost); no argument draws Copilot CLI's token-weather line. |

Events:

| Event (Claude and VS Code / Copilot CLI) | Tools (matcher, re-checked in the script) | What runs |
|---|---|---|
| `SessionStart` / `sessionStart` | all | Keep-awake keeper, one per harness process. |
| `PreToolUse` / `preToolUse` | Shell: `Bash`, `PowerShell` (Claude), `bash`, `powershell` (Copilot), `run_in_terminal` (VS Code). Skill: `Skill`, `skill` | Shell: deny rules (pip, poetry), risky ask, title guard, host guard, skill reminder. Skill: records the loaded skill. |
| `PostToolUse` / `postToolUse` | `Edit`, `Write`, `MultiEdit` (Claude); `edit`, `create`, `Edit` with an apply_patch string (Copilot); `create_file`, `replace_string_in_file`, `multi_replace_string_in_file`, `insert_edit_into_file`, `apply_patch` (VS Code) | Lint the edited files; findings as `additionalContext`. |
| `Stop` / `agentStop` | all | `make check` when the repo changed since the last green run; on failure `decision: block` once, never when `stop_hook_active`. |
| `UserPromptSubmit` / `userPromptSubmitted` | all | A typed `/skill` counts as loaded. |
| `SessionEnd` / `sessionEnd` | all | Drops the session's state file (and any older than a week). VS Code does not fire it; the weekly sweep covers it. |

## Decisions

- **Command hooks, not a mod or an extension.** Copilot CLI (1.0.95) loads a plugin's `hooks/hooks.json`, accepts Claude's PascalCase events and payload (`tool_name` carries Claude names such as `Bash`), runs `command` under bash or PowerShell, sets `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`, and honours `hookSpecificOutput.permissionDecision` `allow|deny|ask`. One file serves every harness, with no `--experimental`.
- **VS Code reads the same file.** VS Code (1.139) detects the plugin as Claude format from `.claude-plugin/plugin.json`, loads `hooks/hooks.json`, maps both PascalCase and Copilot camelCase event names, sets `CLAUDE_PLUGIN_ROOT` but not `CLAUDE_PLUGIN_DATA` (state falls back to `<tmpdir>/guard-plugin`), and **ignores `matcher`**: every command of an event runs, so each script checks `tool_name` itself and passes anything else untouched. VS Code sends its own tool names (`run_in_terminal`, `create_file`, ...) and reads `permissionDecision` and `additionalContext` from `hookSpecificOutput`.
- **One output, every reader.** Where the harnesses read different fields, the hook writes both: post-edit lint puts `additionalContext` at the top level (Copilot CLI) and in `hookSpecificOutput` (Claude, VS Code); the stop hook puts `decision`/`reason` at the top level (Claude, Copilot CLI) and in `hookSpecificOutput` (VS Code). Claude and Copilot CLI accept the extra fields (checked live).
- **State in a file.** A command hook is a fresh process, so the loaded skills and the rules already reminded live in `$CLAUDE_PLUGIN_DATA/sessions/<session_id>.json`. Read-modify-write without a lock: parallel calls can lose a write, which only repeats a reminder.
- **Remind once, ask every time.** A skill rule denies once per session with the skill to load; the title guard denies every time the subject of `git commit -m`, `gh pr create --title`/`-t`, `glab mr create|update --title`/`-t` or `az repos pr create|update --title` is not a Conventional Commit (az's `-t` is the target branch, so only `--title` counts); risky commands return `ask` every time, with a read-only blast-radius preview (`du -sh`, `git status --short`, `git log HEAD..@{u}`).
- **Safe deletes.** `rm -r`, `Remove-Item -Recurse` and `git worktree remove --force` skip the ask when every target is strictly under a temp dir or is the root of a linked worktree that is clean and either has every commit on a remote ref or is squash-merged: `gh pr list --head <branch> --state merged` (run in the worktree, 5 s timeout) finds a merged PR whose head contains HEAD. Any gh failure asks, with the reason. Globs, `~`, `..`, quotes and unset variables still ask.
- **Fail open for reminders, closed for risky.** A crash while judging a risky command denies it; anything else lets the call through. The script never exits non-zero, because Copilot denies a `preToolUse` whose hook fails. A hook timeout is fail-open on both harnesses.
- **Deny rules are data, scoped to the repo.** `rules.deny` (pip, pipx, `python -m pip`; poetry) is matched on what the command would run, so a quoted mention passes. A rule with `when: "uv"` denies every time, before anything else, only in a uv repo; elsewhere the command runs and the agent gets one note per session (`hookSpecificOutput.additionalContext`, no permission decision) naming the repo's manager. Copilot CLI (1.0.95) passes that note to the agent too (checked live), and VS Code documents `additionalContext` on `PreToolUse`. The hook finds the manager in the nearest directory up to the repo root: `uv.lock` → uv; `poetry.lock` or `[tool.poetry]` → poetry; `Pipfile`/`Pipfile.lock` → pipenv; `requirements*.txt` without a `pyproject.toml` `[project]` table → pip; any other `pyproject.toml` → uv; none → no Python project. Plain `node:fs` calls, the same on every OS; a read error counts as no project.
- **Stop runs `make check` once, and only on change.** No make, no Makefile or no `check` target: the agent stops. The hook fingerprints the repo (`HEAD`, `git diff HEAD`, untracked file names) and skips the check when it equals the last green run, stored under `$CLAUDE_PLUGIN_DATA/stop/`; outside git it always runs. A failure blocks the stop with the last 40 lines; the next stop (`stop_hook_active`) always passes, so it cannot loop (Copilot also caps at 8 blocks). The check times out after 1750 s (`GUARD_STOP_TIMEOUT_MS` overrides; the hook limit is 1800 s). A timeout is shown as a `systemMessage`, never blocks and never counts as green. `GUARD_STOP_CHECK=off` disables the hook.
- **Lint is advice, not a block.** Findings come back as `hookSpecificOutput.additionalContext`; a missing shellcheck, pwsh or PSScriptAnalyzer skips silently. The file path is `tool_input.file_path` (Claude) or `tool_input.path` (Copilot).
- **Keep-awake follows the harness.** The hook walks past shell parents to the harness pid (under VS Code, the extension host: the keeper lives as long as the window) and starts a detached keeper bound to it: `caffeinate -i -w <pid>` (macOS), `systemd-inhibit --what=idle:sleep tail --pid=<pid> -f /dev/null` (Linux), a hidden PowerShell holding `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)` until `Wait-Process -Id <pid>` (Windows). The keeper pid is kept in `$CLAUDE_PLUGIN_DATA/awake/<harness pid>.pid`, so resume, `/clear` and compaction reuse it. It prevents idle sleep only; the display may still sleep.
- **The mod is Claude-only.** Copilot CLI and VS Code have no mods API and no rate-limit windows, so the throttle has no Copilot side. The weather line reaches Copilot CLI as a status line instead: Copilot pipes `context_window` (context %, cumulative input, cache read and write tokens) to `statusLine.command`, so it shows `ctx N% · cache N%` with the session's hit rate (Copilot exposes no per-turn usage and no cache TTL, so no countdown). VS Code has no status-line hook. The band calls `await next(e)` and draws its line above whatever plugins beneath drew (next-steps and the like), never in their place. It draws from session start (context part), counts only main-loop turns, suppresses `cache cold` on the first turn (which always writes the cache), forgets the last turn on `/clear` (`session.end` with `reason: clear`), and counts down the prompt-cache TTL (`promptCacheTtl` setting, `5m` when unset) from the end of the last turn, redrawing once a second. Toasts: the context crossing 80% and 90%, each limit window (5h, 7d, gateway spend) crossing 80%, 90% and 100%, one minute before the prompt cache expires and when it has; each is raised once and re-arms after the level is left. Each toast, and each way a turn can end (answer, interrupt, refusal, API error, subagent), has its own sound setting (`soundLimit5h`, `soundContext`, `soundDone`, …; a picker over `off`, `chime`, `ping`, `alert`, `warn`, `error`, `done`, `tick` in `/config`), plus `doneAfterSeconds` (skip the finished sound for shorter turns) and `soundGain`. Two alerts of one turn that share a sound play it once. Clips are `sounds/*.wav`, played with macOS `afplay` only; Linux and Windows play nothing. The pane lists the last turn's tokens and a sparkline of the 5h and 7d windows per turn. Copilot's line appends `N req` (premium requests; Copilot reports no dollars).
- **`ask` is the harness's own prompt.** Under `claude -p` or a non-interactive Copilot run nobody can answer, so the risky command does not run.
- **The skill enforcer counts the `skill` tool.** Claude's `Skill`, Copilot CLI's and VS Code's `skill` record the loaded skill; a skill read any other way is not seen, so the reminder fires once and the retry passes.

## Install

All three harnesses read the repo's one marketplace (`.claude-plugin/marketplace.json`).

```bash
# Claude Code
claude plugin marketplace add giocaizzi/harness
claude plugin install guard@giocaizzi-harness

# Copilot CLI
copilot plugin marketplace add giocaizzi/harness
copilot plugin install guard@giocaizzi-harness
```

VS Code: add `giocaizzi/harness` to `chat.plugins.marketplaces` (with `chat.plugins.enabled` on), then install `guard` from `@agentPlugins` in the Extensions view; or run **Chat: Install Plugin From Source** with the repo URL.

Copilot CLI token weather: in `~/.copilot/settings.json` (Windows: `%USERPROFILE%\.copilot\settings.json`) set
`"statusLine": { "type": "command", "command": "node ~/.copilot/installed-plugins/giocaizzi-harness/guard/hooks/statusline.mjs" }`.

Claude Code status line: in `~/.claude/settings.json` set
`"statusLine": { "type": "command", "command": "node ~/.claude/plugins/marketplaces/giocaizzi-harness/plugins/guard/hooks/statusline.mjs claude" }`
(the marketplace clone has a stable path; the plugin cache path changes with every version). Needs `node` 22+ and, for the icons, a Nerd Font.

Managed machines enable it from the dotfiles settings (`enabledPlugins: { "guard@giocaizzi-harness": true }` in both the Claude and the Copilot settings templates).

## Verify

From a checkout, without starting a session:

```bash
make check                                        # validate (incl. `claude plugin validate`) + node tests + `claude plugin test`
claude plugin validate plugins/guard

# Copilot: install into a throwaway home, never ~/.copilot
export COPILOT_HOME="$(mktemp -d)"
copilot plugin install ./plugins/guard
copilot plugin list                               # shows guard
rm -rf "$COPILOT_HOME"; unset COPILOT_HOME

# VS Code: a throwaway profile, never your own
code --user-data-dir "$(mktemp -d)" --extensions-dir "$(mktemp -d)" .
# then set chat.plugins.enabled and "chat.pluginLocations": { "<abs>/plugins/guard": true },
# and check the plugin and its hooks under Chat: Open Agent Customizations

# The hook by hand: a non-conventional commit is denied
echo '{"hook_event_name":"PreToolUse","session_id":"t","tool_name":"Bash","tool_input":{"command":"git commit -m bad"}}' \
  | CLAUDE_PLUGIN_DATA="$(mktemp -d)" node plugins/guard/hooks/guard.mjs
```

In a live Claude session the band shows `cache N% · ttl M:SS` after the first turn, with a weather icon for the context fullness and a sparkline of the last 8 turns after two turns (Nerd Font icons: the terminal needs a Nerd Font, else they show as boxes); `/weather` opens the history pane. In Copilot CLI the status line shows `ctx N%` at once and `cache N%` after the first turn. In a uv repo: `pip install x` and `poetry add x` are denied; in a poetry or requirements repo they run, with one note. In any session: ending a turn in a repo whose `make check` fails continues the turn once with the failure; `pmset -g assertions | grep caffeinate` (macOS) or `systemd-inhibit --list` (Linux) shows the keeper; `git commit -m "bad"` is denied with the Conventional Commit hint; `rm -rf build` shows the permission prompt with a `Would affect:` preview; `rm -rf /tmp/x` runs without asking.

## Grafana

Each deny or ask (`guard.decision`, from the command hook) and each usage-throttle denial (`guard.throttle`, from the Claude mod) is sent as one OTLP/HTTP log record to `$OTEL_EXPORTER_OTLP_ENDPOINT/v1/logs`. Nothing is sent when that variable is unset: the work machines (chezmoi strips `OTEL_*` there) and any Copilot or VS Code launch without it stay silent. The auth headers come from `OTEL_EXPORTER_OTLP_HEADERS` and are never logged; a send that fails or takes longer than 2 s is dropped and the decision stands.

The resource carries `service.name=guard` plus `OTEL_RESOURCE_ATTRIBUTES` (`service.namespace`, `host.name`). In Loki: stream labels `service_name`, `host_name`, `service_namespace`; structured metadata `rule`, `action`, `tool`, `harness`, `window`, `percent`.

Verify: after a denied command, `{service_name="guard"}` in Grafana Explore shows the record; `sum by (rule) (count_over_time({service_name="guard"} | rule != "" [1h]))` counts denials per rule.

## Troubleshooting

| Symptom | Check |
|---|---|
| No guard at all | Plugin enabled? Claude: `/plugin`; Copilot: `copilot plugin list`; VS Code: `chat.plugins.enabled`, `chat.useHooks` and the Agent Customizations editor. `node` on PATH (22+)? |
| Every shell call denied on Copilot | The hook exits non-zero (Copilot fails `preToolUse` closed): run it by hand as above and read stderr. |
| Session never ends a turn on Copilot | `make check` keeps failing: the agent gets 8 blocks at most, then stops. |
| Machine still sleeps | Keeper running? `pgrep -fl caffeinate` / `systemd-inhibit --list`; on Linux `systemd-inhibit` needs a logind session. |
| A reminder repeats | Parallel tool calls raced on the state file; harmless. |
