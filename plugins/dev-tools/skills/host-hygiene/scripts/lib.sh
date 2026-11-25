# lib.sh: shared host-hygiene helpers, sourced by heavy.sh, lease.sh, register-service.sh.
# Lock order lives here: heavy slot first, then a device lease. Never the reverse.
#
# Contract (stable; other tools interoperate through these paths, so never rename them):
#   $HOST_LOCK_DIR/heavy.lock.<n>/pid      heavy slot n (1..HOST_HEAVY_SLOTS), dir made with mkdir; cmd and cap beside pid
#   $HOST_LOCK_DIR/heavy.wait.<pid>        a waiter's place in the queue, "<load cap> <owner> <cmd>", served oldest
#                                          mtime first among the waiters whose cap the current load meets
#   $HOST_LOCK_DIR/medium.lock.<n>/pid    medium slot n (1..HOST_MEDIUM_SLOTS), same layout as a heavy slot
#   $HOST_LOCK_DIR/medium.wait.<pid>       a medium waiter, same layout as heavy.wait.<pid>, its own queue
#   $HOST_LOCK_DIR/heavy.tree.<pid>        "<pid> <lstart>" of each descendant heavy.sh <pid>'s command started, so a
#                                          failed command's leftovers (own process group) can be stopped; removed on exit
#   $HOST_LOCK_DIR/<class>.lease           device lease, "<owner> <pid> [device]", made with noclobber
#   $HOST_LOCK_DIR/host-services/<pid>     service registry entry, removed on exit
# Env: HOST_LOCK_DIR (/tmp: machine-wide, cleared on reboot), HOST_HEAVY_SLOTS (2),
#      HOST_LOAD_CAP (30), HOST_DISK_FLOOR_GB (20), HOST_LOCK_TIMEOUT_SECONDS (1800),
#      HOST_POLL_SECONDS (30), HOST_OWNER (user@dir), HOST_MEDIUM_SLOTS (4),
#      HOST_CRITICAL_LOAD_CAP (twice HOST_LOAD_CAP: the cap light and medium commands wait on),
#      HOST_METRICS_FILE (default ${XDG_STATE_HOME:-~/.local/state}/host-hygiene/heavy.log; 'off' or empty disables it).
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
HOST_MEDIUM_SLOTS=${HOST_MEDIUM_SLOTS:-4}
# Caps may be decimals, so the default is computed by awk.
HOST_CRITICAL_LOAD_CAP=${HOST_CRITICAL_LOAD_CAP:-$(awk -v c="$HOST_LOAD_CAP" 'BEGIN { printf "%.10g", c * 2 }')}
if [ -z "${HOST_METRICS_FILE+x}" ]; then
  host_state=${XDG_STATE_HOME:-${HOME:+$HOME/.local/state}}
  HOST_METRICS_FILE=${host_state:+$host_state/host-hygiene/heavy.log}
fi
[ "$HOST_METRICS_FILE" = off ] && HOST_METRICS_FILE=''
host_lib_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$HOST_LOCK_DIR"
host_slot=''
host_sleeper=''
host_child=''
host_load=''
host_deadline=$(($(date +%s) + HOST_LOCK_TIMEOUT_SECONDS))
host_weight='' host_weight_source=''
host_wait_file='' host_wait_start='' host_wait_secs=0 host_w_load='' host_w_slot=''
host_run_start='' host_run_end=''

# host_set_pool heavy|medium|light: which pool the next acquire uses. Heavy is the default, so lease.sh, which
# never classifies, keeps taking heavy slots. Light has no slots: it only waits on the critical cap.
host_set_pool() {
  host_pool=$1
  case $1 in
    heavy) host_pool_slots=$HOST_HEAVY_SLOTS host_pool_cap=$HOST_LOAD_CAP host_pool_capvar=HOST_LOAD_CAP host_pool_note='' ;;
    medium) host_pool_slots=$HOST_MEDIUM_SLOTS host_pool_cap=$HOST_CRITICAL_LOAD_CAP host_pool_capvar=HOST_CRITICAL_LOAD_CAP host_pool_note=', medium' ;;
    *) host_pool_slots=0 host_pool_cap=$HOST_CRITICAL_LOAD_CAP host_pool_capvar=HOST_CRITICAL_LOAD_CAP host_pool_note=', light' ;;
  esac
}
host_set_pool heavy

