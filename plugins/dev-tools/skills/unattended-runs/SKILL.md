---
name: unattended-runs
description: Running agents with nobody at the keyboard - overnight, autopilot, headless or auto-approve sessions - without stalling on a prompt or doing damage. Use before starting or resuming a long autonomous run, when launching a harness with an auto-approve mode (bypass, --allow-all, --auto, -a never), or when an agent hangs waiting for confirmation.
---

# Unattended runs

Nobody answers prompts, so every confirmation is either a hang (interactive session left open) or a refusal (headless run). Plan so neither happens.

## Before you start

- **Set `GUARD_UNATTENDED=1`** in the launching shell. The `guard` plugin then turns every risky-command ask into a deny that tells the agent to pick another approach, in every harness. Without it an open TUI waits at the prompt until morning.
- **Prefer headless** (`claude -p`, `copilot -p`, `codex exec`, `opencode run`, `pi -p`) over a TUI left open: a refused command ends in a different approach, not a hang. Headless runs cannot ask, so their risky commands never run.
- **One worktree per task** (`/wt`), pushed early. Guard lets a clean worktree whose commits are on a remote ref, or squash-merged, be removed without an ask.
- **Check quota and host first** (`host-hygiene`): an overnight fan-out hits the plan limit or the load cap while you sleep. Guard's host guard delays heavy builds and tests; on Claude Code the usage throttle also pauses near 90 %; elsewhere nothing does, so check quota yourself.

## What the agent must not rely on

Guard denies, and does not allow, these commands unattended; plan the work so they are not needed:

- `rm -r` outside a temp dir or a clean, pushed worktree
- `git worktree remove --force`, `git reset --hard`, `git push --force`
- `terraform apply` / `destroy`, `gh pr merge --admin`
- secret reads (`bw`/`bws get|list|run`, `security … -w`, `op read`, `pass show`, cloud secret managers, `printenv`/`env | grep TOKEN`, `cat .env`); inject a token with `VAR="$(<keyring read>)" <command>`, which passes

Dev mode (`--dev`, `<APP>_DEV=1`) is refused when `GUARD_UNATTENDED=1`: a relaxed check has no one watching its warning (see `repo-standard` `references/dev-mode.md`).

Leave anything that needs them in the final report for the human, with the exact command. Do not rewrite the command to dodge the pattern (`find -delete`, `git checkout -f`, a script that wraps it): the rule marks work that needs a person.

## Auto-approve modes do not disable guard

Denies (pip/poetry in a uv repo, non-Conventional-Commit titles, skill reminders, host guard) hold in every mode and harness. Hooks run before the mode applies. Auto modes change only what the harness prompts for on its own, so do not pass an approve-everything flag to get past a guard deny; fix the command.

## Finish

End with a report that separates done, blocked-by-guard (command and reason) and left running. A run that stopped on a deny is a result, not a failure.

Mechanism, per-harness behaviour and limits: `docs/guard.md` in the harness repo (section Unattended and auto-approve runs).
