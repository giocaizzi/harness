#!/usr/bin/env bash
# wait-pr.sh <pr> [--interval <s>] [--timeout <s>]   wait on a PR until it ends, whichever way it ends
#
# Polls `gh pr view` and `gh pr checks --required` once per interval (GH_REPO selects another repo)
# and exits on the first terminal outcome, printing one line on what happened:
#   0    merged
#   1    closed without merging
#   3    a required check failed or was cancelled (each one's name and link follow)
#   4    mergeStateStatus BEHIND (update the branch) or DIRTY (resolve the conflict)
#   5    `gh pr view` failed 3 polls in a row (bad PR, auth, network; its error follows)
#   124  timeout, with the last state and the required checks still pending
#   2    usage
# --interval (1-3600) and --timeout (1-86400) default to WAIT_PR_INTERVAL (45) and WAIT_PR_TIMEOUT (5400) seconds.
# The deadline is the script's own: exiting is what wakes a session that started it in the background.
# The poll that falls on the deadline still runs. A gh call still running 5 s after the deadline, or after its
# own start when that is later, is killed with its children, and the timeout line names it.
set -u
usage() { echo "usage: wait-pr.sh <pr> [--interval <1-3600 s>] [--timeout <1-86400 s>]" >&2; exit 2; }
# seconds <value> <max>: a plain decimal integer from 1 to max (no sign, no leading zero, which bash reads as octal).
seconds() { case $1 in [1-9]|[1-9][0-9]|[1-9][0-9][0-9]|[1-9][0-9][0-9][0-9]|[1-9][0-9][0-9][0-9][0-9]) [ "$1" -le "$2" ] || usage ;; *) usage ;; esac; }
pr='' interval=${WAIT_PR_INTERVAL:-45} timeout=${WAIT_PR_TIMEOUT:-5400}
while [ $# -gt 0 ]; do
  case $1 in
    --interval) [ $# -ge 2 ] || usage; interval=$2; shift ;;
    --timeout) [ $# -ge 2 ] || usage; timeout=$2; shift ;;
    -*) usage ;;
    *) [ -z "$pr" ] || usage; pr=$1 ;;
  esac
  shift
done
[ -n "$pr" ] || usage
seconds "$interval" 3600
seconds "$timeout" 86400

grace=5 call=''
tmp=$(mktemp -d)
# tree <pid>: the pid and its descendants.
tree() { local c; echo "$1"; for c in $(ps -A -o pid=,ppid= | awk -v p="$1" '$2 == p { print $1 }'); do tree "$c"; done; }
# stop_call: TERM the running gh call and its children, KILL what is left after 1 s.
stop_call() {
  [ -n "$call" ] || return 0
  local pids n=0; pids=$(tree "$call")
  # shellcheck disable=SC2086 # one pid per word
  kill $pids 2>/dev/null
  while kill -0 "$call" 2>/dev/null && [ "$n" -lt 10 ]; do sleep 0.1; n=$((n + 1)); done
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null
  wait "$call" 2>/dev/null; call=''
}
trap 'stop_call; rm -rf "$tmp"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
deadline=$(($(date +%s) + timeout)) fails=0 state='' merge='' pending=''
timed_out() {
  echo "PR $pr: timed out after ${timeout}s, state ${state:-unknown}, mergeStateStatus ${merge:-unknown}, pending required checks: ${pending:-none}${1:+ ($1 did not return)}"
  exit 124
}
# gh_call <label> <args...>: gh's stdout in $tmp/out, stderr in $tmp/err, its status returned.
gh_call() {
  local label=$1 limit; shift
  limit=$(date +%s); limit=$((limit > deadline ? limit : deadline)); limit=$((limit + grace))
  gh "$@" >"$tmp/out" 2>"$tmp/err" &
  call=$!
  while kill -0 "$call" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$limit" ]; then stop_call; timed_out "$label"; fi
    sleep 0.1
  done
  local rc=0; wait "$call" || rc=$?
  call=''
  return "$rc"
}
while :; do
  if gh_call "gh pr view" pr view "$pr" --json state,mergeStateStatus --jq '.state + " " + .mergeStateStatus'; then
    view=$(cat "$tmp/out")
    fails=0 state=${view%% *} merge=${view#* }
    case $state in
      MERGED) echo "PR $pr merged"; exit 0 ;;
      CLOSED) echo "PR $pr closed without merging"; exit 1 ;;
    esac
    # Exits non-zero while checks are pending or failed, and prints nothing when the PR has none: read the output only.
    gh_call "gh pr checks" pr checks "$pr" --required --json name,bucket,link \
      --jq '.[] | select(.bucket == "fail" or .bucket == "cancel" or .bucket == "pending") | .bucket + " " + .name + " " + .link'
    checks=$(cat "$tmp/out")
    failed=$(printf '%s\n' "$checks" | sed -En 's/^(fail|cancel) //p')
    if [ -n "$failed" ]; then
      echo "PR $pr: required check failed"; printf '%s\n' "$failed" | sed 's/^/  /'; exit 3
    fi
    pending=$(printf '%s\n' "$checks" | sed -n 's/^pending \(.*\) [^ ]*$/\1/p' | paste -sd, -)
    case $merge in
      BEHIND) echo "PR $pr is behind its base: update the branch"; exit 4 ;;
      DIRTY) echo "PR $pr has a merge conflict: resolve it"; exit 4 ;;
    esac
  else
    fails=$((fails + 1))
    if [ "$fails" -ge 3 ]; then echo "wait-pr: gh pr view $pr failed $fails times in a row:" >&2; cat "$tmp/err" >&2; exit 5; fi
  fi
  left=$((deadline - $(date +%s)))
  [ "$left" -gt 0 ] || timed_out
  sleep $((interval < left ? interval : left)) & wait $!  # a signal is handled at once, not after the sleep
done
