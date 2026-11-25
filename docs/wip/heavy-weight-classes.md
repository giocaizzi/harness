# Plan: weight classes for heavy.sh and heavy.ps1

Status: implemented in this PR; open questions pending. Owner skill: `dev-tools` `host-hygiene`.

## Problem

`heavy.sh` and `heavy.ps1` treat every command the same: two machine-wide slots and one load cap. Measured by a consumer over 7 days (4110 foreground calls): 18 % of calls waited for a slot or for load, 18 wall-hours in total. Cheap commands queued behind expensive ones: a `go vet` took a median 31 s when it waited against 3 s when it did not, a single-package `go test` 40 s against 5 s. The host (one 16 GB laptop, many agents) is really overloaded, but by the genuinely heavy jobs (full `-race` suites, whole-module lint, envtest, image builds). Killed runs also left envtest's `kube-apiserver` and `etcd` running.

## Design

### Weight classes and admission

| Class | Admission | Examples (built-in table) |
|---|---|---|
| `light` | No slot, no queue. Refused below the disk floor; waits only while load is over the critical cap. | `go build`/`go vet`/`go test` of named packages without `-race`, `gofmt`, `shellcheck`, `actionlint`, `hadolint`, `git` (not `gc`/`repack`/`fsck`), `gh` |
| `medium` | Its own pool of `HOST_MEDIUM_SLOTS` (4) slots and its own FIFO queue; waits while load is over the critical cap. | whole-module `go build ./...`/`go vet ./...`, `go test` of a subtree (`./pkg/...`) or with `-race` on named packages |
| `heavy` | Unchanged: `HOST_HEAVY_SLOTS` (2) slots, FIFO queue, waits while load is over `HOST_LOAD_CAP`. | everything else: `go test ./...`, any `-race` over `./...`, linters over the module, envtest, image builds, emulators, unknown commands |

The critical cap is `HOST_CRITICAL_LOAD_CAP` (default twice `HOST_LOAD_CAP`, so 60) on macOS/Linux and `HOST_CRITICAL_CPU_CAP` (default 95 %) on Windows. Heavy keeps `HOST_LOAD_CAP`/`HOST_CPU_CAP`. Medium and light stop only on critical load because the measured waits were mostly load waits (a load wait costs at least one 30 s poll), and the slot pool already bounds medium.

### Classification

- The command line is the argv joined by single spaces. Sources, first match wins: the repo's `.heavy-weights` (at `git rev-parse --show-toplevel` of the working directory), then the built-in `scripts/weights.default`. No match: `heavy`.
- File format, shared by both scripts: one rule per line, `<class> <glob>`; blank lines and `#` comments ignored; the glob is the rest of the line, trailing space trimmed, matched against the whole command line with `*` and `?` (bash `case`, PowerShell `-clike`; brackets and backslashes are not portable, so the built-in table avoids them). An unknown class warns once (`host: ignoring <file>:<line>: unknown class '<x>'`) and is skipped.
- A consumer repo declares its classes in `.heavy-weights` (reviewed in PRs like any code) and its `AGENTS.md` says in one line that the file exists. It may also raise a class: `heavy go test*./internal/controller*` for a package whose tests start envtest, which the built-in table would call light.
- `heavy.sh --classify [--] <cmd...>` prints `<class> <source>` (`repo:<line>`, `builtin:<line>` or `default`) and runs nothing.
- No flag or env sets the class per call: an agent cannot talk its own command down, and an unclassified command stays heavy. The guard plugin does not auto-route commands (open question).

### Wait messages

One line per state change on stderr, `host:` prefix kept:

- `host: waiting for load 34.2 to drop under 30 (HOST_LOAD_CAP)` for heavy, `... under 60 (HOST_CRITICAL_LOAD_CAP, medium)` for light and medium (Windows: cpu and `%`).
- `host: waiting for a heavy slot: position 3 in queue, 2/2 slots busy (alice@app go test ./... 120s; bob@app make lint 30s)`, printed again whenever the position changes. Each command is cut at 60 characters.

### Metrics

- When a call waited at least one second, stderr gets `host: waited 31s (load) for a medium slot` (or `slot`, `load+slot`; light: `for load`).
- With `HOST_METRICS_FILE` set, every call (including a timeout, exit 124) appends one logfmt line: `ts=<UTC RFC 3339> weight=<class> source=<source> waited_s=<n> wait=<none|load|slot|load+slot> ran_s=<n> exit=<code> owner=<HOST_OWNER> cmd="<first two words>"`. Only the first two words of the command are logged, never its arguments, which may carry secrets. Unset: no file (open question: default on).

### Orphan cleanup

- envtest starts `kube-apiserver` and `etcd` in their own process groups (controller-runtime sets `Setpgid`), so a process-group kill does not reach them; once the test binary dies they are reparented to init and the tree kill no longer sees them either.
- bash: the watchdog records the command's descendants (`pid` and `lstart` from one `ps -A` every 2 s) in `$HOST_LOCK_DIR/heavy.tree.<pid>`. When the command fails (non-zero exit, a forwarded signal, a timeout inside it), heavy.sh sends TERM to each recorded process still alive with the same start time, KILL after 2 s, and says `host: stopped <n> processes the command left behind`. When heavy.sh itself is killed, the watchdog does the same. A successful command keeps what it left (a build daemon). Without a usable `ps` nothing is recorded or stopped.
- Windows: heavy.ps1 puts itself in a Job Object with `KILL_ON_JOB_CLOSE`; children inherit it. On success it clears the flag before exiting, so a failure, a Ctrl+C or a `Stop-Process` of heavy.ps1 ends every process the command started. If the job cannot be set up, it warns once and runs without it.

### Contract additions (existing paths unchanged)

| What | macOS/Linux | Windows |
|---|---|---|
| Medium slot `n` | `$HOST_LOCK_DIR/medium.lock.<n>/` (`pid`, `cmd`, `cap`) | mutex `Global\host-medium<lock dir>-<n>`, info `medium.slot.<n>` |
| Medium waiter | `$HOST_LOCK_DIR/medium.wait.<pid>` | same |
| Descendant record | `$HOST_LOCK_DIR/heavy.tree.<pid>` | none (Job Object) |

`lease.sh`/`lease.ps1` always take a heavy slot. `--status` adds medium slots and waiters and prints both caps.

## Work units

1. Groundwork (driver): this plan and `scripts/weights.default`.
2. bash (worker): `lib.sh`, `heavy.sh`, `tests/host-hygiene.test.sh`.
3. PowerShell (worker): `lib.ps1`, `heavy.ps1`, `tests/host-hygiene.test.ps1`.
4. Docs (driver, after 2 and 3): `SKILL.md`, `references/lessons.md`, `docs/usage.md`, dev-tools version bump.

## Open questions

1. Metrics file on by default (for example `${XDG_STATE_HOME:-~/.local/state}/host-hygiene/heavy.log`), or opt-in through `HOST_METRICS_FILE` as built?
2. Should the guard's host rule rewrite a bare heavy command to run through `heavy.sh` (Claude Code can update a tool's input; other harnesses cannot), or keep denying once with a pointer as today?
3. A per-call override (`HOST_WEIGHT=light`) for ad-hoc use, or only the reviewed `.heavy-weights` file as built?
4. Reap on success too, or only on failure as built?
