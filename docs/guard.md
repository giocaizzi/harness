# guard plugin

Agent rules enforced as hooks, from one plugin, for Claude Code and Copilot CLI on macOS, Linux and Windows. It replaces `giocaizzi/agent-mods` (Claude mod + Copilot extension) and the hook scripts that lived in the dotfiles.

## Architecture

| Piece | Role |
|---|---|
| `core/rules.mjs` | Data: skill rules (command pattern -> skill), heavy and risky command patterns, title types, host caps, usage thresholds. |
| `core/engine.mjs` | Pure decisions: `evaluateCommand` (risky ask, title guard, host guard, skill reminder), `evaluateSpawn`, blast-radius preview argv, safe-delete facts through an injected runner. |
| `core/host.mjs` | Host-fact parsers (load average, free disk, Windows CPU percent). |
| `hooks/hooks.json` | Command hooks, Claude format. Both harnesses load it from the installed plugin. |
| `hooks/guard.mjs` | The command guard: reads the event on stdin, gathers facts, asks the engine, writes `hookSpecificOutput` on stdout. |
| `hooks/stop.mjs` | `make check` before the agent stops (was the dotfiles `stop-make-check.sh`/`.ps1`). |
| `hooks/lint.mjs` | shellcheck / PSScriptAnalyzer after an edit (was the dotfiles `post-edit-lint.sh`/`.ps1`). |
| `hooks/awake.mjs` | Keep-awake keeper tied to the harness process. |

Events:

| Event (Claude / Copilot) | Matcher | What runs |
|---|---|---|
| `SessionStart` / `sessionStart` | all | Keep-awake keeper, one per harness process. |
| `PreToolUse` / `preToolUse` | `Bash`, `PowerShell`, `Skill` (and the lowercase Copilot names) | Shell: deny rules (pip), risky ask, title guard, host guard, skill reminder. Skill: records the loaded skill. |
| `PostToolUse` / `postToolUse` | `Edit`, `Write`, `MultiEdit` (and Copilot `edit`, `create`) | Lint the edited file; findings as `additionalContext`. |
| `Stop` / `agentStop` | all | `make check`; on failure `decision: block` once, never when `stop_hook_active`. |
| `UserPromptSubmit` / `userPromptSubmitted` | all | A typed `/skill` counts as loaded. |
| `SessionEnd` / `sessionEnd` | all | Drops the session's state file (and any older than a week). |

## Decisions

- **Command hooks, not a mod or an extension.** Copilot CLI (1.0.95) loads a plugin's `hooks/hooks.json`, accepts Claude's PascalCase events and payload (`tool_name` carries Claude names such as `Bash`), runs `command` under bash or PowerShell, sets `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`, and honours `hookSpecificOutput.permissionDecision` `allow|deny|ask`. One file serves both harnesses, with no `--experimental`.
- **State in a file.** A command hook is a fresh process, so the loaded skills and the rules already reminded live in `$CLAUDE_PLUGIN_DATA/sessions/<session_id>.json`. Read-modify-write without a lock: parallel calls can lose a write, which only repeats a reminder.
- **Remind once, ask every time.** A skill rule denies once per session with the skill to load; the title guard denies every time; risky commands return `ask` every time, with a read-only blast-radius preview (`du -sh`, `git status --short`, `git log HEAD..@{u}`).
- **Safe deletes.** `rm -r`, `Remove-Item -Recurse` and `git worktree remove --force` skip the ask when every target is strictly under a temp dir or is the root of a linked worktree that is clean with every commit on a remote ref. Globs, `~`, `..`, quotes and unset variables still ask.
- **Fail open for reminders, closed for risky.** A crash while judging a risky command denies it; anything else lets the call through. The script never exits non-zero, because Copilot denies a `preToolUse` whose hook fails. A hook timeout is fail-open on both harnesses.
- **Deny rules are data.** `rules.deny` (today: pip, pipx, `python -m pip`; uv only) denies every time, before anything else, matched on what the command would run, so a quoted mention passes. It replaces the dotfiles `block-pip` hook and the Claude `Bash(pip:*)` deny entries.
- **Stop runs `make check` once.** No make, no Makefile or no `check` target: the agent stops. A failure blocks the stop with the last 40 lines; the next stop (`stop_hook_active`) always passes, so it cannot loop (Copilot also caps at 8 blocks).
- **Lint is advice, not a block.** Findings come back as `hookSpecificOutput.additionalContext`; a missing shellcheck, pwsh or PSScriptAnalyzer skips silently. The file path is `tool_input.file_path` (Claude) or `tool_input.path` (Copilot).
- **Keep-awake follows the harness.** The hook walks past shell parents to the harness pid and starts a detached keeper bound to it: `caffeinate -i -w <pid>` (macOS), `systemd-inhibit --what=idle:sleep tail --pid=<pid> -f /dev/null` (Linux), a hidden PowerShell holding `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED)` until `Wait-Process -Id <pid>` (Windows). The keeper pid is kept in `$CLAUDE_PLUGIN_DATA/awake/<harness pid>.pid`, so resume, `/clear` and compaction reuse it. It prevents idle sleep only; the display may still sleep.
- **`ask` is the harness's own prompt.** Under `claude -p` or a non-interactive Copilot run nobody can answer, so the risky command does not run.

## Install

Both harnesses read the repo's one marketplace.

```bash
# Claude Code
claude plugin marketplace add giocaizzi/skills
claude plugin install guard@giocaizzi-skills

# Copilot CLI
copilot plugin marketplace add giocaizzi/skills
copilot plugin install guard@giocaizzi-skills
```

Managed machines enable it from the dotfiles settings (`enabledPlugins: { "guard@giocaizzi-skills": true }` in both the Claude and the Copilot settings templates).

## Verify

From a checkout, without starting a session:

```bash
make check                                        # validate (incl. `claude plugin validate`) + node tests
claude plugin validate plugins/guard

# Copilot: install into a throwaway home, never ~/.copilot
export COPILOT_HOME="$(mktemp -d)"
copilot plugin install ./plugins/guard
copilot plugin list                               # shows guard
rm -rf "$COPILOT_HOME"; unset COPILOT_HOME

# The hook by hand: a non-conventional commit is denied
echo '{"hook_event_name":"PreToolUse","session_id":"t","tool_name":"Bash","tool_input":{"command":"git commit -m bad"}}' \
  | CLAUDE_PLUGIN_DATA="$(mktemp -d)" node plugins/guard/hooks/guard.mjs
```

In a live session: `pip install x` is denied; ending a turn in a repo whose `make check` fails continues the turn once with the failure; `pmset -g assertions | grep caffeinate` (macOS) or `systemd-inhibit --list` (Linux) shows the keeper; `git commit -m "bad"` is denied with the Conventional Commit hint; `rm -rf build` shows the permission prompt with a `Would affect:` preview; `rm -rf /tmp/x` runs without asking.

## Troubleshooting

| Symptom | Check |
|---|---|
| No guard at all | Plugin enabled? Claude: `/plugin`; Copilot: `copilot plugin list`. `node` on PATH (22+)? |
| Every shell call denied on Copilot | The hook exits non-zero (Copilot fails `preToolUse` closed): run it by hand as above and read stderr. |
| Session never ends a turn on Copilot | `make check` keeps failing: the agent gets 8 blocks at most, then stops. |
| Machine still sleeps | Keeper running? `pgrep -fl caffeinate` / `systemd-inhibit --list`; on Linux `systemd-inhibit` needs a logind session. |
| A reminder repeats | Parallel tool calls raced on the state file; harmless. |
