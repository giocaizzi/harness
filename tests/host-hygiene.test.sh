#!/usr/bin/env bash
# Tests for plugins/dev-tools/skills/host-hygiene/scripts/*.sh (run by `make test`).
set -u
# The .sh scripts are for macOS/Linux (lsof, flock-style locks); Windows runs the .ps1 ones (tests/host-hygiene.test.ps1).
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) echo "Windows: host-hygiene .sh tests skipped, tests/host-hygiene.test.ps1 covers it"; exit 0 ;; esac
scripts="$(cd "$(dirname "$0")/.." && pwd)/plugins/dev-tools/skills/host-hygiene/scripts"
heavy=$scripts/heavy.sh lease=$scripts/lease.sh reg=$scripts/register-service.sh sweep=$scripts/sweep-stale.sh
tmp=$(cd "$(mktemp -d)" && pwd -P); trap 'rm -rf "$tmp"' EXIT
export HOST_LOCK_DIR="$tmp/locks" HOST_LOAD_CAP=100000 HOST_DISK_FLOOR_GB=0 HOST_HEAVY_SLOTS=1
L=$HOST_LOCK_DIR
fails=0
count() { local n=0 f; for f in "$@"; do [ -e "$f" ] && n=$((n + 1)); done; echo "$n"; }
check() { if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "not ok - $1: got '$2', want '$3'"; fails=$((fails + 1)); fi; }
dead_pid() { sh -c 'exit 0' & local p=$!; wait "$p"; echo "$p"; }
# kill_tree <pid>...: TERM each pid and its children, so no orphan keeps the suite's stdout open after it ends.
# shellcheck disable=SC2046 # one pid per word
kill_tree() { local p; for p in "$@"; do kill $(ps -A -o pid=,ppid= | awk -v p="$p" '$2 == p { print $1 }') "$p" 2>/dev/null; done; }

# heavy.sh
"$heavy" sh -c "echo start >>'$tmp/log'; sleep 1; echo end >>'$tmp/log'" 2>/dev/null &
sleep 0.3
"$heavy" sh -c "echo start >>'$tmp/log'; echo end >>'$tmp/log'" 2>/dev/null
wait
check "one slot: concurrent runs serialize" "$(tr '\n' ' ' <"$tmp/log")" "start end start end "

rm -f "$tmp/log"
HOST_HEAVY_SLOTS=2 "$heavy" sh -c "echo start >>'$tmp/log'; sleep 1; echo end >>'$tmp/log'" 2>/dev/null &
sleep 0.3
HOST_HEAVY_SLOTS=2 "$heavy" sh -c "echo start >>'$tmp/log'; echo end >>'$tmp/log'" 2>/dev/null
wait
check "two slots: runs overlap" "$(tr '\n' ' ' <"$tmp/log")" "start start end end "

"$heavy" sh -c 'exit 7'
check "exit code propagates" "$?" 7
# A clean run prints nothing on stderr: bash 3.2 warned "run_pending_traps: bad value in trap_list" when the
# watchdog subshell was stopped with TERM while its inherited trap was half reset.
for _ in $(seq 20); do "$heavy" true; done 2>"$tmp/err"
check "a clean run leaves stderr empty" "$(cat "$tmp/err")" ""
# Command substitution returns with the command: the watchdog must not hold the caller's pipe on stdout or
# on another inherited fd (a make jobserver, `3>&1`).
start=$(date +%s)
for _ in 1 2 3; do out=$("$heavy" sleep 0.3 3>&1); done
check "\$(heavy.sh ...) returns when the command ends" "$(($(date +%s) - start <= 2))$out" 1
check "stdin reaches the command" "$(echo hi | "$heavy" cat)" hi
"$heavy" sh -c 'echo fd3 >&3' 3>"$tmp/fd3"
check "an inherited fd 3 reaches the command" "$(cat "$tmp/fd3")" fd3

mkdir -p "$L/heavy.lock.1"; dead_pid >"$L/heavy.lock.1/pid"
"$heavy" true 2>"$tmp/err"
check "stale slot recovered" "$?:$(grep -c 'recovered stale heavy.lock.1 (pid [0-9]* is gone)$' "$tmp/err")" 0:1
check "slot released" "$(count "$L"/heavy.lock.*)" 0

HOST_DISK_FLOOR_GB=999999999 "$heavy" touch "$tmp/ran" 2>/dev/null
check "low disk refuses" "$?:$([ -e "$tmp/ran" ] && echo ran)" "1:"

HOST_LOAD_CAP=-1 HOST_LOCK_TIMEOUT_SECONDS=1 HOST_POLL_SECONDS=1 "$heavy" touch "$tmp/ran" 2>"$tmp/err"
check "load cap waits, then times out" "$?:$([ -e "$tmp/ran" ] && echo ran)" "124:"
check "one status line per wait" "$(grep -c '^host: waiting for load' "$tmp/err")" 1
# A slow start can pass the deadline before the first check: the wait still says what it waited for.
HOST_LOAD_CAP=-1 HOST_LOCK_TIMEOUT_SECONDS=0 "$heavy" true 2>"$tmp/err"
check "a wait past its deadline still reports itself" "$?:$(grep -c '^host: waiting for load' "$tmp/err")" 124:1

"$heavy" sleep 2 & sleep 0.3
check "--status shows the holder and its cap" "$("$heavy" --status | grep -c 'slot 1: pid .* sleep 2 (load cap 100000, 1 slots, [0-9]*s)')" 1
wait

# Release own only: a waiter that gives up leaves the holder's slot alone.
sleep 5 & holder=$!
mkdir -p "$L/heavy.lock.1"; echo "$holder" >"$L/heavy.lock.1/pid"
HOST_LOCK_TIMEOUT_SECONDS=1 "$heavy" true 2>/dev/null
check "timed-out waiter exits 124" "$?" 124
check "timed-out waiter keeps the holder's slot" "$(cat "$L/heavy.lock.1/pid")" "$holder"

