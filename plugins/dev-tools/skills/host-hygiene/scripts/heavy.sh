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
host_run "$@"
