# lib.sh: shared host-hygiene helpers, sourced by heavy.sh, lease.sh, register-service.sh.
# Lock order lives here: heavy slot first, then a device lease. Never the reverse.
#
# Contract (stable; other tools interoperate through these paths, so never rename them):
#   $HOST_LOCK_DIR/heavy.lock.<n>/pid      heavy slot n (1..HOST_HEAVY_SLOTS), dir made with mkdir
#   $HOST_LOCK_DIR/<class>.lease           device lease, "<owner> <pid> [device]", made with noclobber
#   $HOST_LOCK_DIR/host-services/<pid>     service registry entry, removed on exit
# Env: HOST_LOCK_DIR (/tmp: machine-wide, cleared on reboot), HOST_HEAVY_SLOTS (2),
#      HOST_LOAD_CAP (30), HOST_DISK_FLOOR_GB (20), HOST_LOCK_TIMEOUT_SECONDS (1800),
#      HOST_POLL_SECONDS (30), HOST_OWNER (user@dir).
# shellcheck shell=bash

HOST_LOCK_DIR=${HOST_LOCK_DIR:-/tmp}
HOST_HEAVY_SLOTS=${HOST_HEAVY_SLOTS:-2}
HOST_LOAD_CAP=${HOST_LOAD_CAP:-30}
HOST_DISK_FLOOR_GB=${HOST_DISK_FLOOR_GB:-20}
HOST_LOCK_TIMEOUT_SECONDS=${HOST_LOCK_TIMEOUT_SECONDS:-1800}
HOST_POLL_SECONDS=${HOST_POLL_SECONDS:-30}
HOST_OWNER=${HOST_OWNER:-${USER:-$(id -un)}@$(basename "$PWD")}
HOST_OWNER=${HOST_OWNER// /_}
mkdir -p "$HOST_LOCK_DIR"
host_slot=''
host_deadline=$(($(date +%s) + HOST_LOCK_TIMEOUT_SECONDS))

host_load1() {
  if [ -r /proc/loadavg ]; then cut -d' ' -f1 /proc/loadavg; else sysctl -n vm.loadavg | awk '{ print $2 }'; fi
}
host_alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
host_say() { echo "host: $*" >&2; }
host_timed_out() { [ "$(date +%s)" -ge "$host_deadline" ]; }

# Free space does not recover by itself: fail fast instead of waiting.
host_disk_check() {
  local free
  free=$(df -Pk . | awk 'NR == 2 { print int($4 / 1048576) }')
  if [ "$free" -lt "$HOST_DISK_FLOOR_GB" ]; then
    host_say "refusing, ${free} GB free < ${HOST_DISK_FLOOR_GB} GB (HOST_DISK_FLOOR_GB). Clean your own leftovers first."
    exit 1
  fi
}

# host_reclaim <path> <dead pid> <reader>: move a dead holder's lock aside, then re-read it.
# If the lock changed hands in between (or the pid is alive again), put it back, but only
# when nothing took its place: mv into an existing dir nests, mv over a file replaces it.
host_reclaim() {
  local path=$1 pid=$2 reader=$3 aside="$1.stale.$$" now
  mv "$path" "$aside" 2>/dev/null || return 1
  now=$("$reader" "$aside")
  if [ "$now" != "$pid" ] || host_alive "$now"; then
    [ -e "$path" ] || mv "$aside" "$path"
    return 1
  fi
  host_say "recovered stale ${path##*/} (pid $pid is gone)"
  rm -rf "$aside"
}
host_slot_pid() { cat "$1/pid" 2>/dev/null; }
host_lease_pid() { awk '{ print $2 }' "$1" 2>/dev/null; }

# Take one of HOST_HEAVY_SLOTS slots, then wait for load to fall under HOST_LOAD_CAP.
host_slot_acquire() {
  local i d p said=''
  echo "$HOST_OWNER $*" >"$HOST_LOCK_DIR/heavy.wait.$$"
  while [ -z "$host_slot" ]; do
    for i in $(seq 1 "$HOST_HEAVY_SLOTS"); do
      d=$HOST_LOCK_DIR/heavy.lock.$i
      if mkdir "$d" 2>/dev/null; then
        echo $$ >"$d/pid"; echo "$HOST_OWNER $*" >"$d/cmd"; host_slot=$d; break
      fi
      # ponytail: a holder killed between mkdir and writing pid leaves a lock to rm by hand
      p=$(host_slot_pid "$d")
      host_alive "$p" || [ -z "$p" ] || host_reclaim "$d" "$p" host_slot_pid
    done
    [ -n "$host_slot" ] && break
    host_timed_out && { host_say "gave up waiting for a heavy slot after ${HOST_LOCK_TIMEOUT_SECONDS}s"; exit 124; }
    [ -z "$said" ] && said=1 && host_say "waiting for a heavy slot ($(cat "$HOST_LOCK_DIR"/heavy.lock.*/cmd 2>/dev/null | head -1))"
    sleep 2
  done
  rm -f "$HOST_LOCK_DIR/heavy.wait.$$"
  said=''
  while awk -v l="$(host_load1)" -v m="$HOST_LOAD_CAP" 'BEGIN { exit !(l > m) }'; do
    host_timed_out && { host_say "gave up waiting for load to drop under $HOST_LOAD_CAP"; exit 124; }
    [ -z "$said" ] && said=1 && host_say "waiting for load $(host_load1) to drop under $HOST_LOAD_CAP (HOST_LOAD_CAP)"
    sleep "$HOST_POLL_SECONDS"
  done
}

# Release only what this process holds: a waiter that gave up must never free the holder's slot.
host_slot_release() {
  rm -f "$HOST_LOCK_DIR/heavy.wait.$$"
  [ -n "$host_slot" ] && [ "$(host_slot_pid "$host_slot")" = $$ ] && rm -rf "$host_slot"
  host_slot=''
}

host_services() {
  local s
  for s in "$HOST_LOCK_DIR"/host-services/*; do
    [ -f "$s" ] && echo "service: $(tr '\n' ' ' <"$s")$(host_alive "${s##*/}" || echo '(orphan entry)')"
  done
}

host_status() {
  local d w
  for d in "$HOST_LOCK_DIR"/heavy.lock.*; do
    [ -d "$d" ] && echo "slot ${d##*.}: pid $(host_slot_pid "$d") $(cat "$d/cmd" 2>/dev/null)"
  done
  for w in "$HOST_LOCK_DIR"/heavy.wait.*; do
    [ -f "$w" ] && host_alive "${w##*.}" && echo "waiting: pid ${w##*.} $(cat "$w")"
  done
  for d in "$HOST_LOCK_DIR"/*.lease; do
    [ -f "$d" ] && echo "lease ${d##*/}: $(cat "$d")$(host_alive "$(host_lease_pid "$d")" || echo ' (stale)')"
  done
  host_services
  echo "load $(host_load1) (cap $HOST_LOAD_CAP), slots $HOST_HEAVY_SLOTS"
}
