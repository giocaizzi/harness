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
# --interval and --timeout default to WAIT_PR_INTERVAL (45) and WAIT_PR_TIMEOUT (5400) seconds.
# The deadline is the script's own: exiting is what wakes a session that started it in the background.
set -u
usage() { echo "usage: wait-pr.sh <pr> [--interval <s>] [--timeout <s>]" >&2; exit 2; }
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
case $interval$timeout in *[!0-9]*|'') usage ;; esac

err=$(mktemp); trap 'rm -f "$err"' EXIT
deadline=$(($(date +%s) + timeout)) fails=0 state='' merge='' pending=''
while :; do
  if view=$(gh pr view "$pr" --json state,mergeStateStatus --jq '.state + " " + .mergeStateStatus' 2>"$err"); then
    fails=0 state=${view%% *} merge=${view#* }
    case $state in
      MERGED) echo "PR $pr merged"; exit 0 ;;
      CLOSED) echo "PR $pr closed without merging"; exit 1 ;;
    esac
    # Exits non-zero while checks are pending or failed, and prints nothing when the PR has none: read the output only.
    checks=$(gh pr checks "$pr" --required --json name,bucket,link \
      --jq '.[] | select(.bucket == "fail" or .bucket == "cancel" or .bucket == "pending") | .bucket + " " + .name + " " + .link' 2>/dev/null)
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
    if [ "$fails" -ge 3 ]; then echo "wait-pr: gh pr view $pr failed $fails times in a row:" >&2; cat "$err" >&2; exit 5; fi
  fi
  left=$((deadline - $(date +%s)))
  if [ "$left" -le 0 ]; then
    echo "PR $pr: timed out after ${timeout}s, state ${state:-unknown}, mergeStateStatus ${merge:-unknown}, pending required checks: ${pending:-none}"
    exit 124
  fi
  sleep $((interval < left ? interval : left))
done