# host_classify <cmd...>: sets host_weight (light|medium|heavy) and host_weight_source (repo:<line>,
# builtin:<line> or default). Rules "<class> <glob>", the repo's .heavy-weights first, then weights.default;
# first match wins, no match is heavy. The glob is matched against argv joined by single spaces.
host_classify() {
  local cmd top src file n class glob
  if [ "${1:-}" = env ] && [ $# -gt 1 ]; then
    shift
    [ "${1:-}" = -- ] && [ $# -gt 1 ] && shift
  fi
  while [ $# -gt 1 ]; do
    case $1 in
      [A-Za-z_]*=*)
        case ${1%%=*} in *[!A-Za-z0-9_]*) break ;; esac
        shift ;;
      *) break ;;
    esac
  done
  cmd=$(IFS=' '; printf '%s' "$*")
  host_weight=heavy host_weight_source=default
  top=$(git rev-parse --show-toplevel 2>/dev/null)
  for src in repo builtin; do
    if [ "$src" = repo ]; then file=$top/.heavy-weights; [ -n "$top" ] || continue; else file=$host_lib_dir/weights.default; fi
    [ -r "$file" ] || continue
    n=0
    while read -r class glob || [ -n "$class" ]; do
      n=$((n + 1))
      case $class in '' | '#'*) continue ;; esac
      case $class in light | medium | heavy) ;; *) host_say "ignoring $file:$n: unknown class '$class'"; continue ;; esac
      [ -n "$glob" ] || continue
      # shellcheck disable=SC2254 # the rule's glob is the pattern
      case $cmd in $glob) host_weight=$class host_weight_source=$src:$n; return 0 ;; esac
    done <"$file"
  done
}

host_load1() {
  if [ -r /proc/loadavg ]; then cut -d' ' -f1 /proc/loadavg; else sysctl -n vm.loadavg | awk '{ print $2 }'; fi
}
if stat -c %Y / >/dev/null 2>&1; then host_mtime() { stat -c %Y "$1" 2>/dev/null; }; else host_mtime() { stat -f %m "$1" 2>/dev/null; }; fi
host_age() { local m; m=$(host_mtime "$1") && [ -n "$m" ] && echo $(($(date +%s) - m)); }
# Without a ps that takes -p (none in slim images, BusyBox's does not), host_holder falls back to kill -0.
if ps -o etime=,stat= -p $$ >/dev/null 2>&1; then host_ps=1; else host_ps=''; fi
# host_holder <pid> [<file it wrote>]: alive, stopped, gone or reused. `kill -0` alone reads a reused pid as alive
# and a live process of another user (EPERM) as gone. A zombie is gone; a pid that started after its file is reused.
host_holder() {
  local info since
  case ${1:-} in '' | *[!0-9]*) echo gone; return ;; esac
  if [ -z "$host_ps" ]; then
    if kill -0 "$1" 2>/dev/null || kill -0 "$1" 2>&1 | grep -qi 'not permitted'; then echo alive; else echo gone; fi
    return
  fi
  info=$(ps -o etime=,stat= -p "$1" 2>/dev/null | awk '{ n = split($1, t, /[-:]/); s = t[n] + 60 * t[n - 1]
    if (n > 2) s += 3600 * t[n - 2]; if (n > 3) s += 86400 * t[n - 3]; print s, $2 }')
  case $info in '' | *' Z'*) echo gone; return ;; *' T'*) echo stopped; return ;; esac
  since=$([ -n "${2:-}" ] && host_mtime "$2")
  # etime and mtime are whole seconds: allow 2 s of rounding.
  if [ -n "$since" ] && [ $(($(date +%s) - ${info% *})) -gt $((since + 2)) ]; then echo reused; else echo alive; fi
}
# host_tree <pid>: the pid and its descendants.
host_tree() {
  ps -A -o pid=,ppid= 2>/dev/null | awk -v root="$1" '{ up[$1] = $2 } END { t[root] = 1
    do { n = 0; for (p in up) if (!(p in t) && (up[p] in t)) { t[p] = 1; n++ } } while (n); for (p in t) print p }'
}
# A stopped holder still holds its slot or lease: it may be resumed.
host_alive() { case $(host_holder "$1" "${2:-}") in alive | stopped) return 0 ;; *) return 1 ;; esac; }
host_say() { echo "host: $*" >&2; }
host_timed_out() { [ "$(date +%s)" -ge "$host_deadline" ]; }
host_over_cap() { host_load=$(host_load1); awk -v l="$host_load" -v m="$host_pool_cap" 'BEGIN { exit !(l > m) }'; }
host_say_load() { host_say "waiting for load $host_load to drop under $host_pool_cap ($host_pool_capvar$host_pool_note)"; }
host_gave_up_load() { host_say "gave up waiting for load to drop under $host_pool_cap after ${HOST_LOCK_TIMEOUT_SECONDS}s"; exit 124; }
# Stop the wait clock; the call's wait seconds are what elapsed since it started.
host_wait_done() {
  [ -n "$host_wait_start" ] && host_wait_secs=$(($(date +%s) - host_wait_start))
  host_wait_start=''
}
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

