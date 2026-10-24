---
name: host-hygiene
description: Keeping a shared dev machine healthy when several agents run at once - disk floor, load cap, heavy-command semaphore, device leases, service registry, stale-worktree and branch sweep, memory hygiene, plan-quota awareness. Use before builds, emulators or simulators, full test suites, long-running services or parallel agents, or when the host is slow.
---

# Host hygiene

Agents share one machine. Let its load and your plan's quota set how much runs at once, not a fixed count. **Repo tooling wins:** if the repo ships its own heavy wrapper or lease script, use it; a second semaphore is a second, parallel limit that defeats the first.

## Scripts

In this skill's `scripts/`, `.sh` on macOS/Linux and `.ps1` on Windows. Env, defaults and the lock-path contract are in the header of `lib.sh` / `lib.ps1`. Name them by `${CLAUDE_PLUGIN_ROOT}/skills/host-hygiene/scripts/`, which Claude Code renders as this session's install path; copy that into briefs, never a path remembered from an earlier session, since an upgrade prunes old versions. Where it shows unrendered, use the path this skill was loaded from. Don't give the plugin a `bin/` to put the scripts on PATH: claude.ai and Cowork skip any plugin that has one.

- `heavy.sh <cmd...>`: run a build, precommit or full suite in a machine-wide heavy slot; `--status` shows slots, waiters, leases and services.
- `lease.sh <class> [--device <id>] -- <cmd...>`: heavy slot, then the one lease for a device class (simulator, emulator); shuts down a device it booted.
- `register-service.sh <name> -- <cmd...>`: run a database, dev server or watcher registered under its owner, unregistered on exit; `--list` shows them.
- `node memory-lint.mjs [--repo <path>] [<dir>...]`: report-only lint of Claude Code auto-memory (all projects by default).
- `sweep-stale.sh [--apply]`: list (default) or remove worktrees idle for 24 h, unused by any process and clean.
- `sweep-stale.sh --branches [--apply]`: list (default) or delete remote branches with no open PR and local branches whose upstream is gone. Delete only when the user asks.

## Rules

- **Disk first.** Below the floor (20 GB) don't start: clean your own leftovers. Never delete another session's files.
- **Heavy work goes through the semaphore** and waits for a slot and for load; don't wrap it in your own retry loop. One heavy job per agent. Background it only where the harness wakes the same agent when it exits (Claude Code's main session); subagents and teammates are not woken, so they run it in the foreground with `HOST_LOCK_TIMEOUT_SECONDS` under the tool-call timeout. On a tool timeout, re-run once; never stack a second waiter (`--status`).
- **Devices are leased:** slot first, then lease. Boot a simulator or emulator only inside a lease; a booted device with no lease is stale and anyone may shut it down.
- **Release only what you hold.** Never delete a lock, lease or registry entry whose pid is not yours.
- **Stop things precisely:** wait on a pid or a file. Never `pgrep -f` or `pkill` a pattern.
- **Register long-running services;** stop yours before you finish.
- **Worktrees and branches:** one worktree per task, removed when its PR merges; branches left without a PR are swept with `--branches`. Never install into another task's tree.
- **Quota.** Before fanning out, check plan usage (Claude Code: `cd /tmp && claude -p "/usage"`; Copilot CLI: `/usage`; Codex: `/status`; opencode: `opencode stats`; pi: none, so check the provider's console) and back off near the limit. Stagger resumes after a reset.
- **Mind the Stop hook budget.** The `guard` plugin runs `make check` when an agent stops, only if the repo changed since the last green run, and defers it after 300 s (`GUARD_STOP_TIMEOUT_MS`; `GUARD_STOP_CHECK=off` disables it). A repo whose `check` runs longer than that never gets verified by the hook: make `check` fast (parallel tests) and run the long gate yourself through `heavy.sh`.
- **Memory is context the next session trusts.** One fact per file, replace instead of append, no status or one-off authorizations, conventions in skills; unattended runs never write it. Rules, per-harness differences and the report-only audit: [references/memory-hygiene.md](references/memory-hygiene.md).
- **End with a cleanup line** in your final report: what you started, what you stopped, what is left running and why.

Why each rule exists, and the incidents behind it: [references/lessons.md](references/lessons.md) (read when designing host tooling or debugging a stuck lock).

## When the repo has no host tooling

Write the limits above as a runbook in `docs/` that points to these scripts, and link it from `AGENTS.md`. Record incidents there too (what overloaded the machine and which rule now prevents it).
