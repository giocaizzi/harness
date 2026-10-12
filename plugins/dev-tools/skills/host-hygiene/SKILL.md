---
name: host-hygiene
description: Keeping a shared dev machine healthy when several agents run at once - disk floor, load cap, heavy-command semaphore, device leases, service cleanup, plan-quota awareness. Use before builds, emulators or simulators, full test suites or parallel agents, or when the host is slow.
---

# Host hygiene

Agents share one machine. Let the machine's load and your plan's quota set how much runs at once, not a fixed count. Run heavy commands through this skill's `scripts/heavy.sh <command...>` (`scripts/heavy.ps1` on Windows), resolved from this skill's directory, unless the repo ships its own heavy wrapper: then use that one, since a second semaphore creates a second, parallel limit that defeats the first. Knobs: `HEAVY_SLOTS` (1), `HEAVY_LOAD_MAX` (0.75 x CPUs, at most 30; Windows `HEAVY_CPU_MAX`, 75%), `HEAVY_DISK_MIN_GB` (20); `--status` shows holders and waiters.

## Rules

- **Disk first.** Before a build, install, emulator boot or test run, check free space (`df -h /`). Below roughly 20 GB, don't start: clean your own leftovers first. Never delete another session's files.
- **Heavy work goes through one shared semaphore** (builds, precommit, full suites, device runs). It also waits for the one-minute load to fall under a cap instead of failing. Wait; don't wrap it in your own retry loop.
- **One agent, one heavy job at a time.**
- **Devices are leased.** One iOS and one Android device machine-wide. Take the heavy slot before the lease, since the reverse order deadlocks. Only the holder releases. Boot a simulator or emulator only inside a lease and shut down what you started; a booted device with no lease is stale.
- **Stop things precisely.** Wait on a PID or a file. Never `pgrep -f` or `pkill` a pattern: other sessions run identical scripts and you will match theirs.
- **Register long-running services** (databases, dev servers, watchers) so they are torn down on exit. Don't leave orphans.
- **Worktrees:** one per task, removed when its PR merges. In heavy repos each one duplicates dependencies and file watchers.
- **Quota.** Before fanning out agents, check plan usage with the harness CLI (Claude Code: `cd /tmp && claude -p "/usage"`; Copilot CLI: `/usage`) and back off near the limit. After a quota reset, stagger resumes: waking every agent at once spikes load.

## When the repo has no host tooling

Write the limits above as a runbook in `docs/` that points to this skill's script, and link it from `AGENTS.md`. Record incidents there too (what overloaded the machine and which rule now prevents it), so the rule outlives the memory of the outage.