# host_abandoned <lock> <pid>: its holder is gone, or it has had no pid for 60 s (holder killed before writing it).
host_abandoned() {
  if [ -n "$2" ]; then ! host_alive "$2" "$1"; else [ "$(host_age "$1")" -ge 60 ] 2>/dev/null; fi
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
  if [ -n "$pid" ]; then host_say "recovered stale ${path##*/} (pid $pid is gone)"; else host_say "recovered stale ${path##*/} (no pid for 60s)"; fi
  rm -rf "$aside"
}
host_slot_pid() { cat "$1/pid" 2>/dev/null; }
host_lease_pid() { awk '{ print $2 }' "$1" 2>/dev/null; }

# Reclaim abandoned slots, then print the numbers of the free ones.
host_slot_free() {
  local i d p
  for i in $(seq 1 "$host_pool_slots"); do
    d=$HOST_LOCK_DIR/$host_pool.lock.$i
    if [ -d "$d" ]; then p=$(host_slot_pid "$d"); host_abandoned "$d" "$p" && host_reclaim "$d" "$p" host_slot_pid; fi
    [ -d "$d" ] || echo "$i"
  done
}

# Running waiters queued before this one (an older wait file, or the same mtime and a lower pid) whose own
# load cap the current load meets: a waiter held back by a lower cap, or stopped, does not hold up the queue.
host_ahead() {
  local me=$HOST_LOCK_DIR/$host_pool.wait.$$ w p cap n=0
  for w in "$HOST_LOCK_DIR/$host_pool".wait.*; do
    p=${w##*.}
    if [ ! -f "$w" ] || [ "$p" = $$ ]; then continue; fi
    if [ "$w" -nt "$me" ] || { ! [ "$w" -ot "$me" ] && [ "$p" -gt $$ ]; }; then continue; fi
    read -r cap _ <"$w" 2>/dev/null || continue
    if awk -v l="$host_load" -v m="$cap" 'BEGIN { exit !(l <= m) }' && [ "$(host_holder "$p" "$w")" = alive ]; then n=$((n + 1)); fi
  done
  echo "$n"
}

# host_queue_msg <position> <busy>: the slot-wait line, naming each holder and how long it has held its slot.
host_queue_msg() {
  local i d who='' c a
  for i in $(seq 1 "$host_pool_slots"); do
    d=$HOST_LOCK_DIR/$host_pool.lock.$i
    [ -d "$d" ] || continue
    # A holder between its mkdir and its cmd file, or one just released, has nothing to show yet.
    c=$(head -n 1 "$d/cmd" 2>/dev/null | cut -c1-60)
    a=$(host_age "$d")
    who="${who:+$who; }${c:-starting} ${a:-0}s"
  done
  host_say "waiting for a $host_pool slot: position $1 in queue, $2/$host_pool_slots slots busy ($who)"
}

# Wait until load is under the pool's cap and this waiter is next (oldest wait file first), take a free slot,
# then re-check load and give the slot back if it rose. No slot is held while waiting, so idle waiters never
# fill the slots and a quiet machine is used within one poll. The pool is set by host_set_pool.
host_slot_acquire() {
  local i n said='' free ahead
  host_wait_start=$(date +%s)
  host_wait_file=$HOST_LOCK_DIR/$host_pool.wait.$$
  echo "$host_pool_cap $HOST_OWNER $*" >"$host_wait_file"
  while :; do
    if host_over_cap; then
      host_w_load=1
      [ "$said" = load ] || { said=load; host_say_load; }
      host_timed_out && host_gave_up_load
      host_sleep "$HOST_POLL_SECONDS"
      continue
    fi
    free=$(host_slot_free)
    ahead=$(host_ahead)
    n=0; for i in $free; do n=$((n + 1)); done
    if [ "$ahead" -lt "$n" ]; then
      for i in $free; do
        if mkdir "$HOST_LOCK_DIR/$host_pool.lock.$i" 2>/dev/null; then
          host_slot=$HOST_LOCK_DIR/$host_pool.lock.$i
          echo $$ >"$host_slot/pid"; echo "$HOST_OWNER $*" >"$host_slot/cmd"
          echo "load cap $host_pool_cap, $host_pool_slots slots" >"$host_slot/cap"
          break
        fi
      done
    fi
    if [ -n "$host_slot" ]; then
      host_over_cap || break
      rm -rf "$host_slot"; host_slot=''
      continue
    fi
    host_w_slot=1
    [ "$said" = "slot$ahead" ] || { said=slot$ahead; host_queue_msg $((ahead + 1)) $((host_pool_slots - n)); }
    host_timed_out && { host_say "gave up waiting for a $host_pool slot after ${HOST_LOCK_TIMEOUT_SECONDS}s"; exit 124; }
    host_sleep $((HOST_POLL_SECONDS < 2 ? HOST_POLL_SECONDS : 2))
  done
  host_wait_done
  rm -f "$host_wait_file"; host_wait_file=''
}

# Light commands take no slot and no queue place: they only wait while load is over the critical cap.
host_light_wait() {
  local said=''
  host_wait_start=$(date +%s)
  while host_over_cap; do
    host_w_load=1
    [ "$said" = load ] || { said=load; host_say_load; }
    host_timed_out && host_gave_up_load
    host_sleep "$HOST_POLL_SECONDS"
  done
  host_wait_done
}

# host_ident <pid>: the process's start time, which a later process reusing the pid does not share: /proc's
# starttime where /proc exists, else ps's lstart; empty when the pid is gone or neither can tell.
host_proc=/proc
host_ident() {
  if [ -r "$host_proc/self/stat" ]; then sed 's/.*) //' "$host_proc/$1/stat" 2>/dev/null | cut -d' ' -f20
  elif [ -n "$host_ps" ]; then ps -o lstart= -p "$1" 2>/dev/null
  fi
}

# host_watchdog <pid> <child>: once <pid> is gone while <child> runs, send TERM to <child>'s process tree.
# It ends by itself within a second of <child> ending and is never signalled: a bash 3.2 subshell that takes
# a TERM while its inherited TERM trap is half reset warns "run_pending_traps: bad value in trap_list". It
# outlives <pid> by that second, so it stops <child> only while the pid still names the process it started
# with, never one that reused it. It closes every inherited fd, so it holds no caller's pipe or jobserver.
# Every ~2 s it also records the command's descendants (pid and start time, from one ps snapshot) in
# heavy.tree.<pid>: a child in its own process group (envtest's kube-apiserver) escapes the group kill, and
# once the command dies it is reparented, so only this record can find it afterwards (host_reap).
host_watchdog() {
  local fd id now tick=0 tree=$HOST_LOCK_DIR/heavy.tree.$1
  for fd in /dev/fd/*; do
    fd=${fd##*/}
    if [ "$fd" -gt 2 ] 2>/dev/null; then eval "exec $fd>&-"; fi
  done
  exec </dev/null >/dev/null 2>&1
  [ -r "$host_proc/self/stat" ] || [ -n "$host_ps" ] || return 0 # cannot tell the command from a later process
  # A ps that fails once (fork EAGAIN under load) reads as empty: that is "gone" only if kill -0 agrees.
  until id=$(host_ident "$2"); [ -n "$id" ]; do kill -0 "$2" 2>/dev/null || return 0; sleep 1; done
  while now=$(host_ident "$2"); [ "$now" = "$id" ] || { [ -z "$now" ] && kill -0 "$2" 2>/dev/null; }; do
    # shellcheck disable=SC2046 # one pid per word
    if ! host_alive "$1"; then kill -TERM $(host_tree "$2") 2>/dev/null; host_reap "$1"; rm -f "$tree"; return; fi
    [ $((tick % 2)) -eq 0 ] && host_record_tree "$2" "$tree"
    tick=$((tick + 1))
    sleep 1
  done
}

