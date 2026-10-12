#!/usr/bin/env bash
# heavy.sh [--] <command...>   run a command holding a machine-wide heavy slot
# heavy.sh --status            print holders and waiters
#
# Env: HEAVY_SLOTS (1), HEAVY_LOAD_MAX (min(30, 0.75 x CPUs)), HEAVY_DISK_MIN_GB (20),
#      HEAVY_STATE_DIR (per-user temp dir). Waits for a slot and for load; refuses on low disk.
set -u

dir=${HEAVY_STATE_DIR:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/heavy-$(id -u)}
slots=${HEAVY_SLOTS:-1}
cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)
# Default stays at or under the guard plugin's loadCap (30), so heavy.sh waits before guard denies.
load_max=${HEAVY_LOAD_MAX:-$(awk -v c="$cpus" 'BEGIN { m = 0.75 * c; print (m > 30 ? 30 : m) }')}
disk_min=${HEAVY_DISK_MIN_GB:-20}
mkdir -p "$dir"

load1() {
  if [ -r /proc/loadavg ]; then cut -d' ' -f1 /proc/loadavg; else sysctl -n vm.loadavg | awk '{ print $2 }'; fi
}
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

status() {
  for d in "$dir"/slot.*; do
    [ -d "$d" ] && echo "held: pid $(cat "$d/pid" 2>/dev/null) $(cat "$d/cmd" 2>/dev/null)"
  done
  for w in "$dir"/wait.*; do
    [ -f "$w" ] && alive "${w##*.}" && echo "waiting: pid ${w##*.} $(cat "$w")"
  done
  echo "load $(load1) (max $load_max), slots $slots"
}

if [ "${1:-}" = --status ]; then status; exit 0; fi
[ "${1:-}" = -- ] && shift
[ $# -gt 0 ] || { echo "usage: heavy.sh [--] <command...> | --status" >&2; exit 2; }

free=$(df -Pk . | awk 'NR == 2 { print int($4 / 1048576) }')
if [ "$free" -lt "$disk_min" ]; then
  echo "heavy: refusing, ${free} GB free < ${disk_min} GB (HEAVY_DISK_MIN_GB). Clean your own leftovers first." >&2
  exit 1
fi

held=''
trap 'rm -f "$dir/wait.$$"; [ -n "$held" ] && rm -rf "$held"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
echo "$*" >"$dir/wait.$$"

said=''
while [ -z "$held" ]; do
  for i in $(seq 1 "$slots"); do
    d=$dir/slot.$i
    if mkdir "$d" 2>/dev/null; then
      echo $$ >"$d/pid"; echo "$*" >"$d/cmd"; held=$d; break
    fi
    p=$(cat "$d/pid" 2>/dev/null)
    # ponytail: re-read guards most reap races; a mkdir-ed lock whose holder died before writing pid needs a manual rm
    if [ -n "$p" ] && ! alive "$p" && [ "$(cat "$d/pid" 2>/dev/null)" = "$p" ]; then
      echo "heavy: recovering stale slot $i (pid $p is gone)" >&2
      rm -rf "$d"
    fi
  done
  if [ -z "$held" ]; then
    [ -z "$said" ] && echo "heavy: waiting for a slot ($(cat "$dir"/slot.*/cmd 2>/dev/null | head -1))" >&2 && said=1
    sleep 2
  fi
done
rm -f "$dir/wait.$$"

said=''
while awk -v l="$(load1)" -v m="$load_max" 'BEGIN { exit !(l > m) }'; do
  [ -z "$said" ] && echo "heavy: waiting for load $(load1) to drop under $load_max" >&2 && said=1
  sleep 5
done

"$@"
