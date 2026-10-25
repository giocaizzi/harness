#!/usr/bin/env bash
# attended.sh <owner>/<repo>#<number> [--] <harness command...>
#   Start an attended ticket-run session tagged like a runtime's runs: sets FACTORY_ATTENDED_RUN_ID
#   and FACTORY_ATTENDED_TICKET (ticket-run copies the id into result.json and its claim), and
#   appends factory.run_id, factory.ticket, factory.role=main and factory.mode=attended to
#   OTEL_RESOURCE_ATTRIBUTES and its GUARD_OTEL_RESOURCE_ATTRIBUTES copy, then runs the command.
#   Any factory.* pair already there is replaced (keys match case-sensitively, as OTel keys do); the other
#   pairs are kept, trimmed of surrounding whitespace. Example: attended.sh acme/app#12 claude
set -u
set -f # the attribute lists are split on commas, never globbed

usage() { echo "usage: attended.sh <owner>/<repo>#<number> [--] <harness command...>" >&2; exit 2; }
ticket=${1:-}; [ $# -gt 0 ] && shift
[ "${1:-}" = -- ] && shift
if [ -z "$ticket" ] || [ $# -eq 0 ]; then usage; fi
# Only these characters, so no value needs percent-encoding in the attribute list.
[[ $ticket =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#([0-9]+)$ ]] || { echo "attended: '$ticket' is not <owner>/<repo>#<number>" >&2; exit 2; }
number=${BASH_REMATCH[1]}
if [ -n "${FACTORY_RUN_ID:-}" ]; then echo "attended: FACTORY_RUN_ID is set, so this is a runtime's run, not an attended one" >&2; exit 2; fi

host=''
if command -v hostname >/dev/null 2>&1; then host=$(hostname -s 2>/dev/null || hostname 2>/dev/null); fi
[ -n "$host" ] || host=$(uname -n 2>/dev/null)
[ -n "$host" ] || host=${HOSTNAME:-host}
host=${host%%.*}
run_id="$host-$number-$(date -u +%Y%m%dT%H%M%SZ)"
tags="factory.run_id=$run_id,factory.ticket=$ticket,factory.role=main,factory.mode=attended"

# The pairs of $1 without factory.*, then the run's tags.
tag() {
  local kept='' pair
  local IFS=,
  for pair in $1; do
    pair=${pair#"${pair%%[![:space:]]*}"}
    pair=${pair%"${pair##*[![:space:]]}"}
    case $pair in factory.*=* | '') ;; *) kept="$kept$pair," ;; esac
  done
  printf '%s%s' "$kept" "$tags"
}

OTEL_RESOURCE_ATTRIBUTES=$(tag "${OTEL_RESOURCE_ATTRIBUTES:-}")
GUARD_OTEL_RESOURCE_ATTRIBUTES=$(tag "${GUARD_OTEL_RESOURCE_ATTRIBUTES:-}")
export FACTORY_ATTENDED_RUN_ID=$run_id FACTORY_ATTENDED_TICKET=$ticket OTEL_RESOURCE_ATTRIBUTES GUARD_OTEL_RESOURCE_ATTRIBUTES
echo "attended: run $run_id for $ticket" >&2
exec "$@"