# Atomic reclaim: a lock that changed hands between the read and the mv is put back, never nested.
before=$fails
(
  # shellcheck source=../plugins/dev-tools/skills/host-hygiene/scripts/lib.sh
  . "$scripts/lib.sh"
  d=$L/heavy.lock.1
  host_reclaim "$d" "$(dead_pid)" host_slot_pid 2>/dev/null
  check "reclaim restores a live holder's lock" "$?:$(cat "$d/pid"):$(count "$L"/*.stale.*)" "1:$holder:0"
  # shellcheck disable=SC2317,SC2329 # called by host_reclaim
  racy() { mkdir -p "$d"; echo new >"$d/pid"; host_slot_pid "$1"; }
  host_reclaim "$d" "$(dead_pid)" racy 2>/dev/null
  check "reclaim never nests into a re-created lock" "$(cat "$d/pid"):$([ -e "$d/heavy.lock.1.stale.$$" ] && echo nested)" "new:"
  exit $((fails - before)) # only this subshell's failures: the parent adds them
); fails=$((fails + $?))
rm -rf "$L"/heavy.lock.*; { kill "$holder"; wait "$holder"; } 2>/dev/null

# Load first, slot second: a waiter holds no slot while load is over the cap, takes one within a poll
# once it drops, and gives it back if load rose again by the time it got it. Load is simulated:
# fake_load pops the next value from $tmp/load (the last one repeats) and traces the slots held.
# shellcheck disable=SC2329 # called by host_slot_acquire
fake_load() {
  if [ "$(wc -l <"$tmp/load")" -gt 1 ]; then
    head -n 1 "$tmp/load"; tail -n +2 "$tmp/load" >"$tmp/load.n"; mv "$tmp/load.n" "$tmp/load"
  else cat "$tmp/load"; fi
  printf '%s ' "$(count "$L"/heavy.lock.*)" >>"$tmp/trace"
}
# acquire [VAR=value...]: host_slot_acquire in a subshell with that env; FAKE_LOAD=1 loads from fake_load.
acquire() {
  (
    export "${@?}"
    # shellcheck source=../plugins/dev-tools/skills/host-hygiene/scripts/lib.sh
    . "$scripts/lib.sh"
    # shellcheck disable=SC2329 # called by host_slot_acquire
    [ -n "${FAKE_LOAD:-}" ] && host_load1() { fake_load; }
    trap host_slot_release EXIT
    host_slot_acquire job
  ) 2>/dev/null
}
echo 99 >"$tmp/load"
acquire FAKE_LOAD=1 HOST_LOAD_CAP=10 HOST_POLL_SECONDS=1 HOST_LOCK_TIMEOUT_SECONDS=10 && date +%s >"$tmp/got" & w=$!
sleep 1.5
check "load over the cap: the waiter holds no slot" "$(count "$L"/heavy.lock.*)" 0
echo 1 >"$tmp/load"; dropped=$(date +%s)
wait "$w"
check "load drops: the waiter takes a slot within one poll" "$(($(cat "$tmp/got") - dropped <= 2))" 1
printf '1\n99\n99\n1\n' >"$tmp/load"; rm -f "$tmp/trace"
acquire FAKE_LOAD=1 HOST_LOAD_CAP=10 HOST_POLL_SECONDS=1 HOST_LOCK_TIMEOUT_SECONDS=10
check "load rose after the slot was taken: slot given back, then retaken" "$?:$(cat "$tmp/trace")" "0:0 1 0 0 1 "

# FIFO: a free slot goes to the oldest live waiter whose load cap is met; a dead waiter's entry, or one
# held back by its own lower cap, does not block.
sleep 5 & older=$!
sleep 5 & lower=$!
echo "100000 other" >"$L/heavy.wait.$older"
echo "-1 low-cap" >"$L/heavy.wait.$lower"
sleep 1.1 # wait-file mtimes are whole seconds on some systems
acquire HOST_POLL_SECONDS=1 HOST_LOCK_TIMEOUT_SECONDS=1
check "a newer waiter leaves a free slot to an older one" "$?" 124
check "--status shows waiters and their cap" "$("$heavy" --status | grep -c -e "^waiting: pid $older other (load cap 100000, [0-9]*s)" -e "^waiting: pid $lower low-cap (load cap -1, [0-9]*s)")" 2
{ kill "$older"; wait "$older"; } 2>/dev/null
HOST_LOCK_TIMEOUT_SECONDS=3 "$heavy" true 2>/dev/null
check "a dead or lower-cap waiter's entry does not block the queue" "$?" 0
# The stopped waiter is xargs's child: a bash parent without job control resumes a child that stops.
echo 5 | xargs sleep 2>/dev/null & parent=$!
for _ in $(seq 20); do stopped=$(ps -A -o pid=,ppid= | awk -v p="$parent" '$2 == p { print $1 }'); [ -n "$stopped" ] && break; sleep 0.1; done
kill -STOP "$stopped"; echo "100000 stopped" >"$L/heavy.wait.$stopped"
sleep 1.1
acquire HOST_POLL_SECONDS=1 HOST_LOCK_TIMEOUT_SECONDS=1
check "a stopped waiter does not block the queue" "$?" 0
{ kill -CONT "$stopped"; kill "$stopped"; wait "$parent"; } 2>/dev/null
{ kill "$lower"; wait "$lower"; } 2>/dev/null
rm -f "$L"/heavy.wait.*

# Liveness: a holder whose pid now belongs to a process started after the lock is gone; a live
# process of another user (kill -0 says EPERM) is alive.
sleep 5 & reused=$!
mkdir -p "$L/heavy.lock.1"; echo "$reused" >"$L/heavy.lock.1/pid"; touch -t 202001010000 "$L/heavy.lock.1"
check "--status flags a reused pid" "$("$heavy" --status | grep -c 'slot 1: .*pid reused')" 1
HOST_LOCK_TIMEOUT_SECONDS=3 "$heavy" true 2>/dev/null
check "a reused pid's slot is reclaimed" "$?:$(count "$L"/heavy.lock.*)" "0:0"
{ kill "$reused"; wait "$reused"; } 2>/dev/null
if [ "$(id -u)" != 0 ]; then
  mkdir -p "$L/heavy.lock.1"; echo 1 >"$L/heavy.lock.1/pid"
  HOST_LOCK_TIMEOUT_SECONDS=1 "$heavy" true 2>/dev/null
  check "another user's live holder keeps its slot" "$?:$(cat "$L/heavy.lock.1/pid")" "124:1"
  rm -rf "$L/heavy.lock.1"
