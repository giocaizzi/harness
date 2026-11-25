#!/usr/bin/env bash
# heavy.sh [--] <command...>   run a command under its weight class: heavy (the heavy slots), medium (a wider
#                              pool) or light (no slot); the class comes from the repo's .heavy-weights, then weights.default
# heavy.sh --classify [--] <command...>   print "<class> <source>" and run nothing
# heavy.sh --status            print slots, waiters, leases and registered services
#
# Refuses on low disk; waits (with a timeout) for a slot and for load. Env and paths: lib.sh.
set -u
. "$(dirname "$0")/lib.sh"

usage() { echo "usage: heavy.sh [--] <command...> | --classify [--] <command...> | --status" >&2; exit 2; }
if [ "${1:-}" = --status ]; then host_status; exit 0; fi
if [ "${1:-}" = --classify ]; then
  shift
  [ "${1:-}" = -- ] && shift
  [ $# -gt 0 ] || usage
  host_classify "$@"
  echo "$host_weight $host_weight_source"
  exit 0
fi
[ "${1:-}" = -- ] && shift
[ $# -gt 0 ] || usage

host_disk_check
host_classify "$@"
# Only the first two words are ever logged: the rest may carry secrets.
host_cmd2=${2:+$1 $2}
host_cmd2=${host_cmd2:-$1}
host_cmd2=${host_cmd2//\"/}
trap host_finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM
host_set_pool "$host_weight"
if [ "$host_weight" = light ]; then host_light_wait; else host_slot_acquire "$@"; fi
host_run "$@"
