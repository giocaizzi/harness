# `guard` plugin

Agent guardrails as hooks: one rule engine that runs under Claude Code, GitHub Copilot CLI, VS Code Copilot and Codex as command hooks (`hooks/hooks.json`, `.generated/codex/hooks.json`) and under opencode and pi as in-process plugins (`hooks/opencode.mjs`, `hooks/pi.mjs`), on macOS, Linux and Windows. Per-harness differences: [docs/compatibility.md](../../docs/compatibility.md). No skills or agents. Architecture and the install/verify runbook: [docs/guard.md](../../docs/guard.md). The UI moved to [`hud`](../hud/README.md) and toasts and sounds to [`sounds`](../sounds/README.md).

## Hooks

| Hook | Event | Harness | What it does |
|---|---|---|---|
| `skill-enforcer` | PreToolUse (shell) | all | Before `git commit`, `gh pr`, `glab mr`, `az repos pr`, worktree and release commands, denies once per session until the matching skill is loaded. |
| `title-guard` | PreToolUse (shell) | all | Denies `git commit -m` (heredoc and `-F -` included), `gh pr create|edit --title`, `glab mr create|update --title` or `az repos pr create|update --title` whose subject does not match the org's PR-title check, every time, for every titled command in the chain. |
| `host-guard` | PreToolUse (shell) | all | Denies a heavy build or test run once when load, CPU or free disk is past its cap, pointing to `host-hygiene`'s `heavy.sh` and `lease.sh`; commands already run through a heavy or lease wrapper pass. |
| `risky-ask` | PreToolUse (shell) | all; Codex and opencode ask through their own prompt rules for plain forms (`rm -rf build`, `git push --force origin x`: plain words, no `$`, `~`, globs or quotes) and deny the rest | Asks before `rm -r` (every spelling), `find -delete`, force-push, `git push --mirror` or deleting main, `git reset --hard`, `git clean -f`, `git checkout .`, `git stash drop`, `git branch -D`, also behind `git -C dir` and inside `bash -c`, `eval`, `ssh`, `docker exec`, `cmd /c` and `powershell -Command`, `terraform`/`tofu apply`, `git update-ref -d`/`filter-repo`, data-loss deletes outside git (docker volumes, `gh … delete`, `gh api -X DELETE`, `kubectl delete`, `helm uninstall`, `gcloud`/`az … delete`, `dd`, `mkfs`), `gh pr merge --admin`, `az repos pr --bypass-policy`, and secret reads (`bw`/`bws`, `security -w`, `op read`, `pass show`, cloud secret managers, `gh auth token` and other token printers, a bare `env` dump, `printenv`/`env | grep TOKEN`, `echo $X_TOKEN`, any reader of `.env`, `~/.aws/credentials` or ssh keys; a quoted `VAR="$(…)"` injection passes), with a plain-words summary of the risky step, where it runs, the rule, and a blast-radius preview (a risky step buried in a chain of more than 3 commands is denied with "run it on its own"); deletes under a temp dir, of a clean worktree or a branch that is pushed or has a merged PR, or of git-ignored build output pass. |
| `pip-deny` | PreToolUse (shell) | all | In a uv repo, denies `pip`, `pip3`, `pipx`, `python -m pip` and `poetry` every time; `uv pip` passes. In a poetry, pipenv or pip repo they run, with one note per session. |
| `stop-check` | Stop | all; opencode and pi send the failure back as a message | Runs `make check` before the agent stops, only when the repo changed since the last green run; on failure blocks once with the output tail. make runs with no terminal; a timeout (default 300 s, `GUARD_STOP_TIMEOUT_MS`) defers it to the next stop, never blocks; `GUARD_STOP_CHECK=off` disables it. |
| `shell-edit-hint` | PreToolUse (shell) | all but Codex (its hooks cannot add context) | Once per session, after `sed -i`, `perl -pi`, inline Python or Node writing a file, or `echo`/`printf`/`cat`/`tee`/`Set-Content` into one (not /dev/*, an fd or a temp path), tells the agent to use its edit tool, which the lint and docs hints watch. |
| `post-edit-lint` | PostToolUse (edit tools) | all | shellcheck on edited `.sh`/`.bash` (not zsh or fish scripts, not temp files), PSScriptAnalyzer on `.ps1`; findings go back to the agent. Missing linter: skip. |
| `keep-awake` | SessionStart | all | Keeps the machine awake while the harness runs (VS Code: while the window is open): `caffeinate -w` (macOS), `systemd-inhibit` (Linux), `SetThreadExecutionState` (Windows). |
| `usage-throttle` | mod `agent.spawn` | Claude | Refuses new subagents at 90% of the worst plan window. Copilot exposes no rate-limit windows. |
| `ask-timeout` | mod `tool.check` | Claude (pi, opencode: [#100](https://github.com/giocaizzi/harness/issues/100); others cannot: [#101](https://github.com/giocaizzi/harness/issues/101)) | Puts each permission ask that would reach the person in an Allow/Deny dialog and parks it after 60 seconds without an answer (`GUARD_ASK_TIMEOUT_MS`; `0` turns it off), telling the agent "no answer, carry on or park it", never "the user denied". Logs each outcome as `guard.ask_result`. Auto mode's own asks stay with its classifier; `dontAsk` stays with the engine. |
| `decision-log` | PreToolUse (shell), mod `agent.spawn` | all (throttle: Claude) | Sends each deny, ask and throttle denial as an OTLP log record to the collector in `OTEL_EXPORTER_OTLP_ENDPOINT` (or its `GUARD_` copy, since Claude Code and Copilot strip `OTEL_*` from hooks); nothing without it. See [docs/guard.md](../../docs/guard.md#grafana). |
| `skill-tracker` | PreToolUse (Skill, a read of `SKILL.md`), UserPromptSubmit (`/skill`, `/skill:name`, `$skill`) | all | Records loaded skills and typed slash commands for the skill enforcer. |

## Install

```bash
/plugin install guard@giocaizzi-harness          # Claude Code
copilot plugin install guard@giocaizzi-harness   # Copilot CLI
codex plugin add guard@giocaizzi-harness         # Codex, then trust its hooks in /hooks
make install HARNESS=codex                       # Codex prompt rules for risky commands, from a clone
make install HARNESS=opencode                    # opencode, from a clone
pi install git:github.com/giocaizzi/harness      # pi
```

VS Code and the details per harness: [docs/install.md](../../docs/install.md).