fi
mkdir -p "$L/heavy.lock.1"; dead_pid >"$L/heavy.lock.1/pid"; echo "me make" >"$L/heavy.lock.1/cmd"
check "--status flags a dead holder" "$("$heavy" --status | grep -c 'slot 1: pid [0-9]* me make (cap unknown, [0-9]*s, holder dead)')" 1
rm -rf "$L/heavy.lock.1"

# Pid-less locks: a holder killed between mkdir and writing its pid. Reclaimed after 60 s, never sooner.
mkdir -p "$L/heavy.lock.1"
HOST_LOCK_TIMEOUT_SECONDS=1 "$heavy" true 2>/dev/null
check "a fresh pid-less lock is left alone" "$?:$(count "$L"/heavy.lock.*)" "124:1"
check "--status flags a pid-less lock" "$("$heavy" --status | grep -c 'slot 1: pid none .*no pid)')" 1
touch -t 202001010000 "$L/heavy.lock.1"
HOST_LOCK_TIMEOUT_SECONDS=3 "$heavy" true 2>/dev/null
check "an old pid-less lock is reclaimed" "$?:$(count "$L"/heavy.lock.*)" "0:0"

# Signals: TERM is handled at once, while waiting and while running, so the KILL after it finds
# nothing to leak: the slot is released and the whole command is stopped.
rm -rf "$L"/heavy.lock.*
HOST_LOAD_CAP=-1 HOST_POLL_SECONDS=30 "$heavy" true 2>/dev/null & w=$!
sleep 0.5; kill -TERM "$w"
for _ in $(seq 10); do kill -0 "$w" 2>/dev/null || break; sleep 0.1; done
check "TERM stops a waiter during its sleep" "$(kill -0 "$w" 2>/dev/null && echo waiting)" ""
{ kill -KILL "$w"; wait "$w"; } 2>/dev/null
check "no queue entry left" "$(count "$L"/heavy.wait.*)" 0
"$heavy" sh -c "sleep 30 & echo \$! >'$tmp/grandchild'; wait" 2>/dev/null & w=$!
for _ in $(seq 50); do [ -s "$tmp/grandchild" ] && break; sleep 0.1; done
kill -TERM "$w"; sleep 0.5; kill -KILL "$w" 2>/dev/null; wait "$w" 2>/dev/null
sleep 0.2
check "TERM then KILL: command stopped, slot released" \
  "$(ps -o stat= -p "$(cat "$tmp/grandchild")" | grep -v Z | sed 's/.*/orphan/')$(count "$L"/heavy.lock.*)" 0
kill "$(cat "$tmp/grandchild")" 2>/dev/null; rm -rf "$L"/heavy.lock.* "$tmp/grandchild"
"$lease" sim -- sh -c "sleep 30 & echo \$! >'$tmp/grandchild'; wait" 2>/dev/null & w=$!
for _ in $(seq 50); do [ -s "$tmp/grandchild" ] && break; sleep 0.1; done
kill -TERM "$w"; sleep 0.5; kill -KILL "$w" 2>/dev/null; wait "$w" 2>/dev/null
sleep 0.2
check "lease.sh: TERM then KILL stops the command, releases lease and slot" \
  "$(ps -o stat= -p "$(cat "$tmp/grandchild")" | grep -v Z | sed 's/.*/orphan/')$(count "$L"/heavy.lock.* "$L"/*.lease)" 0
kill "$(cat "$tmp/grandchild")" 2>/dev/null; rm -rf "$L"/heavy.lock.* "$L"/*.lease

# Ctrl+C, a closed terminal, QUIT: the signal to the process group stops the command and the script exits
# 128+n, slot (and lease) released. Started with set -m so the script under test gets them at their defaults,
# as from a terminal.
signal_group() { # signal_group <sig> <script> <args...>: rc of the script after <sig> to its group; the command's state
  local sig=$1; shift
  rm -f "$tmp/cmd"
  set -m; "$@" sh -c "echo \$\$ >'$tmp/cmd'; exec sleep 30" 2>/dev/null & w=$!; set +m
  for _ in $(seq 50); do [ -s "$tmp/cmd" ] && break; sleep 0.1; done
  kill -"$sig" -- "-$w"
  for _ in $(seq 30); do kill -0 "$w" 2>/dev/null || break; sleep 0.1; done
  kill -KILL "$w" 2>/dev/null; wait "$w" 2>/dev/null; echo "$?$(ps -o stat= -p "$(cat "$tmp/cmd")" | grep -v Z | sed 's/.*/ running/')"
  kill "$(cat "$tmp/cmd")" 2>/dev/null
}
for s in HUP:129 INT:130 QUIT:131; do
  check "heavy.sh: ${s%:*} stops the command, exits ${s#*:}, frees the slot" "$(signal_group "${s%:*}" "$heavy"):$(count "$L"/heavy.lock.*)" "${s#*:}:0"
  check "lease.sh: ${s%:*} stops the command, exits ${s#*:}, frees lease and slot" "$(signal_group "${s%:*}" "$lease" sim --):$(count "$L"/heavy.lock.* "$L"/*.lease)" "${s#*:}:0"
  rm -rf "$L"/heavy.lock.* "$L"/*.lease
done

# The watchdog stops only the command it started: once the pid names another process (reused after the
# command ended), it leaves that process alone. host_ident is faked: the start time it recorded, then another.
sleep 5 & other=$!
printf 'started-1\nstarted-2\n' >"$tmp/ident"
(
  # shellcheck source=../plugins/dev-tools/skills/host-hygiene/scripts/lib.sh
  . "$scripts/lib.sh"
  # shellcheck disable=SC2317,SC2329 # called by host_watchdog
  host_ident() { head -n 1 "$tmp/ident"; tail -n +2 "$tmp/ident" >"$tmp/ident.n"; mv "$tmp/ident.n" "$tmp/ident"; }
  host_watchdog "$(dead_pid)" "$other"
)
check "the watchdog leaves a reused pid alone" "$(kill -0 "$other" 2>/dev/null && echo alive)" alive
{ kill "$other"; wait "$other"; } 2>/dev/null

# A KILL to heavy.sh's group cannot be forwarded: the watchdog stops the command once heavy.sh is gone.
killed_group() { # killed_group [<wrapper>...]: "running" if the command outlives a KILL to heavy.sh's group
  rm -f "$tmp/cmd"
  set -m; "$@" "$heavy" sh -c "echo \$\$ >'$tmp/cmd'; exec sleep 30" 2>/dev/null & w=$!; set +m
  for _ in $(seq 50); do [ -s "$tmp/cmd" ] && break; sleep 0.1; done
  sleep 1.2 # past the watchdog's first checks
  kill -KILL -- "-$w"; wait "$w" 2>/dev/null
  for _ in $(seq 50); do ps -o stat= -p "$(cat "$tmp/cmd")" | grep -qv Z || break; sleep 0.1; done
  ps -o stat= -p "$(cat "$tmp/cmd")" | grep -v Z | sed 's/.*/running/'
  kill "$(cat "$tmp/cmd")" 2>/dev/null; rm -rf "$L"/heavy.lock.*
}
check "KILL to heavy.sh's group: the watchdog stops the command" "$(killed_group)" ""
# A ps that fails once mid-run (fork EAGAIN under load) must not end the watchdog: it fails its second lstart.
# shellcheck disable=SC2317,SC2329 # called by heavy.sh through export -f
flaky_ps() {
  ps() {
    case "$*" in *lstart*) echo x >>"$PS_CALLS"; [ "$(wc -l <"$PS_CALLS")" -eq 2 ] && return 1 ;; esac
    command ps "$@"
  }
  export -f ps; PS_CALLS=$tmp/lstarts "$@"
}
rm -f "$tmp/lstarts"
check "a ps failing once does not end the watchdog" "$(killed_group flaky_ps)" ""

