# Host hygiene: rationale and lessons

Each rule in `SKILL.md` comes from an incident on a machine shared by several agent sessions.

## Contract

The scripts interoperate with any other tool that uses the same paths, so these never change:

| What | Path (macOS/Linux) | Content |
|---|---|---|
| Heavy slot `n` (1..`HOST_HEAVY_SLOTS`) | `$HOST_LOCK_DIR/heavy.lock.<n>/` made with `mkdir` | `pid` (holder pid), `cmd` (owner and command, informational) |
| Waiter | `$HOST_LOCK_DIR/heavy.wait.<pid>` | owner and command |
| Device lease | `$HOST_LOCK_DIR/<class>.lease` made with noclobber | `<owner> <pid> [device]` |
| Service entry | `$HOST_LOCK_DIR/host-services/<wrapper pid>` | `owner=`, `name=`, `pid=` (service), `started=`, `cmd=` lines |

| Env | Default | Meaning |
|---|---|---|
| `HOST_LOCK_DIR` | `/tmp` (Windows: `%ProgramData%\host-locks`) | Machine-wide lock dir |
| `HOST_HEAVY_SLOTS` | 2 | Concurrent heavy jobs |
| `HOST_LOAD_CAP` | 30 | One-minute load to wait under (same as the guard plugin's cap) |
| `HOST_CPU_CAP` | 75 | Windows only: CPU percent to wait under |
| `HOST_DISK_FLOOR_GB` | 20 | Free space below which a run is refused |
| `HOST_LOCK_TIMEOUT_SECONDS` | 1800 | Give up waiting (exit 124) |
| `HOST_POLL_SECONDS` | 30 | Load poll interval |
| `HOST_OWNER` | `user@<cwd name>` | Owner recorded in leases and entries |
| `HOST_DEVICE_RUNNING_CMD`, `HOST_DEVICE_SHUTDOWN_CMD` | none | Device commands for `lease --device`, `{device}` replaced by the id |

Exit codes: the command's own, 1 on low disk, 2 on usage, 124 on timeout.

Device command examples (set them in the repo's runbook or env, not in the scripts):

| Device | Running | Shutdown |
|---|---|---|
| iOS simulator | `xcrun simctl list devices booted \| grep -q {device}` | `xcrun simctl shutdown {device}` |
| Android emulator | `adb -s {device} get-state` | `adb -s {device} emu kill` |

## Locks

- **One machine-wide, reboot-ephemeral lock dir.** `/tmp` is shared by every session and cleared on reboot, so a recorded pid cannot outlive its boot. A per-user `$TMPDIR` is not: on macOS it differs between sandboxed and plain sessions, which silently split one semaphore into several.
- **Never rename a lock path once in use.** Tools on the old path and tools on the new one each see a free semaphore: two limits, each half-enforced.
- **Disk fails fast, load waits.** Free space does not come back on its own; load falls as jobs finish. Waits poll, print one status line, and time out.
- **Lock order: slot, then lease.** Agents taking the lease first and then waiting for a slot, while slot holders waited for the lease, deadlocked several sessions.
- **Stale reclaim is atomic.** Check-then-`rm` races: between reading a dead pid and deleting, another session may have reclaimed and re-taken the lock, and the `rm` frees a live holder. Instead `mv` the lock aside, re-read the pid from the moved copy, and delete only if it is still the dead one. Otherwise put it back, but only if nothing took its place: `mv` into an existing directory nests, and `mv` over an existing file replaces it.
- **Release only what you hold.** A waiter that timed out ran its exit cleanup and deleted the holder's lease; a second run then started a full suite on the same device mid-run. Every release compares the recorded pid to its own.
- **Windows:** slots are named mutexes (`Global\host-heavy<lock dir>-<n>`), which the OS hands to the next waiter when the holder dies; holder info is in `heavy.slot.<n>`. Leases and service entries use the same files as above. `%ProgramData%` survives reboots, so a lease counts as alive only if its pid started before the lease file was written. `sweep-stale.ps1` has no `lsof`: it tells a busy worktree by renaming it and back, which Windows refuses while any process has a file or its cwd inside. Killing a wrapper hard (`Stop-Process`) skips its cleanup and leaves an orphan service entry.

## Devices

- Only the lease holder owns the device. `lease --device` remembers whether the device was running at acquire time and shuts it down on exit only if this run booted it.
- A booted simulator or emulator with no lease is stale: a session that crashed left it. Anyone may shut it down.

## Services

- A database left running for days after its session ended looked like any other running database: nobody knew whether it was claimed. The registry records owner, purpose and start time; an entry whose wrapper pid is dead is an orphan, and a service with no entry is unclaimed.
- Stop services by pid or by the registry entry, never by pattern: `pgrep -f`/`pkill -f` match identical commands in other sessions.

## Worktrees

- Remove a stale worktree only when every signal agrees: no file modified in 24 h, no process with an open file or cwd inside, no uncommitted changes. Never the main checkout or your own.
- `find -mmin -1440` is portable; `find -newermt` parses dates differently on BSD and GNU.
- `lsof` exits 1 both for "nothing found" and on harmless warnings: judge by the output past the header line, not the exit status.
- Never install dependencies into another task's worktree. When a fresh worktree has the same lockfile as an existing one, symlinking its dependency dir is faster and costs no disk.

## Agents

- After a quota reset, stagger resumes: waking every agent at once spikes load past the cap.
- Every agent's final report ends with a cleanup line (started, stopped, left running and why), so the orchestrator can tell what is still on the machine.
