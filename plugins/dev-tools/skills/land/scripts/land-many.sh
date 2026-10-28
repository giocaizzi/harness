#!/usr/bin/env bash
# land-many.sh [--interval <s>] [--timeout <s>] <pr>...   land several approved PRs at once, never one after another
#
# Every poll (one per interval) walks all PRs still open, in the repo `gh repo view` names (GH_REPO selects
# another). A PR whose required checks (the base branch's rulesets and classic protection, never a hardcoded name)
# passed on its current head, with no check failing and no GitHub Actions run on that head still running (WAITING
# counts; app check suites without a workflow run do not), is enqueued with the enqueuePullRequest mutation when its
# base has a merge queue, or gets `gh pr merge --auto --squash` once when it has none; where auto-merge is not
# allowed, it is merged directly once every check passed. A PR that falls out of the queue is enqueued again, up to
# LAND_MANY_REQUEUES (2) times. gh refusing with `Required status check ... is expected` is waited on like a pending
# check, never counted as a gh failure. A PR in a stack, which gh refuses with `part of a stack`, goes through the
# asynchronous merge REST API instead (PUT pulls/<n>/merge-async with the head sha: merge_queue with a queue, else
# default with squash), which lands the stack up to that PR atomically; the refusal is never a gh failure, and the
# request is polled until merged, enqueued or failed. Nothing is bypassed. One line per PR, as soon as it ends:
#   PR <n>: MERGED <sha> | CLOSED | DIRTY | BEHIND | STACKED <base> | FAILED <why> | ERROR <gh error> | TIMEOUT <state>
# DIRTY is a conflict; BEHIND (only without a queue) needs the base merged in; STACKED is a PR based on another
# branch than the default one (land it with `gh stack merge`, or retarget it as `land` step 3 says); ERROR is gh
# failing 3 polls in a row; TIMEOUT names what it waited on (pending required checks, running workflows, gh's
# refusal, a merge-async request still pending). Exits 0 when every PR merged, 1 otherwise, 2 on usage. Needs gh and jq.
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

view=$(gh repo view --json nameWithOwner,defaultBranchRef --jq '.nameWithOwner + " " + .defaultBranchRef.name') \
  || { echo "land-many: gh repo view failed" >&2; exit 1; }
