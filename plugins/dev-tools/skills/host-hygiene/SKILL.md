---
name: host-hygiene
description: Keeping a shared dev machine healthy when several agents run at once - disk floor, load cap, heavy-command semaphore, device leases, service registry, stale-worktree, branch and plugin-cache sweep, memory hygiene, plan-quota awareness. Use before builds, emulators or simulators, full test suites, long-running services or parallel agents, or when the host is slow.
---

# Host hygiene

Agents share one machine. Let its load and your plan's quota set how much runs at once, not a fixed count. **Repo tooling wins:** if the repo ships its own heavy wrapper or lease script, use it; a second semaphore is a second, parallel limit that defeats the first.

## Scripts

In this skill's `scripts/`, `.sh` on macOS/Linux and `.ps1` on Windows. Env, defaults and the lock-path contract are in the header of `lib.sh` / `lib.ps1`. In a brief, name them by `${CLAUDE_PLUGIN_ROOT}/skills/host-hygiene/scripts/` as rendered here (unrendered: the path this skill was loaded from), never a remembered cache path: upgrades prune old versions.

- `heavy.sh <cmd...>`: run a build, precommit or full suite in a machine-wide heavy slot; `--status` shows slots, waiters, leases and services.
- `lease.sh <class> [--device <id>] -- <cmd...>`: heavy slot, then the one lease for a device class (simulator, emulator); shuts down a device it booted.
- `register-service.sh <name> -- <cmd...>`: run a database, dev server or watcher registered under its owner, unregistered on exit; `--list` shows them.
- `node memory-lint.mjs [--repo <path>] [<dir>...]`: report-only lint of Claude Code auto-memory (all projects by default).
- `sweep-stale.sh [--apply]`: list (default) or remove worktrees idle for 24 h, unused by any process and clean. It also lists dirs under `.claude/worktrees/` that git no longer registers, with their size and the command the owner runs to reclaim them; it never removes those. Pass `SWEEP_WORKTREES_ROOT` when the repo's `AGENTS.md` puts worktrees elsewhere.
- `sweep-stale.sh --branches [--apply]`: list (default) or delete remote branches with no open PR and local branches whose upstream is gone. Delete only when the user asks.
- `sweep-stale.sh --plugins [--marketplace <name>] [--after-reload] [--apply]`: list (default) or remove Claude Code plugin versions (`${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/<marketplace>/<plugin>/<version>`) that are not installed and that nothing may still run; every marketplace by default, only `<name>` with `--marketplace` (the exact name of a dir under `cache/`, case included; pass it when the user limits the sweep to one, so other marketplaces' versions stay); a version stays while a Claude Code process started before that plugin's last update, a symlinked version loses only its link, a linked marketplace or plugin dir is never entered, and a process list it cannot read removes nothing. The other harnesses keep no old versions: Codex replaces a plugin's cache dir on update, Copilot CLI keeps one unversioned copy, opencode and pi install from a checkout or package.

## Rules

- **Disk first.** Below the floor (20 GB) don't start: clean your own leftovers. Never delete another session's files.
- **Heavy work goes through the semaphore** and waits for a slot and for load; don't wrap it in your own retry loop. One heavy job per agent.
- **Read the gated command's own exit status.** Piping a gated command through `tail` or `grep` reports the filter's status: capture the status of the command itself (`set -o pipefail`, `PIPESTATUS`, or run it once into a log file and read `$?` before you tail the log), and report or push only on that.
- **Don't verify twice.** When CI runs the same suites on every PR, run the build, the type check or `vet`, and the tests that cover the change locally, and let CI be the full gate: many full-suite runs queued in one heavy slot become the throughput limit. Run the full suite locally when CI does not cover it (a local-only or platform-specific path, a repo without CI, a stop hook that needs it) or before a release. Run lint only when the change touches what it covers: a docs-only change needs no shell or PowerShell linter. CI is the gate for full suites.
- **Cap fan-out by load.** Size a fan-out by the host's load and free heavy slots (`heavy.sh --status` prints both), not a fixed count.
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

## Gotchas

- A subagent or teammate isn't woken when a backgrounded job exits: run `heavy.sh` in the foreground with `HOST_LOCK_TIMEOUT_SECONDS` under the tool timeout, and on a timeout check `--status` before re-running.
- A running Claude Code session runs the plugin version it loaded, spawning hooks from that folder without holding it open, until the user types `/reload-plugins`; a reload does not restart the process, so the sweep cannot see it. Only once the user has reloaded every open session, run `--plugins --after-reload --apply`; never sweep plugins on a schedule.
- Build tools that write read-only files into the worktree (the Go module cache, envtest binaries) make `git worktree remove` fail halfway and leave an unregistered dir that only the owner can delete: keep `GOMODCACHE` and envtest assets outside the worktree.

## When the repo has no host tooling

Write the limits above as a runbook in `docs/` that points to these scripts, and link it from `AGENTS.md`. Record incidents there too (what overloaded the machine and which rule now prevents it).
