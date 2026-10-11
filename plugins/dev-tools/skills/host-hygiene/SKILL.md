---
name: host-hygiene
description: Keeping a shared dev machine healthy when several agents run at once - disk floor, load cap, heavy-command semaphore, device leases, service cleanup, plan-quota awareness. Use before builds, emulators or simulators, full test suites or parallel agents, or when the host is slow.
---

# Host hygiene

Agents share one machine. Let the machine's load and your plan's quota set how much runs at once, not a fixed count. If the repo ships host tooling (for example `scripts/host/heavy.sh`), use it: it is the single implementation, and an improvised second semaphore creates a second, parallel limit that defeats the first.

## Rules

- **Disk first.** Before a build, install, emulator boot or test run, check free space (`df -h /`). Below roughly 20 GB, don't start: clean your own leftovers first. Never delete another session's files.
- **Heavy work goes through one shared semaphore** (builds, precommit, full suites, device runs). It should also wait for the one-minute load to fall under a cap (around 30) instead of failing. Wait; don't wrap it in your own retry loop.
- **One agent, one heavy job at a time.**
- **Devices are leased.** One iOS and one Android device machine-wide. Take the heavy slot before the lease, since the reverse order deadlocks. Only the holder releases. Boot a simulator or emulator only inside a lease and shut down what you started; a booted device with no lease is stale.
- **Stop things precisely.** Wait on a PID or a file. Never `pgrep -f` or `pkill` a pattern: other sessions run identical scripts and you will match theirs.
- **Register long-running services** (databases, dev servers, watchers) so they are torn down on exit. Don't leave orphans.
- **Worktrees:** one per task, removed when its PR merges. In heavy repos each one duplicates dependencies and file watchers.
- **Quota.** Before fanning out agents, check plan usage with the harness CLI (Claude Code: `cd /tmp && claude -p "/usage"`; Copilot CLI: `/usage`) and back off near the limit. After a quota reset, stagger resumes: waking every agent at once spikes load.

## When the repo has no host tooling

Write the limits above as a runbook in `docs/` and a small wrapper script, and link it from `AGENTS.md`. Record incidents there too (what overloaded the machine and which rule now prevents it), so the rule outlives the memory of the outage.