# host_record_tree <root> <file>: append the "<pid> <lstart>" of each descendant of <root> not yet in <file>.
# A ps that fails or is missing records nothing.
host_record_tree() {
  [ -n "$host_ps" ] || return 0
  ps -A -o pid=,ppid=,lstart= 2>/dev/null | awk -v root="$1" -v f="$2" '
    BEGIN { while ((getline l < f) > 0) seen[l] = 1 }
    { up[$1] = $2; s = $3; for (i = 4; i <= NF; i++) s = s " " $i; st[$1] = s }
    END { t[root] = 1
      do { n = 0; for (p in up) if (!(p in t) && (up[p] in t)) { t[p] = 1; n++; k = p " " st[p]; if (!(k in seen)) print k } } while (n) }' >>"$2" 2>/dev/null
}

# host_reap <heavy.sh pid>: stop what the command left behind: each recorded process still alive with the
# same start time (a reused pid has another) gets TERM, then KILL after 2 s.
host_reap() {
  local file=$HOST_LOCK_DIR/heavy.tree.$1 pids p i n=0 alive
  [ -s "$file" ] && [ -n "$host_ps" ] || return 0
  pids=$(ps -A -o pid=,lstart= 2>/dev/null | awk -v f="$file" '
    BEGIN { while ((getline l < f) > 0) rec[l] = 1 }
    { s = $1; for (i = 2; i <= NF; i++) s = s " " $i; if (s in rec) print $1 }')
  [ -n "$pids" ] || return 0
  for p in $pids; do kill -TERM "$p" 2>/dev/null && n=$((n + 1)); done
  for i in 1 2 3 4 5 6 7 8 9 10; do
    alive=''
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ -n "$alive" ] || break
    sleep 0.2
  done
  for p in $pids; do kill -KILL "$p" 2>/dev/null; done
  [ "$n" -gt 0 ] && host_say "stopped $n processes the command left behind"
  return 0
}

