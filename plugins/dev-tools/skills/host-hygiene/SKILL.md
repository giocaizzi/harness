---
name: host-hygiene
description: Keeping a shared dev machine healthy when several agents run at once - disk floor, load cap, heavy-command semaphore, device leases, service registry, stale-worktree sweep, plan-quota awareness. Use before builds, emulators or simulators, full test suites, long-running services or parallel agents, or when the host is slow.
---

# Host hygiene

Agents share one machine. Let its load and your plan's quota set how much runs at once, not a fixed count. **Repo tooling wins:** if the repo ships its own heavy wrapper or lease script, use it; a second semaphore is a second, parallel limit that defeats the first.

## Scripts

In this skill's `scripts/`, `.sh` on macOS/Linux and `.ps1` on Windows. Env, defaults and the lock-path contract are in the header of `lib.sh` / `lib.ps1`.

- `heavy.sh <cmd...>`: run a build, precommit or full suite in a machine-wide heavy slot; `--status` shows slots, waiters, leases and services.
- `lease.sh <class> [--device <id>] -- <cmd...>`: heavy slot, then the one lease for a device class (simulator, emulator); shuts down a device it booted.
- `register-service.sh <name> -- <cmd...>`: run a database, dev server or watcher registered under its owner, unregistered on exit; `--list` shows them.
- `sweep-stale.sh [--apply]`: list (default) or remove worktrees idle for 24 h, unused by any process and clean.

## Rules

- **Disk first.** Below the floor (20 GB) don't start: clean your own leftovers. Never delete another session's files.
- **Heavy work goes through the semaphore** and waits for a slot and for load; don't wrap it in your own retry loop. One heavy job per agent.
- **Devices are leased:** slot first, then lease. Boot a simulator or emulator only inside a lease; a booted device with no lease is stale and anyone may shut it down.
- **Release only what you hold.** Never delete a lock, lease or registry entry whose pid is not yours.
- **Stop things precisely:** wait on a pid or a file. Never `pgrep -f` or `pkill` a pattern.
- **Register long-running services;** stop yours before you finish.
- **Worktrees:** one per task, removed when its PR merges. Never install into another task's tree.
- **Quota.** Before fanning out, check plan usage (Claude Code: `cd /tmp && claude -p "/usage"`; Copilot CLI: `/usage`; Codex: `/status`; opencode: `opencode stats`; pi: none, so check the provider's console) and back off near the limit. Stagger resumes after a reset.
- **Mind the Stop hook budget.** The `guard` plugin runs `make check` when an agent stops, only if the repo changed since the last green run, and gives up after 1750 s (`GUARD_STOP_TIMEOUT_MS`; `GUARD_STOP_CHECK=off` disables it). A repo whose `check` runs longer than that never gets verified by the hook: make `check` fast (parallel tests) and run the long gate yourself through `heavy.sh`.
- **End with a cleanup line** in your final report: what you started, what you stopped, what is left running and why.

Why each rule exists, and the incidents behind it: [references/lessons.md](references/lessons.md) (read when designing host tooling or debugging a stuck lock).

## When the repo has no host tooling

Write the limits above as a runbook in `docs/` that points to these scripts, and link it from `AGENTS.md`. Record incidents there too (what overloaded the machine and which rule now prevents it).