# host_ident through each source: the same process twice gives one answer, a process started later another;
# with neither source it is empty and the watchdog stops nothing.
sleep 5 & first=$!
sleep 1.1
sleep 5 & second=$!
before=$fails
(
  # shellcheck source=../plugins/dev-tools/skills/host-hygiene/scripts/lib.sh
  . "$scripts/lib.sh"
  ps_ok=$host_ps
  if [ -r /proc/self/stat ]; then
    a=$(host_ps='' host_ident "$first"); b=$(host_ps='' host_ident "$first"); c=$(host_ps='' host_ident "$second")
    check "host_ident via /proc: stable for a process, new for a later one" "$([ -n "$a" ] && [ "$a" = "$b" ] && [ "$a" != "$c" ] && echo ok)" ok
  fi
  if [ -n "$ps_ok" ]; then
    a=$(host_proc=/nonexistent host_ident "$first"); b=$(host_proc=/nonexistent host_ident "$first"); c=$(host_proc=/nonexistent host_ident "$second")
    check "host_ident via ps lstart: stable for a process, new for a later one" "$([ -n "$a" ] && [ "$a" = "$b" ] && [ "$a" != "$c" ] && echo ok)" ok
  fi
  host_proc=/nonexistent host_ps=''
  check "host_ident without ps or /proc: empty" "$(host_ident "$first")" ""
  host_watchdog "$(dead_pid)" "$first"
  check "without ps or /proc the watchdog stops nothing" "$(kill -0 "$first" 2>/dev/null && echo alive)" alive
  exit $((fails - before))
); fails=$((fails + $?))
{ kill "$first" "$second"; wait "$first" "$second"; } 2>/dev/null

# Without a ps that takes -p (slim images, BusyBox), liveness falls back to kill -0: a live holder keeps its slot.
sleep 5 & holder=$!
mkdir -p "$L/heavy.lock.1"; echo "$holder" >"$L/heavy.lock.1/pid"
# shellcheck disable=SC2317,SC2329 # called by heavy.sh through export -f
no_ps() { ps() { return 127; }; export -f ps; "$@"; }
(no_ps env HOST_LOCK_TIMEOUT_SECONDS=1 "$heavy" true 2>/dev/null)
check "no usable ps: a live holder keeps its slot" "$?:$(cat "$L/heavy.lock.1/pid")" "124:$holder"
{ kill "$holder"; wait "$holder"; } 2>/dev/null
(no_ps env HOST_LOCK_TIMEOUT_SECONDS=3 "$heavy" true 2>/dev/null)
check "no usable ps: a dead holder's slot is reclaimed" "$?" 0
rm -rf "$L"/heavy.lock.*

# lease.sh
"$lease" sim -- sh -c "cat '$L/heavy.lock.1/pid' '$L/sim.lease' >'$tmp/held'" 2>/dev/null
check "lease holds slot and lease while running" "$(wc -l <"$tmp/held" | tr -d ' ')" 2
check "lease releases both" "$(count "$L"/heavy.lock.* "$L"/*.lease)" 0

sleep 5 & holder=$!
mkdir -p "$L/heavy.lock.1"; echo "$holder" >"$L/heavy.lock.1/pid"
HOST_LOCK_TIMEOUT_SECONDS=1 "$lease" sim -- true 2>/dev/null
check "slot before lease: no lease taken while waiting for a slot" "$?:$([ -e "$L/sim.lease" ] && echo leased)" "124:"
rm -rf "$L/heavy.lock.1"
echo "other $holder" >"$L/sim.lease"
HOST_LOCK_TIMEOUT_SECONDS=1 "$lease" sim -- true 2>/dev/null
check "timed-out lease waiter keeps the holder's lease" "$?:$(cat "$L/sim.lease")" "124:other $holder"
echo "other $(dead_pid)" >"$L/sim.lease"
"$lease" sim -- true 2>/dev/null
check "stale lease recovered" "$?:$(count "$L"/*.lease "$L"/*.stale.*)" "0:0"
{ kill "$holder"; wait "$holder"; } 2>/dev/null

export HOST_DEVICE_SHUTDOWN_CMD="echo {device} >>'$tmp/shutdown'"
HOST_DEVICE_RUNNING_CMD=false "$lease" sim --device dev-1 -- true 2>/dev/null
HOST_DEVICE_RUNNING_CMD=true "$lease" sim --device dev-2 -- true 2>/dev/null
check "device booted under the lease is shut down, a running one is not" "$(cat "$tmp/shutdown")" dev-1
HOST_DEVICE_RUNNING_CMD='' "$lease" sim --device dev-3 -- true 2>/dev/null
check "--device without device commands is refused" "$?" 2