# host_run <cmd...>: run the command and return its exit code. It runs in the background, so HUP, INT, QUIT
# and TERM are forwarded at once to its whole process tree (a trap waits for a foreground command, and the
# KILL that follows an unanswered TERM would leak the slot and orphan it). set -m around the start keeps INT
# and QUIT at their defaults and stdin as is: without job control, bash starts a background command with both
# ignored and stdin from /dev/null. The command gets its own process group, so a terminal's Ctrl+C reaches it
# through the forward; in a terminal, a command that reads it stops (SIGTTIN) and heavy.sh waits silently
# until ^C. A KILL to heavy.sh's group cannot be forwarded: a watchdog in a group of its own stops the
# command within a few seconds of heavy.sh going away.
host_run() {
  local code sig
  set -m
  "$@" &
  host_child=$!
  host_watchdog $$ "$host_child" &
  set +m
  for sig in HUP INT QUIT TERM; do
    # shellcheck disable=SC2064 # $sig expands now, the tree at signal time
    trap "kill -$sig \$(host_tree \"\$host_child\") 2>/dev/null" "$sig"
  done
  host_run_start=$(date +%s)
  while wait "$host_child"; code=$?; kill -0 "$host_child" 2>/dev/null; do :; done
  host_run_end=$(date +%s)
  # A failed command may have left processes in groups of their own; a successful one keeps what it started.
  [ "$code" -eq 0 ] || host_reap $$
  return "$code"
}

