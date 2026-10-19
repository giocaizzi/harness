#!/usr/bin/env bash
# Tests for plugins/dev-tools/skills/host-hygiene/scripts/*.sh (run by `make test`).
set -u
scripts="$(cd "$(dirname "$0")/.." && pwd)/plugins/dev-tools/skills/host-hygiene/scripts"
heavy=$scripts/heavy.sh lease=$scripts/lease.sh reg=$scripts/register-service.sh sweep=$scripts/sweep-stale.sh
tmp=$(cd "$(mktemp -d)" && pwd -P); trap 'rm -rf "$tmp"' EXIT
export HOST_LOCK_DIR="$tmp/locks" HOST_LOAD_CAP=100000 HOST_DISK_FLOOR_GB=0 HOST_HEAVY_SLOTS=1
L=$HOST_LOCK_DIR
fails=0
count() { local n=0 f; for f in "$@"; do [ -e "$f" ] && n=$((n + 1)); done; echo "$n"; }
check() { if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "not ok - $1: got '$2', want '$3'"; fails=$((fails + 1)); fi; }
dead_pid() { sh -c 'exit 0' & local p=$!; wait "$p"; echo "$p"; }

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

mkdir -p "$L/heavy.lock.1"; dead_pid >"$L/heavy.lock.1/pid"
"$heavy" true 2>/dev/null
check "stale slot recovered" "$?" 0
check "slot released" "$(count "$L"/heavy.lock.*)" 0

HOST_DISK_FLOOR_GB=999999999 "$heavy" touch "$tmp/ran" 2>/dev/null
check "low disk refuses" "$?:$([ -e "$tmp/ran" ] && echo ran)" "1:"

HOST_LOAD_CAP=-1 HOST_LOCK_TIMEOUT_SECONDS=1 HOST_POLL_SECONDS=1 "$heavy" touch "$tmp/ran" 2>"$tmp/err"
check "load cap waits, then times out" "$?:$([ -e "$tmp/ran" ] && echo ran)" "124:"
check "one status line per wait" "$(grep -c '^host: waiting for load' "$tmp/err")" 1

"$heavy" sleep 2 & sleep 0.3
check "--status shows the holder" "$("$heavy" --status | grep -c 'slot 1: pid .* sleep 2')" 1
wait

# Release own only: a waiter that gives up leaves the holder's slot alone.
sleep 5 & holder=$!
mkdir -p "$L/heavy.lock.1"; echo "$holder" >"$L/heavy.lock.1/pid"
HOST_LOCK_TIMEOUT_SECONDS=1 "$heavy" true 2>/dev/null
check "timed-out waiter exits 124" "$?" 124
check "timed-out waiter keeps the holder's slot" "$(cat "$L/heavy.lock.1/pid")" "$holder"

# Atomic reclaim: a lock that changed hands between the read and the mv is put back, never nested.
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
  exit "$fails"
); fails=$((fails + $?))
rm -rf "$L"/heavy.lock.*; { kill "$holder"; wait "$holder"; } 2>/dev/null

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

# sweep-stale.sh
repo=$tmp/repo
git init -q "$repo" && git -C "$repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
for n in old recent dirty busy; do git -C "$repo" worktree add -q "$tmp/wt-$n" -b "$n" 2>/dev/null; done
touch "$tmp/wt-dirty/new"
for n in old dirty busy; do find "$tmp/wt-$n" -exec touch -t 202001010000 {} +; done
(cd "$tmp/wt-busy" && sleep 10) & busy=$!
out=$(cd "$repo" && "$sweep")
check "sweep dry run removes only the old, clean, idle worktree" \
  "$(echo "$out" | grep -c '^would remove')$(echo "$out" | grep -c "would remove $tmp/wt-old")" 11
check "sweep keeps recent, dirty and busy" \
  "$(echo "$out" | grep -c -e 'wt-recent: modified' -e 'wt-dirty: uncommitted' -e 'wt-busy: in use')" 3
check "dry run removes nothing" "$(git -C "$repo" worktree list | wc -l | tr -d ' ')" 5
(cd "$repo" && "$sweep" --apply >/dev/null 2>&1)
check "--apply removes it" "$([ -d "$tmp/wt-old" ] && echo kept)$(git -C "$repo" worktree list | wc -l | tr -d ' ')" 4
check "sweep never touches the current worktree" "$(cd "$tmp/wt-recent" && "$sweep" | grep -c 'wt-recent: current')" 1
{ kill "$busy"; wait "$busy"; } 2>/dev/null

# sweep-stale.sh --branches
git init -q --bare -b main "$tmp/origin.git"
br=$tmp/brrepo
git init -q -b main "$br" && git -C "$br" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$br" remote add origin "$tmp/origin.git" && git -C "$br" push -q origin main
for n in orphan open gone; do git -C "$br" branch "$n"; git -C "$br" push -q -u origin "$n" 2>/dev/null; done
git -C "$tmp/origin.git" branch -q -D gone
export SWEEP_OPEN_BRANCHES=open
out=$(cd "$br" && "$sweep" --branches)
check "branch sweep reports orphan remote and gone local only" \
  "$(echo "$out" | grep -c '^would delete')$(echo "$out" | grep -c -e 'would delete origin/orphan' -e 'would delete gone: upstream gone')" 22
check "branch dry run deletes nothing" "$(git -C "$tmp/origin.git" branch | wc -l | tr -d ' ')" 3
(cd "$br" && "$sweep" --branches --apply >/dev/null 2>&1)
check "branch --apply deletes them, keeps open and default" \
  "$(git -C "$tmp/origin.git" branch | tr -d ' *' | sort | tr '\n' ' ')$(git -C "$br" branch | tr -d ' *' | sort | tr '\n' ' ')" "main open main open "
unset SWEEP_OPEN_BRANCHES

exit "$fails"