# register-service.sh
"$reg" db -- sleep 30 2>/dev/null & w=$!
for _ in $(seq 50); do grep -q 'name=db' "$L/host-services/$w" 2>/dev/null && break; sleep 0.1; done # a fixed wait raced registration on a loaded host
check "service registered while running" "$(grep -c 'name=db' "$L/host-services/$w")" 1
check "--list shows it" "$("$reg" --list | grep -c 'name=db')" 1
svc=$(sed -n 's/^pid=//p' "$L/host-services/$w")
kill "$w"; wait "$w" 2>/dev/null
sleep 0.2
check "TERM stops the service and removes the entry" "$(kill -0 "$svc" 2>/dev/null && echo alive)$([ -e "$L/host-services/$w" ] && echo kept)" ""
"$reg" job -- true
check "entry removed on normal exit" "$(count "$L"/host-services/*)" 0

# sweep-stale.sh: the git modes moved to repo-sweep.mjs
for args in "" "--apply" "--branches"; do
  # shellcheck disable=SC2086 # the empty case passes no argument
  out=$("$sweep" $args 2>&1 >/dev/null); code=$?
  check "sweep-stale.sh '$args' points to repo-sweep.mjs and exits 2" "$code $out" "2 sweep-stale: the git sweep moved to repo-sweep.mjs (node repo-sweep.mjs [--apply])"
done

# sweep-stale.sh --plugins
cfg=$tmp/claude c=$tmp/claude/plugins/cache/mkt
for v in p/1.0 p/1.1 p/0.9 p/0.8 q/2.0; do mkdir -p "$c/$v"; done
# p was last updated at 2026-01-01T00:00:00Z = 1767225600; q has no entry left.
printf '{"version":2,"plugins":{"p@mkt":[{"scope":"user","installPath":"%s","version":"1.1","installedAt":"2025-06-01T00:00:00.000Z","lastUpdated":"2026-01-01T00:00:00.000Z"}]}}' "$c/p/1.1" >"$tmp/claude/plugins/installed_plugins.json"
(cd "$c/p/0.9" && exec sleep 60) & pbusy=$!
sh -c 'sleep 60; :' "$c/p/0.8/hooks/run.mjs" & pargv=$!
sleep 0.3
psweep() { CLAUDE_CONFIG_DIR=$cfg "$sweep" --plugins "$@"; }
removable() { echo "$1" | grep '^would remove' | sed "s|$c/||" | sort | tr '\n' ' '; }
out=$(SWEEP_SESSION_STARTS='' psweep)
check "plugin sweep lists only versions neither installed nor in use" "$(removable "$out")" "would remove p/1.0 would remove q/2.0 "
check "plugin sweep keeps the installed, busy and running versions" \
  "$(echo "$out" | grep -c -e 'p/1.1: installed' -e 'p/0.9: in use' -e 'p/0.8: named by a running command')" 3
out=$(SWEEP_SESSION_STARTS=1767225500 psweep)
check "a session started before the update keeps the old versions" \
  "$(removable "$out")$(echo "$out" | grep -c -e 'p/1.0: 1 sessions started before the update' -e 'q/2.0: 1 sessions started before the update')" 2
out=$(SWEEP_SESSION_STARTS=1767225700 psweep)
check "a session started after the update keeps only a plugin with no entry" "$(removable "$out")" "would remove p/1.0 "
check "--after-reload drops the session keep" "$(removable "$(SWEEP_SESSION_STARTS=1767225500 psweep --after-reload)")" "would remove p/1.0 would remove q/2.0 "
SWEEP_SESSION_STARTS=1767225500 psweep --apply >/dev/null
check "--apply leaves what a session may still run" "$(cd "$c" && find . -mindepth 2 -maxdepth 2 | sort | tr '\n' ' ')" "./p/0.8 ./p/0.9 ./p/1.0 ./p/1.1 ./q/2.0 "
SWEEP_SESSION_STARTS='' psweep --apply >/dev/null
check "plugin --apply removes them and the emptied plugin dir" "$(cd "$c" && find . -mindepth 1 -maxdepth 2 | sort | tr '\n' ' ')" "./p ./p/0.8 ./p/0.9 ./p/1.1 "
echo '{' >"$tmp/claude/plugins/installed_plugins.json"
check "unreadable installed_plugins.json removes nothing" "$(SWEEP_SESSION_STARTS='' psweep --apply 2>/dev/null; echo "$?"; find "$c/p" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" "$(printf '1\n3')"
check "--plugins and --branches together is a usage error" "$("$sweep" --plugins --branches 2>/dev/null; echo $?)" 2
check "--after-reload without --plugins is a usage error" "$("$sweep" --after-reload 2>/dev/null; echo $?)" 2
# The real ps branch: sessions started by a `claude` binary (also under a path with a space), a versioned binary
# and an npm install all count.
cfg2=$tmp/claude2 c2=$tmp/claude2/plugins/cache/mkt
mkdir -p "$c2/r/1.0" "$c2/r/2.0" "$tmp/fake/bin" "$tmp/fake/claude/versions" "$tmp/fake/Application Support" "$tmp/precious"
echo keep >"$tmp/precious/file" && ln -s "$tmp/precious" "$c2/r/0.5"
printf '{"version":2,"plugins":{"r@mkt":[{"scope":"user","installPath":"%s","version":"2.0","lastUpdated":"2099-01-01T00:00:00.000Z"}]}}' "$c2/r/2.0" >"$tmp/claude2/plugins/installed_plugins.json"
# The fakes link bash, not sleep: a multicall coreutils (uutils, as on Ubuntu 26.04) refuses to run under
# another name. `; :` keeps bash from exec'ing sleep, so the fake's command line stays in ps.
ln -s "$(command -v bash)" "$tmp/fake/bin/claude" && ln -s "$(command -v bash)" "$tmp/fake/claude/versions/9.9.9"
ln -s "$(command -v bash)" "$tmp/fake/Application Support/claude"
"$tmp/fake/bin/claude" -c 'sleep 60; :' & s1=$!
"$tmp/fake/claude/versions/9.9.9" -c 'sleep 60; :' & s2=$!
sh -c 'sleep 60; :' "$tmp/fake/node_modules/@anthropic-ai/claude-code/cli.js" & s3=$!
"$tmp/fake/Application Support/claude" -c 'sleep 60; :' & s4=$!
sleep 0.3
sessions() { (unset SWEEP_SESSION_STARTS; CLAUDE_CONFIG_DIR=$cfg2 "$sweep" --plugins) | sed -n 's|.*r/1.0: \([0-9]*\) sessions started before the update.*|\1|p'; }
n1=$(sessions)
{ kill_tree "$s1" "$s2" "$s3" "$s4"; wait "$s1" "$s2" "$s3" "$s4"; } 2>/dev/null
n0=$(sessions)
# The host's own sessions count in both runs; the four fakes only in the first.
check "ps finds sessions by binary, path with a space, versioned path and npm install" "$(( ${n1:-0} - ${n0:-0} ))" 4
mkdir -p "$tmp/badps" && printf '#!/bin/sh\nexit 1\n' >"$tmp/badps/ps" && chmod +x "$tmp/badps/ps"
out=$(unset SWEEP_SESSION_STARTS; PATH="$tmp/badps:$PATH" CLAUDE_CONFIG_DIR=$cfg2 "$sweep" --plugins --apply 2>&1; echo "exit=$?")
check "a failing ps removes nothing" "$(echo "$out" | grep -c -e 'ps failed' -e '^exit=1$')$([ -d "$c2/r/1.0" ] && echo kept)" 2kept
mkdir -p "$tmp/outside/a/b" "$tmp/outside2/1.0" && ln -s "$tmp/outside" "$tmp/claude2/plugins/cache/linked" && ln -s "$tmp/outside2" "$c2/linkedp"
out=$(SWEEP_SESSION_STARTS='' CLAUDE_CONFIG_DIR=$cfg2 "$sweep" --plugins --after-reload --apply)
check "a linked marketplace or plugin dir is kept whole" \
  "$(echo "$out" | grep -c -e 'cache/linked: a link' -e 'mkt/linkedp: a link')$([ -d "$tmp/outside/a/b" ] && [ -d "$tmp/outside2/1.0" ] && echo kept)" 2kept
