#!/usr/bin/env bash
# heavy.sh [--] <command...>   run a command holding a machine-wide heavy slot
# heavy.sh --status            print slots, waiters, leases and registered services
#
# Refuses on low disk; waits (with a timeout) for a slot and for load. Env and paths: lib.sh.
set -u
. "$(dirname "$0")/lib.sh"

if [ "${1:-}" = --status ]; then host_status; exit 0; fi
[ "${1:-}" = -- ] && shift
[ $# -gt 0 ] || { echo "usage: heavy.sh [--] <command...> | --status" >&2; exit 2; }

host_disk_check
trap host_slot_release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
host_slot_acquire "$@"
# The command runs in the background, so a TERM or INT is forwarded at once (a trap waits for a foreground
# command, and the KILL that follows an unanswered TERM would leak the slot and orphan it), to its whole
# process tree: without a terminal, set -m gives it no process group of its own. fd 3 keeps stdin, which
# a background command would otherwise get as /dev/null.
{ exec 3<&0; } 2>/dev/null || exec 3</dev/null
"$@" <&3 3<&- &
child=$!
trap 'kill -INT $(host_tree "$child") 2>/dev/null' INT
trap 'kill -TERM $(host_tree "$child") 2>/dev/null' TERM
while wait "$child"; code=$?; kill -0 "$child" 2>/dev/null; do :; done
exit "$code"