repo=${view% *} default=${view#* }
owner=${repo%/*} name=${repo#*/}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
api_version=2026-03-10 # the REST version whose docs define merge-async

# shellcheck disable=SC2016 # GraphQL variables, not shell ones
query='query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
id state mergeStateStatus headRefOid baseRefName isInMergeQueue isMergeQueueEnabled mergeCommit{oid}
commits(last:1){nodes{commit{checkSuites(first:100){nodes{status workflowRun{workflow{name}}}}}}}
statusCheckRollup{contexts(first:100){nodes{__typename
... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}'
# One tab-separated line: state merge head id base queued queue sha, the workflows still running on the head
# (comma-separated, "-" for none: an empty field would collapse), then the rollup as name<US>bucket<US>link<RS>...
flat='.data.repository.pullRequest | [.state, .mergeStateStatus, .headRefOid, .id, .baseRefName,
  (.isInMergeQueue | tostring), (.isMergeQueueEnabled | tostring), (.mergeCommit.oid // "-"),
  ([(.commits.nodes[0].commit.checkSuites.nodes // [])[] | select(.workflowRun != null and .status != "COMPLETED")
    | .workflowRun.workflow.name] | unique | if length == 0 then "-" else join(",") end),
  ([(.statusCheckRollup.contexts.nodes // [])[] | if .__typename == "CheckRun"
    then [.name, (if .status != "COMPLETED" then "pending" elif (.conclusion | IN("SUCCESS", "NEUTRAL", "SKIPPED")) then "pass" else "fail" end), (.detailsUrl // "")]
    else [.context, (if .state == "SUCCESS" then "pass" elif (.state | IN("PENDING", "EXPECTED")) then "pending" else "fail" end), (.targetUrl // "")] end
    | join("\u001f")] | join("\u001e"))] | @tsv'
# required <base>: the required check names on that branch (rulesets and classic protection), one per line, cached.
required() {
  local f; f="$tmp/req-$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' _)"
  if [ ! -f "$f" ]; then
    gh api "repos/$repo/rules/branches/$1" \
      --jq '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context' >"$f.new" 2>"$tmp/err" || return 1
    gh api "repos/$repo/branches/$1" --jq '.protection.required_status_checks.contexts // [] | .[]' >>"$f.new" 2>"$tmp/err" || return 1
    sort -u "$f.new" >"$f"
  fi
  cat "$f"
}
# verdict <rollup> <required names>: "fail <name link, ...>" when any check on the head failed, else
# "pending <names>" while a required one is pending or missing, else "pass" (every check passed) or "pass-required".
verdict() {
  printf '%s' "$1" | jq -Rr --arg req "$2" '
    [split("\u001e")[] | select(. != "") | split("\u001f") | {name: .[0], s: .[1], link: .[2]}] as $c
    | [$req | split("\n")[] | select(. != "")] as $r
    | if any($c[]; .s == "fail") then "fail " + ([$c[] | select(.s == "fail") | (.name + " " + .link)] | join(", "))
      else [$r[] as $n | select(([$c[] | select(.name == $n and .s == "pass")] | length) == 0 or any($c[]; .name == $n and .s == "pending")) | $n] as $p
      | if ($p | length) > 0 then "pending " + ($p | join(","))
        elif any($c[]; .s == "pending") then "pass-required" else "pass" end end'
}

n=${#prs[@]} left=$n status=0
done_=() enq=() fails=() armed=() last=() stacked=() uuid=()
for ((i = 0; i < n; i++)); do done_[i]=0 enq[i]=0 fails[i]=0 armed[i]=0 last[i]='unknown' stacked[i]=0 uuid[i]=-; done
finish() { echo "PR ${prs[$1]}: $2"; done_[$1]=1 left=$((left - 1)); case $2 in MERGED*) ;; *) status=1 ;; esac; }
# expected <i>: true when gh refused because a required check is not reported yet; the PR then waits like a pending one.
expected() {
  grep -q 'Required status check .* is expected' "$tmp/err" || return 1
  last[$1]="$state $merge, waiting: $(head -n 1 "$tmp/err")" fails[$1]=0
}
# strike <i>: one more gh failure in a row for that PR; the third ends it with the error.
strike() { fails[$1]=$((fails[$1] + 1)); [ "${fails[$1]}" -lt 3 ] || finish "$1" "ERROR $(head -n 1 "$tmp/err")"; }
# stack_refused: true when gh refused because the PR is part of a stack, which only merge-async can land.
stack_refused() { grep -q 'part of a stack' "$tmp/err"; }
# async_result <i>: act on the merge-async reply in $tmp/async (the request or a poll of it): pending keeps its uuid,
# enqueued counts as one enqueue, merged and failed end the PR; a reply without a status is a strike. A 409 (a request
# already pending) carries that request's uuid, so gh failing is read the same way.
async_result() {
  local r s u m c
  r=$(jq -r '(.details.uuid // .uuid // "-") as $u | [(.status // (if $u != "-" then "pending" else "-" end)), $u,
    (.details.message // .message // "-"), (.details.sha // "-")] | @tsv' "$tmp/async" 2>/dev/null) || r=-
  IFS=$'\t' read -r s u m c <<<"$r"
  case $s in
    pending) uuid[$1]=$u last[$1]="$state $merge, merge-async pending $u" ;;
    enqueued) uuid[$1]=- enq[$1]=$((enq[$1] + 1)) last[$1]="$state $merge, queued through merge-async" ;;
    merged) finish "$1" "MERGED $c" ;;
    failed) finish "$1" "FAILED merge-async: $m" ;;
    *) [ -s "$tmp/err" ] || echo "merge-async: unexpected reply $(head -c 200 "$tmp/async")" >"$tmp/err"; strike "$1"; return ;;
  esac
  fails[$1]=0
}
# merge_async <i>: request the asynchronous merge of that PR's head (enqueue with a queue, else the default action).
merge_async() {
  local action=(-f merge_action=merge_queue)
  [ "$queue" = true ] || action=(-f merge_action=default -f merge_method=squash)
  stacked[$1]=1 armed[$1]=async
  gh api -X PUT "repos/$repo/pulls/${prs[$1]}/merge-async" -H "X-GitHub-Api-Version: $api_version" \
    "${action[@]}" -f sha="$head" >"$tmp/async" 2>"$tmp/err"
  async_result "$1"
}
deadline=$(($(date +%s) + timeout))
while :; do
  for ((i = 0; i < n; i++)); do
    [ "${done_[i]}" = 0 ] || continue
    pr=${prs[i]}
    if ! gh api graphql -f query="$query" -f owner="$owner" -f name="$name" -F n="$pr" >"$tmp/out" 2>"$tmp/err" \
      || ! line=$(jq -er "$flat" <"$tmp/out" 2>>"$tmp/err"); then strike "$i"; continue; fi
    IFS=$'\t' read -r state merge head id base queued queue sha runs rollup <<<"$line"
    last[i]="$state $merge"
    case $state in
      MERGED) finish "$i" "MERGED $sha"; continue ;;
      CLOSED) finish "$i" "CLOSED"; continue ;;
    esac
    # A merge-async request still pending: poll it until it ends.
    if [ "${uuid[i]}" != - ]; then
      gh api "repos/$repo/pulls/$pr/merge-async/${uuid[i]}" -H "X-GitHub-Api-Version: $api_version" >"$tmp/async" 2>"$tmp/err"
      async_result "$i"; continue
    fi
    [ "$base" = "$default" ] || { finish "$i" "STACKED on $base: land it with gh stack merge, or retarget it (land step 3)"; continue; }
    [ "$merge" != DIRTY ] || { finish "$i" "DIRTY"; continue; }
    [ "$merge" != BEHIND ] || [ "$queue" = true ] || { finish "$i" "BEHIND"; continue; }
    req=$(required "$base") || { strike "$i"; continue; }
    v=$(verdict "$rollup" "$req")
    case $v in
      fail*) finish "$i" "FAILED check ${v#fail }"; continue ;;
      pending*) last[i]="$state $merge, pending: ${v#pending }"; fails[i]=0; continue ;;
    esac
    # Any workflow run on the head still running holds the PR, even with every required check green.
    [ "$runs" = - ] || { last[i]="$state $merge, running: $runs"; fails[i]=0; continue; }
    if [ "$queue" = true ]; then
      [ "$queued" = false ] || { fails[i]=0; continue; }
      if [ "${enq[i]}" -gt "$requeues" ]; then finish "$i" "FAILED left the merge queue ${enq[i]} times (read its merge_group run)"; continue; fi
      [ "${stacked[i]}" = 0 ] || { merge_async "$i"; continue; }
      # shellcheck disable=SC2016
      gh api graphql -f query='mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{position}}}' \
        -f id="$id" -f head="$head" >/dev/null 2>"$tmp/err" || { if stack_refused; then merge_async "$i"; else expected "$i" || strike "$i"; fi; continue; }
      enq[i]=$((enq[i] + 1)) last[i]="$state $merge, queued"
    elif [ "${armed[i]}" = 0 ]; then
      if ! gh pr merge "$pr" --auto --squash --match-head-commit "$head" >/dev/null 2>"$tmp/err"; then
        if stack_refused; then merge_async "$i"; continue; fi
        grep -q 'Auto merge is not allowed' "$tmp/err" || { expected "$i" || strike "$i"; continue; }
        armed[i]=direct
      else
        armed[i]=1 last[i]="$state $merge, auto-merge armed"
      fi
    fi
    # Auto-merge unavailable: merge directly once every check on the head passed, as `land` step 4 does.
    if [ "${armed[i]}" = direct ]; then
      [ "$v" = pass ] || { last[i]="$state $merge, waiting for every check before a direct merge"; fails[i]=0; continue; }
      gh pr merge "$pr" --squash --match-head-commit "$head" >/dev/null 2>"$tmp/err" || { if stack_refused; then merge_async "$i"; else expected "$i" || strike "$i"; fi; continue; }
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