SWEEP_SESSION_STARTS='' CLAUDE_CONFIG_DIR=$cfg2 "$sweep" --plugins --after-reload --apply >/dev/null
check "a symlinked version loses its link, never its target" "$([ -L "$c2/r/0.5" ] && echo link)$(cat "$tmp/precious/file")" keep
# --marketplace sweeps one marketplace and leaves the others (third-party plugins) alone.
cfg3=$tmp/claude3 c3=$tmp/claude3/plugins/cache
mkdir -p "$c3/mine/a/1.0" "$c3/mine/a/2.0" "$c3/other/b/1.0"
printf '{"version":2,"plugins":{"a@mine":[{"scope":"user","installPath":"%s","version":"2.0","lastUpdated":"2026-01-01T00:00:00.000Z"}]}}' "$c3/mine/a/2.0" >"$cfg3/plugins/installed_plugins.json"
msweep() { SWEEP_SESSION_STARTS='' CLAUDE_CONFIG_DIR=$cfg3 "$sweep" --plugins "$@"; }
check "--marketplace lists only that marketplace's versions" "$(msweep --marketplace mine | grep '^would remove' | sed "s|$c3/||")" "would remove mine/a/1.0"
msweep --marketplace mine --apply >/dev/null
check "--marketplace --apply leaves a third-party version untouched" "$(cd "$c3" && find . -mindepth 3 -maxdepth 3 | sort | tr '\n' ' ')" "./mine/a/2.0 ./other/b/1.0 "
check "without --marketplace every marketplace is swept" "$(msweep | grep -c '/other/b/1.0$')" 1
check "an unknown marketplace removes nothing" "$(msweep --marketplace none --apply; echo "$?"; find "$c3" -mindepth 3 -maxdepth 3 | wc -l | tr -d ' ')" \
  "$(printf 'sweep: no marketplace none in %s\n0\n2' "$c3")"
# Matched against the cache listing, never resolved: on a case-insensitive filesystem cache/MINE opens mine, and
# its versions would then miss the installed check.
mkdir -p "$c3/mine/a/1.0"
check "a marketplace named in another case removes nothing" \
  "$(msweep --marketplace MINE --after-reload --apply; echo "$?"; cd "$c3" && find . -mindepth 3 -maxdepth 3 | sort | tr '\n' ' ')" \
  "$(printf 'sweep: no marketplace MINE in %s\n0\n./mine/a/1.0 ./mine/a/2.0 ./other/b/1.0 ' "$c3")"
# $(basename) would drop the newline and take cache/solo<LF> for solo.
mkdir -p "$c3/solo
/a/1.0"
check "a marketplace dir whose name only ends in a newline is not that marketplace" \
  "$(msweep --marketplace solo --after-reload --apply; echo "$?"; [ -d "$c3/solo
/a/1.0" ] && echo kept)" "$(printf 'sweep: no marketplace solo in %s\n0\nkept' "$c3")"
codes=''
for bad in '' . .. ... ' ' ../other a/b --apply; do codes=$codes$(msweep --marketplace "$bad" 2>/dev/null; echo $?); done
codes=$codes$(msweep --marketplace 2>/dev/null; echo $?)$("$sweep" --marketplace mine 2>/dev/null; echo $?)
check "an empty, path-like, option-like or missing marketplace, or one without --plugins, is a usage error" "$codes" 2222222222
{ kill_tree "$pbusy" "$pargv"; wait "$pbusy" "$pargv"; } 2>/dev/null

