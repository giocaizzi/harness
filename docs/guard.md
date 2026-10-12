# guard plugin

Agent rules enforced as hooks, from one plugin, for Claude Code and Copilot CLI on macOS, Linux and Windows. It replaces `giocaizzi/agent-mods` (Claude mod + Copilot extension) and the hook scripts that lived in the dotfiles.

## Architecture

| Piece | Role |
|---|---|
| `core/rules.mjs` | Data: skill rules (command pattern -> skill), heavy and risky command patterns, title types, host caps, usage thresholds. |
| `core/engine.mjs` | Pure decisions: `evaluateCommand` (risky ask, title guard, host guard, skill reminder), `evaluateSpawn`, blast-radius preview argv, safe-delete facts through an injected runner. |
| `core/host.mjs` | Host-fact parsers (load average, free disk, Windows CPU percent). |
| `hooks/hooks.json` | Command hooks, Claude format. Both harnesses load it from the installed plugin. |
| `hooks/guard.mjs` | The command hook: reads the event on stdin, gathers facts, asks the engine, writes `hookSpecificOutput` on stdout. |

Events:

| Event (Claude / Copilot) | Matcher | What runs |
|---|---|---|
| `PreToolUse` / `preToolUse` | `Bash`, `PowerShell`, `Skill` (and the lowercase Copilot names) | Shell: risky ask, title guard, host guard, skill reminder. Skill: records the loaded skill. |
| `UserPromptSubmit` / `userPromptSubmitted` | all | A typed `/skill` counts as loaded. |
| `SessionEnd` / `sessionEnd` | all | Drops the session's state file (and any older than a week). |

## Decisions

- **Command hooks, not a mod or an extension.** Copilot CLI (1.0.95) loads a plugin's `hooks/hooks.json`, accepts Claude's PascalCase events and payload (`tool_name` carries Claude names such as `Bash`), runs `command` under bash or PowerShell, sets `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`, and honours `hookSpecificOutput.permissionDecision` `allow|deny|ask`. One file serves both harnesses, with no `--experimental`.
- **State in a file.** A command hook is a fresh process, so the loaded skills and the rules already reminded live in `$CLAUDE_PLUGIN_DATA/sessions/<session_id>.json`. Read-modify-write without a lock: parallel calls can lose a write, which only repeats a reminder.
- **Remind once, ask every time.** A skill rule denies once per session with the skill to load; the title guard denies every time; risky commands return `ask` every time, with a read-only blast-radius preview (`du -sh`, `git status --short`, `git log HEAD..@{u}`).
- **Safe deletes.** `rm -r`, `Remove-Item -Recurse` and `git worktree remove --force` skip the ask when every target is strictly under a temp dir or is the root of a linked worktree that is clean with every commit on a remote ref. Globs, `~`, `..`, quotes and unset variables still ask.
- **Fail open for reminders, closed for risky.** A crash while judging a risky command denies it; anything else lets the call through. The script never exits non-zero, because Copilot denies a `preToolUse` whose hook fails. A hook timeout is fail-open on both harnesses.
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

In a live session: `git commit -m "bad"` is denied with the Conventional Commit hint; `rm -rf build` shows the permission prompt with a `Would affect:` preview; `rm -rf /tmp/x` runs without asking.

## Troubleshooting

| Symptom | Check |
|---|---|
| No guard at all | Plugin enabled? Claude: `/plugin`; Copilot: `copilot plugin list`. `node` on PATH (22+)? |
| Every shell call denied on Copilot | The hook exits non-zero (Copilot fails `preToolUse` closed): run it by hand as above and read stderr. |
| A reminder repeats | Parallel tool calls raced on the state file; harmless. |
