# lib.sh: shared host-hygiene helpers, sourced by heavy.sh, lease.sh, register-service.sh.
# Lock order lives here: heavy slot first, then a device lease. Never the reverse.
#
# Contract (stable; other tools interoperate through these paths, so never rename them):
#   $HOST_LOCK_DIR/heavy.lock.<n>/pid      heavy slot n (1..HOST_HEAVY_SLOTS), dir made with mkdir; cmd and cap beside pid
#   $HOST_LOCK_DIR/heavy.wait.<pid>        a waiter's place in the queue, served oldest mtime first
#   $HOST_LOCK_DIR/<class>.lease           device lease, "<owner> <pid> [device]", made with noclobber
#   $HOST_LOCK_DIR/host-services/<pid>     service registry entry, removed on exit
# Env: HOST_LOCK_DIR (/tmp: machine-wide, cleared on reboot), HOST_HEAVY_SLOTS (2),
#      HOST_LOAD_CAP (30), HOST_DISK_FLOOR_GB (20), HOST_LOCK_TIMEOUT_SECONDS (1800),
#      HOST_POLL_SECONDS (30), HOST_OWNER (user@dir).
# A holder is alive only if `ps` finds its pid, not a zombie, started before it wrote the lock; a lock left
# without a pid for 60 s is abandoned.
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
host_sleeper=''
host_load=''
host_deadline=$(($(date +%s) + HOST_LOCK_TIMEOUT_SECONDS))

host_load1() {
  if [ -r /proc/loadavg ]; then cut -d' ' -f1 /proc/loadavg; else sysctl -n vm.loadavg | awk '{ print $2 }'; fi
}
if stat -c %Y / >/dev/null 2>&1; then host_mtime() { stat -c %Y "$1" 2>/dev/null; }; else host_mtime() { stat -f %m "$1" 2>/dev/null; }; fi
host_age() { local m; m=$(host_mtime "$1") && [ -n "$m" ] && echo $(($(date +%s) - m)); }
# host_holder <pid> [<file it wrote>]: alive, gone or reused. `kill -0` alone reads a reused pid as alive and a
# live process of another user (EPERM) as gone. A zombie is gone; a pid that started after its file is reused.
host_holder() {
  local info since
  info=$(ps -o etime=,stat= -p "${1:-x}" 2>/dev/null | awk '{ n = split($1, t, /[-:]/); s = t[n] + 60 * t[n - 1]
    if (n > 2) s += 3600 * t[n - 2]; if (n > 3) s += 86400 * t[n - 3]; print s, $2 }')
  case $info in '' | *' Z'*) echo gone; return ;; esac
  since=$([ -n "${2:-}" ] && host_mtime "$2")
  # etime and mtime are whole seconds: allow 2 s of rounding.
  if [ -n "$since" ] && [ $(($(date +%s) - ${info% *})) -gt $((since + 2)) ]; then echo reused; else echo alive; fi
}
# host_tree <pid>: the pid and its descendants.
host_tree() {
  ps -A -o pid=,ppid= | awk -v root="$1" '{ up[$1] = $2 } END { t[root] = 1
    do { n = 0; for (p in up) if (!(p in t) && (up[p] in t)) { t[p] = 1; n++ } } while (n); for (p in t) print p }'
}
host_alive() { [ "$(host_holder "$1" "${2:-}")" = alive ]; }
host_say() { echo "host: $*" >&2; }
host_timed_out() { [ "$(date +%s)" -ge "$host_deadline" ]; }
host_over_cap() { host_load=$(host_load1); awk -v l="$host_load" -v m="$HOST_LOAD_CAP" 'BEGIN { exit !(l > m) }'; }
# Sleep in the background: bash runs a trap only after the foreground command, so TERM would wait out the sleep.
host_sleep() { sleep "$1" & host_sleeper=$!; wait "$host_sleeper"; host_sleeper=''; }

# Free space does not recover by itself: fail fast instead of waiting.
host_disk_check() {
  local free
  free=$(df -Pk . | awk 'NR == 2 { print int($4 / 1048576) }')
  if [ "$free" -lt "$HOST_DISK_FLOOR_GB" ]; then
    host_say "refusing, ${free} GB free < ${HOST_DISK_FLOOR_GB} GB (HOST_DISK_FLOOR_GB). Clean your own leftovers first."
    exit 1
  fi
}

host_pidfile() { if [ -d "$1" ]; then echo "$1/pid"; else echo "$1"; fi; }
# host_abandoned <lock> <pid>: its holder is gone, or it has had no pid for 60 s (holder killed before writing it).
host_abandoned() {
  if [ -n "$2" ]; then ! host_alive "$2" "$(host_pidfile "$1")"; else [ "$(host_age "$1")" -ge 60 ] 2>/dev/null; fi
}

# host_reclaim <path> <pid> <reader>: move an abandoned lock aside, then re-read it. If it changed hands in between
# (or is no longer abandoned), put it back, but only when nothing took its place: mv into an existing dir nests,
# mv over a file replaces it.
host_reclaim() {
  local path=$1 pid=$2 reader=$3 aside="$1.stale.$$" now
  mv "$path" "$aside" 2>/dev/null || return 1
  now=$("$reader" "$aside")
  if [ "$now" != "$pid" ] || ! host_abandoned "$aside" "$now"; then
    [ -e "$path" ] || mv "$aside" "$path"
    return 1
  fi
  host_say "recovered stale ${path##*/} (${pid:+pid $pid is gone}${pid:-no pid for 60s})"
  rm -rf "$aside"
}
host_slot_pid() { cat "$1/pid" 2>/dev/null; }
host_lease_pid() { awk '{ print $2 }' "$1" 2>/dev/null; }

