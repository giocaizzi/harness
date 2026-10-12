#!/usr/bin/env bash
# register-service.sh <name> [--] <command...>   run a long-lived service, registered while it runs
# register-service.sh --list                      print registered services; dead ones are orphan entries
#
# Writes $HOST_LOCK_DIR/host-services/<pid of this wrapper> (owner, name, service pid, start time,
# command) and removes it on exit, so other sessions can tell a claimed service from an orphan.
# TERM/INT/HUP to this wrapper stop the service too. Env: lib.sh (HOST_OWNER names the session).
set -u
. "$(dirname "$0")/lib.sh"

reg=$HOST_LOCK_DIR/host-services
if [ "${1:-}" = --list ]; then host_services; exit 0; fi
name=${1:-}; [ $# -gt 0 ] && shift
[ "${1:-}" = -- ] && shift
[ -n "$name" ] && [ $# -gt 0 ] || { echo "usage: register-service.sh <name> [--] <command...> | --list" >&2; exit 2; }

mkdir -p "$reg"
entry=$reg/$$
child=''
trap 'rm -f "$entry"' EXIT
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; wait "$child"; exit 143' TERM INT HUP
"$@" &
child=$!
printf 'owner=%s\nname=%s\npid=%s\nstarted=%s\ncmd=%s\n' \
  "$HOST_OWNER" "$name" "$child" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >"$entry"
wait "$child"