# Weight classes: heavy.sh --classify through the built-in table, then a repo's .heavy-weights.
classify() { "$heavy" --classify "$@"; }
check "classify: go vet of a package is light" "$(classify go vet ./internal/x | cut -d: -f1)" "light builtin"
check "classify: go vet ./... is medium" "$(classify go vet ./... | cut -d' ' -f1)" medium
check "classify: go test ./... is heavy" "$(classify go test ./... | cut -d' ' -f1)" heavy
check "classify: go test -race of a package is medium" "$(classify go test -race ./pkg | cut -d' ' -f1)" medium
check "classify: go test of a subtree is medium" "$(classify go test ./pkg/... | cut -d' ' -f1)" medium
check "classify: git status is light" "$(classify git status | cut -d' ' -f1)" light
check "classify: git gc is heavy" "$(classify git gc | cut -d' ' -f1)" heavy
check "classify: an unknown command is heavy by default" "$(classify make check)" "heavy default"
check "classify takes -- and runs nothing" "$(classify -- touch "$tmp/ran-classify")$([ -e "$tmp/ran-classify" ] && echo ran)" "heavy default"
check "classify: ruff check is light" "$(classify ruff check . | cut -d: -f1)" "light builtin"
check "classify: uv run ruff format --check is light" "$(classify uv run ruff format --check . | cut -d: -f1)" "light builtin"
check "classify: mypy is medium" "$(classify mypy | cut -d: -f1)" "medium builtin"
check "classify: uv run mypy src is medium" "$(classify uv run mypy src | cut -d: -f1)" "medium builtin"
check "classify: uv run pyright is medium" "$(classify uv run pyright | cut -d: -f1)" "medium builtin"
check "classify: targeted pytest file is medium" "$(classify pytest tests/test_foo.py | cut -d: -f1)" "medium builtin"
check "classify: uv run pytest file::test is medium" "$(classify uv run pytest -q tests/test_foo.py::test_x | cut -d: -f1)" "medium builtin"
check "classify: uv run pytest -k is medium" "$(classify uv run pytest -k foo | cut -d: -f1)" "medium builtin"
check "classify: whole-suite uv run pytest is heavy" "$(classify uv run pytest)" "heavy default"
check "classify: whole-suite uv run pytest -q is heavy" "$(classify uv run pytest -q)" "heavy default"
check "classify: uv run pytest -n auto is heavy" "$(classify uv run pytest -n auto tests/test_foo.py | cut -d: -f1)" "heavy builtin"
check "classify: uv run pytest --cov is heavy" "$(classify uv run pytest --cov tests/test_foo.py | cut -d: -f1)" "heavy builtin"
check "classify: uv run pytest -m integration is heavy" "$(classify uv run pytest -m integration tests/test_foo.py | cut -d: -f1)" "heavy builtin"
check "classify: prettier --check is light" "$(classify prettier --check . | cut -d: -f1)" "light builtin"
check "classify: npx prettier --write is light" "$(classify npx prettier --write a.ts | cut -d: -f1)" "light builtin"
check "classify: pnpm exec prettier --check is light" "$(classify pnpm exec prettier --check . | cut -d: -f1)" "light builtin"
check "classify: eslint is medium" "$(classify eslint . | cut -d: -f1)" "medium builtin"
check "classify: npx tsc --noEmit is medium" "$(classify npx tsc --noEmit | cut -d: -f1)" "medium builtin"
check "classify: pnpm exec tsgo --noEmit is medium" "$(classify pnpm exec tsgo --noEmit | cut -d: -f1)" "medium builtin"
check "classify: pnpm knip is medium" "$(classify pnpm knip | cut -d: -f1)" "medium builtin"
check "classify: targeted node --test is medium" "$(classify node --test foo.test.mjs | cut -d: -f1)" "medium builtin"
check "classify: targeted npx vitest run is medium" "$(classify npx vitest run src/a.test.ts | cut -d: -f1)" "medium builtin"
check "classify: pnpm vitest run -t is medium" "$(classify pnpm vitest run -t "adds" | cut -d: -f1)" "medium builtin"
check "classify: targeted pnpm exec jest is medium" "$(classify pnpm exec jest src/a.spec.ts | cut -d: -f1)" "medium builtin"
check "classify: whole-suite node --test is heavy" "$(classify node --test)" "heavy default"
check "classify: multi-file node --test is heavy" "$(classify node --test a.test.mjs b.test.mjs | cut -d: -f1)" "heavy builtin"
check "classify: whole-suite vitest run is heavy" "$(classify vitest run)" "heavy default"
check "classify: npx vitest run --coverage is heavy" "$(classify npx vitest run --coverage src/a.test.ts | cut -d: -f1)" "heavy builtin"
check "classify: whole-suite jest is heavy" "$(classify jest)" "heavy default"
check "classify: integration jest is heavy" "$(classify npx jest --config jest.integration.config.js a.test.ts | cut -d: -f1)" "heavy builtin"
check "classify: npm run lint is heavy" "$(classify npm run lint)" "heavy default"
check "classify: pnpm run typecheck is heavy" "$(classify pnpm run typecheck)" "heavy default"
check "classify: playwright test is heavy" "$(classify playwright test)" "heavy default"

repo=$tmp/repo
mkdir -p "$repo" && git -C "$repo" init -q 2>/dev/null
printf '%s\n' '# overrides' '' 'light make lint*' 'bogus make nope*' 'heavy go vet*' 'medium sh -c*  ' >"$repo/.heavy-weights"
rclassify() { (cd "$repo" && "$heavy" --classify "$@"); }
check "repo rule wins over the built-in table, with its line as source" "$(rclassify go vet ./x 2>/dev/null)" "heavy repo:5"
check "repo rule, trailing space trimmed" "$(rclassify sh -c 'echo hi' 2>/dev/null)" "medium repo:6"
check "repo rule, a command only the repo names" "$(rclassify make lint 2>/dev/null)" "light repo:3"
check "an unknown class warns once and is skipped" "$(rclassify make nope 2>&1 | head -n 1)" "host: ignoring $repo/.heavy-weights:4: unknown class 'bogus'"
check "a command no repo rule matches falls to the built-in table" "$(rclassify git status 2>/dev/null)" "light builtin:22"

# Light: no slot, no queue place, even while the heavy slot is held; refused only past the critical load cap.
sleep 5 & holder=$!
mkdir -p "$L/heavy.lock.1"; echo "$holder" >"$L/heavy.lock.1/pid"
HOST_LOCK_TIMEOUT_SECONDS=3 "$heavy" git --version >/dev/null 2>"$tmp/err"
check "light runs while the heavy slots are full: no wait, no lock" \
  "$?:$(count "$L"/medium.lock.* "$L"/*.wait.*):$(count "$L"/heavy.lock.*):$(grep -c 'host:' "$tmp/err")" "0:0:1:0"