# Reclaim abandoned slots, then print the numbers of the free ones.
host_slot_free() {
  local i d p
  for i in $(seq 1 "$HOST_HEAVY_SLOTS"); do
    d=$HOST_LOCK_DIR/heavy.lock.$i
    if [ -d "$d" ]; then p=$(host_slot_pid "$d"); host_abandoned "$d" "$p" && host_reclaim "$d" "$p" host_slot_pid; fi
    [ -d "$d" ] || echo "$i"
  done
}

# Live waiters queued before this one: an older wait file, or the same mtime and a lower pid.
host_ahead() {
  local me=$HOST_LOCK_DIR/heavy.wait.$$ w p n=0
  for w in "$HOST_LOCK_DIR"/heavy.wait.*; do
    p=${w##*.}
    [ -f "$w" ] && [ "$p" != $$ ] || continue
    { [ "$w" -ot "$me" ] || { ! [ "$w" -nt "$me" ] && [ "$p" -lt $$ ]; }; } && host_alive "$p" "$w" && n=$((n + 1))
  done
  echo "$n"
}

# Wait until load is under HOST_LOAD_CAP and this waiter is next (oldest wait file first), take a free slot,
# then re-check load and give the slot back if it rose. No slot is held while waiting, so idle waiters never
# fill the slots and a quiet machine is used within one poll.
host_slot_acquire() {
  local i n said='' free ahead
  echo "$HOST_OWNER $*" >"$HOST_LOCK_DIR/heavy.wait.$$"
  while :; do
    if host_over_cap; then
      host_timed_out && { host_say "gave up waiting for load to drop under $HOST_LOAD_CAP after ${HOST_LOCK_TIMEOUT_SECONDS}s"; exit 124; }
      [ "$said" = load ] || { said=load; host_say "waiting for load $host_load to drop under $HOST_LOAD_CAP (HOST_LOAD_CAP)"; }
      host_sleep "$HOST_POLL_SECONDS"
      continue
    fi
    free=$(host_slot_free)
    ahead=$(host_ahead)
    n=0; for i in $free; do n=$((n + 1)); done
    if [ "$ahead" -lt "$n" ]; then
      for i in $free; do
        if mkdir "$HOST_LOCK_DIR/heavy.lock.$i" 2>/dev/null; then
          host_slot=$HOST_LOCK_DIR/heavy.lock.$i
          echo $$ >"$host_slot/pid"; echo "$HOST_OWNER $*" >"$host_slot/cmd"
          echo "load cap $HOST_LOAD_CAP, $HOST_HEAVY_SLOTS slots" >"$host_slot/cap"
          break
        fi
      done
    fi
    if [ -n "$host_slot" ]; then
      host_over_cap || break
      rm -rf "$host_slot"; host_slot=''
      continue
    fi
    host_timed_out && { host_say "gave up waiting for a heavy slot after ${HOST_LOCK_TIMEOUT_SECONDS}s"; exit 124; }
    [ "$said" = slot ] || { said=slot; host_say "waiting for a heavy slot ($(cat "$HOST_LOCK_DIR"/heavy.lock.*/cmd 2>/dev/null | head -1))"; }
    host_sleep $((HOST_POLL_SECONDS < 2 ? HOST_POLL_SECONDS : 2))
  done
  rm -f "$HOST_LOCK_DIR/heavy.wait.$$"
}

# Release only what this process holds: a waiter that gave up must never free the holder's slot.
host_slot_release() {
  [ -n "$host_sleeper" ] && kill "$host_sleeper" 2>/dev/null
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
  local d w p state
  for d in "$HOST_LOCK_DIR"/heavy.lock.*; do
    case $d in *.stale.*) continue ;; esac
    [ -d "$d" ] || continue
    p=$(host_slot_pid "$d")
    case ${p:+$(host_holder "$p" "$d/pid")} in alive) state='' ;; gone) state=', holder dead' ;; reused) state=', pid reused' ;; *) state=', no pid' ;; esac
    echo "slot ${d##*.}: pid ${p:-none} $(cat "$d/cmd" 2>/dev/null) ($(cat "$d/cap" 2>/dev/null || echo 'cap unknown'), $(host_age "$(host_pidfile "$d")")s$state)"
  done
  for w in "$HOST_LOCK_DIR"/heavy.wait.*; do
    [ -f "$w" ] && host_alive "${w##*.}" "$w" && echo "waiting: pid ${w##*.} $(cat "$w") ($(host_age "$w")s)"
  done
  for d in "$HOST_LOCK_DIR"/*.lease; do
    [ -f "$d" ] && echo "lease ${d##*/}: $(cat "$d")$(host_alive "$(host_lease_pid "$d")" "$d" || echo ' (stale)')"
  done
  host_services
  echo "load $(host_load1) (cap $HOST_LOAD_CAP), slots $HOST_HEAVY_SLOTS"
}
