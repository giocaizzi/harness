#!/usr/bin/env bash
# land-many.sh [--interval <s>] [--timeout <s>] <pr>...   land several approved PRs at once, never one after another
#
# Every poll (one per interval) walks all PRs still open, in the repo `gh repo view` names (GH_REPO selects
# another). A PR whose required checks (the base branch's rules, never a hardcoded name) passed on its current
# head is enqueued with the enqueuePullRequest mutation when its base has a merge queue, or gets
# `gh pr merge --auto --squash` once when it has none; a PR that falls out of the queue is enqueued again, up to
# LAND_MANY_REQUEUES (2) times. Nothing is bypassed. One line per PR, as soon as it ends:
#   PR <n>: MERGED <sha> | CLOSED | DIRTY | BEHIND | FAILED <why> | ERROR <gh error> | TIMEOUT <state>
# DIRTY is a conflict; BEHIND (only without a queue) needs the base merged in; ERROR is gh failing 3 polls in a row.
# Exits 0 when every PR merged, 1 otherwise, 2 on usage. Needs gh and jq.
# --interval (1-3600) and --timeout (1-86400) default to LAND_MANY_INTERVAL (30) and LAND_MANY_TIMEOUT (7200) seconds.
set -u
usage() { echo "usage: land-many.sh [--interval <1-3600 s>] [--timeout <1-86400 s>] <pr>..." >&2; exit 2; }
seconds() { case $1 in [1-9]|[1-9][0-9]|[1-9][0-9][0-9]|[1-9][0-9][0-9][0-9]|[1-9][0-9][0-9][0-9][0-9]) [ "$1" -le "$2" ] || usage ;; *) usage ;; esac; }
interval=${LAND_MANY_INTERVAL:-30} timeout=${LAND_MANY_TIMEOUT:-7200} requeues=${LAND_MANY_REQUEUES:-2}
prs=()
while [ $# -gt 0 ]; do
  case $1 in
    --interval) [ $# -ge 2 ] || usage; interval=$2; shift ;;
    --timeout) [ $# -ge 2 ] || usage; timeout=$2; shift ;;
    [1-9]|[1-9][0-9]*) case $1 in *[!0-9]*) usage ;; esac; prs+=("$1") ;;
    *) usage ;;
  esac
  shift