# Medium has its own pool: the full heavy slot does not hold it.
(cd "$repo" && HOST_LOCK_TIMEOUT_SECONDS=3 "$heavy" sh -c "touch '$tmp/medium-ran'" 2>/dev/null)
check "medium runs while the heavy slots are full" "$?:$([ -e "$tmp/medium-ran" ] && echo ran):$(count "$L"/medium.lock.*)" "0:ran:0"
{ kill "$holder"; wait "$holder"; } 2>/dev/null; rm -rf "$L"/heavy.lock.*

rm -f "$tmp/log"
(cd "$repo" && HOST_MEDIUM_SLOTS=1 "$heavy" sh -c "echo start >>'$tmp/log'; sleep 1; echo end >>'$tmp/log'" 2>/dev/null) &
sleep 0.3
(cd "$repo" && HOST_MEDIUM_SLOTS=1 "$heavy" sh -c "echo start >>'$tmp/log'; echo end >>'$tmp/log'" 2>/dev/null)
wait
check "HOST_MEDIUM_SLOTS=1: medium runs serialize" "$(tr '\n' ' ' <"$tmp/log")" "start end start end "
(cd "$repo" && "$heavy" sh -c "sleep 2" 2>/dev/null) & sleep 0.5
check "--status shows medium slots and both caps" \
  "$("$heavy" --status | grep -c -e '^medium slot 1: pid .* sh -c sleep 2 (load cap 200000, 4 slots, [0-9]*s)' -e '^load .* (cap 100000, critical 200000), slots 1, medium slots 4$')" 2
wait

HOST_CRITICAL_LOAD_CAP=-1 HOST_LOCK_TIMEOUT_SECONDS=1 HOST_POLL_SECONDS=1 "$heavy" git --version >/dev/null 2>"$tmp/err"
check "light waits on the critical cap, then times out" "$?" 124
check "the critical wait line names the cap and the class" "$(grep -c '^host: waiting for load .* to drop under -1 (HOST_CRITICAL_LOAD_CAP, light)$' "$tmp/err")" 1
check "a light timeout says it gave up" "$(grep -c '^host: gave up waiting for load to drop under -1 after 1s$' "$tmp/err")" 1
(cd "$repo" && HOST_CRITICAL_LOAD_CAP=-1 HOST_LOCK_TIMEOUT_SECONDS=1 HOST_POLL_SECONDS=1 "$heavy" sh -c true 2>"$tmp/err")
check "a medium load wait names its class" "$(grep -c '(HOST_CRITICAL_LOAD_CAP, medium)$' "$tmp/err")" 1

# Slot wait message, waited line and the metrics file.
sleep 5 & holder=$!
mkdir -p "$L/heavy.lock.1"; echo "$holder" >"$L/heavy.lock.1/pid"; echo "me make test" >"$L/heavy.lock.1/cmd"
HOST_LOCK_TIMEOUT_SECONDS=1 "$heavy" true 2>"$tmp/err"
check "the slot wait names the position, the busy slots and the holder" \
  "$(grep -c '^host: waiting for a heavy slot: position 1 in queue, 1/1 slots busy (me make test [0-9]*s)$' "$tmp/err")" 1
check "a slot timeout says which pool" "$(grep -c '^host: gave up waiting for a heavy slot after 1s$' "$tmp/err")" 1
{ kill "$holder"; wait "$holder"; } 2>/dev/null; rm -rf "$L"/heavy.lock.*

mf=$tmp/metrics/m.log
HOST_METRICS_FILE=$mf "$heavy" sleep 2 2>/dev/null & sleep 0.5
HOST_METRICS_FILE=$mf HOST_POLL_SECONDS=1 "$heavy" sh -c 'echo SECRET-ARG; exit 4' >/dev/null 2>"$tmp/err"
wait
check "a call that waited reports it" "$(grep -c '^host: waited [0-9]*s (slot) for a heavy slot$' "$tmp/err")" 1
line=$(grep 'cmd="sh -c"' "$mf")
check "metrics line: every field, in order" "$(echo "$line" | grep -Ec '^ts=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z weight=heavy source=default waited_s=[0-9]+ wait=slot ran_s=[0-9]+ exit=4 owner=[^ ]+ cmd="sh -c"$')" 1
check "metrics log only the first two words" "$(grep -c SECRET-ARG "$mf")" 0
HOST_METRICS_FILE=$mf "$heavy" git --version >/dev/null
check "metrics line for a light call, and for a timeout" \
  "$(grep -c 'weight=light source=builtin:[0-9]* waited_s=0 wait=none .* exit=0 ' "$mf")$(HOST_METRICS_FILE=$mf HOST_LOAD_CAP=-1 HOST_LOCK_TIMEOUT_SECONDS=0 "$heavy" true 2>/dev/null; grep -c 'wait=load ran_s=0 exit=124 ' "$mf")" 11
HOST_METRICS_FILE=/dev/null/nope/m.log "$heavy" sh -c 'exit 5' 2>/dev/null
check "a metrics write failure never changes the exit code" "$?" 5

# Orphan cleanup: a failed command's child in its own process group is stopped, a successful command's is kept.
rm -f "$tmp/orphan"
"$heavy" sh -c "set -m; sleep 30 & echo \$! >'$tmp/orphan'; sleep 3; exit 3" 2>"$tmp/err"
check "failed command: exit code kept, the left-behind process reported" "$?:$(grep -c '^host: stopped 1 processes the command left behind$' "$tmp/err")" "3:1"
check "failed command: the child in its own group is gone" "$(ps -o stat= -p "$(cat "$tmp/orphan")" | grep -v Z | sed 's/.*/alive/')" ""
check "the descendant record is removed" "$(count "$L"/heavy.tree.*)" 0
kill "$(cat "$tmp/orphan")" 2>/dev/null
"$heavy" sh -c "set -m; sleep 30 & echo \$! >'$tmp/orphan'; sleep 3; exit 0" 2>"$tmp/err"
check "successful command: nothing stopped, the child survives" "$?:$(grep -c 'stopped' "$tmp/err"):$(ps -o stat= -p "$(cat "$tmp/orphan")" | grep -v Z | sed 's/.*/alive/')" "0:0:alive"
kill "$(cat "$tmp/orphan")" 2>/dev/null

exit "$fails"