# Release only what this process holds: a waiter that gave up must never free the holder's slot.
host_slot_release() {
  [ -n "$host_sleeper" ] && kill "$host_sleeper" 2>/dev/null
  [ -n "$host_wait_file" ] && rm -f "$host_wait_file"
  rm -f "$HOST_LOCK_DIR/heavy.tree.$$"
  [ -n "$host_slot" ] && [ "$(host_slot_pid "$host_slot")" = $$ ] && rm -rf "$host_slot"
  host_slot=''
}

# host_finish: heavy.sh's EXIT trap (a timeout's 124 counts too): release, then report the wait and log the call.
# Logging never changes the exit code. host_cmd2 is the command's first two words, set by heavy.sh.
host_finish() {
  local code=$? reason='' ran=0 now
  host_slot_release
  host_wait_done
  [ -n "$host_w_load" ] && reason=load
  [ -n "$host_w_slot" ] && reason=${reason:+$reason+}slot
  [ -n "$reason" ] || host_wait_secs=0 # a clock tick across a second boundary is not a wait
  if [ "$host_wait_secs" -ge 1 ]; then
    if [ "$host_weight" = light ]; then host_say "waited ${host_wait_secs}s ($reason) for load"; else host_say "waited ${host_wait_secs}s ($reason) for a $host_pool slot"; fi
  fi
  if [ -n "$HOST_METRICS_FILE" ]; then
    if [ -n "$host_run_start" ]; then now=${host_run_end:-$(date +%s)}; ran=$((now - host_run_start)); fi
    {
      mkdir -p "$(dirname "$HOST_METRICS_FILE")" &&
        printf 'ts=%s weight=%s source=%s waited_s=%s wait=%s ran_s=%s exit=%s owner=%s cmd="%s"\n' \
          "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${host_weight:-heavy}" "${host_weight_source:-default}" "$host_wait_secs" "${reason:-none}" \
          "$ran" "$code" "$HOST_OWNER" "${host_cmd2:-}" >>"$HOST_METRICS_FILE"
    } 2>/dev/null
  fi
  return 0
}

host_services() {
  local s
  for s in "$HOST_LOCK_DIR"/host-services/*; do
    [ -f "$s" ] && echo "service: $(tr '\n' ' ' <"$s")$(host_alive "${s##*/}" || echo '(orphan entry)')"
  done
}

# host_status_pool <pool> <slot label> <waiter label>: the slots and the waiters of one pool.
host_status_pool() {
  local d w p state cap rest
  for d in "$HOST_LOCK_DIR/$1".lock.*; do
    case $d in *.stale.*) continue ;; esac
    [ -d "$d" ] || continue
    p=$(host_slot_pid "$d")
    case ${p:+$(host_holder "$p" "$d")} in alive) state='' ;; gone) state=', holder dead' ;; reused) state=', pid reused' ;; stopped) state=', holder stopped' ;; *) state=', no pid' ;; esac
    echo "$2 ${d##*.}: pid ${p:-none} $(cat "$d/cmd" 2>/dev/null) ($(cat "$d/cap" 2>/dev/null || echo 'cap unknown'), $(host_age "$d")s$state)"
  done
  for w in "$HOST_LOCK_DIR/$1".wait.*; do
    [ -f "$w" ] && host_alive "${w##*.}" "$w" && read -r cap rest <"$w" && echo "$3: pid ${w##*.} $rest (load cap $cap, $(host_age "$w")s)"
  done
}

host_status() {
  local d
  host_status_pool heavy slot waiting
  host_status_pool medium 'medium slot' 'waiting medium'
  for d in "$HOST_LOCK_DIR"/*.lease; do
    [ -f "$d" ] && echo "lease ${d##*/}: $(cat "$d")$(host_alive "$(host_lease_pid "$d")" "$d" || echo ' (stale)')"
  done
  host_services
  echo "load $(host_load1) (cap $HOST_LOAD_CAP, critical $HOST_CRITICAL_LOAD_CAP), slots $HOST_HEAVY_SLOTS, medium slots $HOST_MEDIUM_SLOTS"
}