done
[ ${#prs[@]} -gt 0 ] || usage
seconds "$interval" 3600
seconds "$timeout" 86400
case $requeues in [0-9]) ;; *) usage ;; esac

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || { echo "land-many: gh repo view failed" >&2; exit 1; }
owner=${repo%/*} name=${repo#*/}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# shellcheck disable=SC2016 # GraphQL variables, not shell ones
query='query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
id state mergeStateStatus headRefOid baseRefName isInMergeQueue isMergeQueueEnabled mergeCommit{oid}
statusCheckRollup{contexts(first:100){nodes{__typename
... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}'
# One tab-separated line: state merge head id base queued queue sha, then the rollup as name<US>bucket<US>link<RS>...
flat='.data.repository.pullRequest | [.state, .mergeStateStatus, .headRefOid, .id, .baseRefName,
  (.isInMergeQueue | tostring), (.isMergeQueueEnabled | tostring), (.mergeCommit.oid // "-"),
  ([(.statusCheckRollup.contexts.nodes // [])[] | if .__typename == "CheckRun"
    then [.name, (if .status != "COMPLETED" then "pending" elif (.conclusion | IN("SUCCESS", "NEUTRAL", "SKIPPED")) then "pass" else "fail" end), (.detailsUrl // "")]
    else [.context, (if .state == "SUCCESS" then "pass" elif (.state | IN("PENDING", "EXPECTED")) then "pending" else "fail" end), (.targetUrl // "")] end
    | join("\u001f")] | join("\u001e"))] | @tsv'
# required <base>: the required check names on that branch, one per line, cached per run.
required() {
  local f; f="$tmp/req-$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' _)"
  if [ ! -f "$f" ]; then
    gh api "repos/$repo/rules/branches/$1" \
      --jq '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | unique | .[]' >"$f.new" 2>"$tmp/err" || return 1
    mv "$f.new" "$f"
  fi
  cat "$f"
}
# verdict <rollup> <required names>: "pass", "pending <names>" or "fail <name link, ...>"; a missing check is pending.
verdict() {
  printf '%s' "$1" | jq -Rr --arg req "$2" '
    [split("\u001e")[] | select(. != "") | split("\u001f") | {name: .[0], s: .[1], link: .[2]}] as $c
    | [$req | split("\n")[] | select(. != "") as $r
       | [$c[] | select(.name == $r)] | if length == 0 then {name: $r, s: "pending", link: ""}
         elif any(.s == "fail") then (map(select(.s == "fail")) | .[0])
         elif any(.s == "pending") then {name: $r, s: "pending", link: ""} else {name: $r, s: "pass", link: ""} end] as $v
    | if any($v[]; .s == "fail") then "fail " + ([$v[] | select(.s == "fail") | (.name + " " + .link)] | join(", "))
      elif any($v[]; .s == "pending") then "pending " + ([$v[] | select(.s == "pending") | .name] | join(","))
      else "pass" end'
}

n=${#prs[@]} left=$n status=0
done_=() enq=() fails=() armed=() last=()
for ((i = 0; i < n; i++)); do done_[i]=0 enq[i]=0 fails[i]=0 armed[i]=0 last[i]='unknown'; done
finish() { echo "PR ${prs[$1]}: $2"; done_[$1]=1 left=$((left - 1)); case $2 in MERGED*) ;; *) status=1 ;; esac; }
# strike <i>: one more gh failure in a row for that PR; the third ends it with the error.
strike() { fails[$1]=$((fails[$1] + 1)); [ "${fails[$1]}" -lt 3 ] || finish "$1" "ERROR $(head -n 1 "$tmp/err")"; }
deadline=$(($(date +%s) + timeout))
while :; do
  for ((i = 0; i < n; i++)); do
    [ "${done_[i]}" = 0 ] || continue
    pr=${prs[i]}
    if ! gh api graphql -f query="$query" -f owner="$owner" -f name="$name" -F n="$pr" >"$tmp/out" 2>"$tmp/err" \
      || ! line=$(jq -er "$flat" <"$tmp/out" 2>>"$tmp/err"); then strike "$i"; continue; fi
    IFS=$'\t' read -r state merge head id base queued queue sha rollup <<<"$line"
    last[i]="$state $merge"
    case $state in
      MERGED) finish "$i" "MERGED $sha"; continue ;;
      CLOSED) finish "$i" "CLOSED"; continue ;;
    esac
    [ "$merge" != DIRTY ] || { finish "$i" "DIRTY"; continue; }
    [ "$merge" != BEHIND ] || [ "$queue" = true ] || { finish "$i" "BEHIND"; continue; }
    req=$(required "$base") || { strike "$i"; continue; }
    v=$(verdict "$rollup" "$req")
    case $v in
      fail*) finish "$i" "FAILED required check ${v#fail }"; continue ;;
      pending*) last[i]="$state $merge, pending: ${v#pending }"; fails[i]=0; continue ;;
    esac
    if [ "$queue" = true ]; then
      [ "$queued" = false ] || { fails[i]=0; continue; }
      if [ "${enq[i]}" -gt "$requeues" ]; then finish "$i" "FAILED left the merge queue ${enq[i]} times (read its merge_group run)"; continue; fi
      # shellcheck disable=SC2016
      gh api graphql -f query='mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{position}}}' \
        -f id="$id" -f head="$head" >/dev/null 2>"$tmp/err" || { strike "$i"; continue; }
      enq[i]=$((enq[i] + 1)) last[i]="$state $merge, queued"
    elif [ "${armed[i]}" = 0 ]; then
      gh pr merge "$pr" --auto --squash --match-head-commit "$head" >/dev/null 2>"$tmp/err" || { strike "$i"; continue; }
      armed[i]=1 last[i]="$state $merge, auto-merge armed"
    fi
    fails[i]=0
  done
  [ "$left" -gt 0 ] || exit "$status"
  wait_left=$((deadline - $(date +%s)))
  if [ "$wait_left" -le 0 ]; then
    for ((i = 0; i < n; i++)); do [ "${done_[i]}" = 1 ] || finish "$i" "TIMEOUT after ${timeout}s, ${last[i]}"; done
    exit "$status"
  fi
  sleep $((interval < wait_left ? interval : wait_left))
done
