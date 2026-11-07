# CI cost: measure, then cut

Every change is tested up to three times (on the PR, in the merge queue, on the push to the default branch), and every push to a PR runs its CI again. Measure where the minutes go before changing a workflow, and compare each figure with the repo's own previous window, never with a fixed budget.

Both views below are read-only. They call `gh` with arguments only (no `eval`, no token on a command line or in output), and print counts and minutes, never repository names, run URLs or logs. Run them from inside the repo, where `gh` fills in `{owner}/{repo}`; keep anything that names a repository local, out of every PR, issue and committed file.

## Billed minutes (billing usage API)

The enhanced billing platform reports usage per day, product and SKU (one SKU per runner type). It needs billing read access to the account: your own user, or an organization you administer. Through `gh`, the user endpoints need the `user` scope (`gh auth refresh -h github.com -s user`) and answer 404, not 403, without it. Check the endpoints against the [billing usage docs](https://docs.github.com/en/rest/billing/usage) first; they are recent and change.

```bash
login=$(gh api user --jq .login)
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
year=$(date -u +%Y) month=$(date -u +%-m)  # the current month; set both for another one
# This repo, one month, Actions minutes per SKU (summary endpoint, public preview):
gh api -X GET "users/$login/settings/billing/usage/summary" \
  -f year="$year" -f month="$month" -f product=actions -f repository="$repo" \
  --jq '.usageItems[] | [.sku, .grossQuantity, .unitType, .netAmount] | @tsv'
# Every repository on the account, summed per SKU (no names printed):
gh api -X GET "users/$login/settings/billing/usage" -f year="$year" -f month="$month" \
  --jq '[.usageItems[] | select(.product | ascii_downcase == "actions")]
        | group_by(.sku)[] | [.[0].sku, (map(.quantity) | add), (map(.netAmount) | add)] | @tsv'
```

Minutes are the gross quantity (`grossQuantity`, `quantity`): the net quantity is what is left after the plan's included minutes, often 0. The amount is net, what was billed.

For an organization the paths are `organizations/<org>/settings/billing/usage` and `.../usage/summary`. Standard runners on public repositories are free and may report no billed minutes; measure them with the runs API below. The per-run `actions/runs/<id>/timing` endpoint is closing down: don't build on it.

## Minutes per workflow and event (runs and jobs APIs)

Billing counts each job, rounded up to a whole minute, and every re-run attempt, per runner type. The same sum from the jobs of every run in a window:

```bash
d=$(mktemp -d)  # scratch files outside the working tree
since=$(date -u -d '30 days ago' +%F 2>/dev/null || date -u -v-30d +%F)  # GNU, then BSD date
gh api -X GET 'repos/{owner}/{repo}/actions/runs' -f created=">=$since" -f per_page=1 --jq .total_count
gh api --paginate -X GET 'repos/{owner}/{repo}/actions/runs' -f created=">=$since" -f per_page=100 \
  --jq '.workflow_runs[] | [.id, .path, .event] | @tsv' > "$d/runs.tsv"
cut -f1 "$d/runs.tsv" | while read -r id; do
  gh api --paginate -X GET "repos/{owner}/{repo}/actions/runs/$id/jobs" -f filter=all -f per_page=100 \
    --jq '.jobs[] | select(.started_at != null and .completed_at != null and .conclusion != "skipped")
          | [.run_id, ([0, ((.completed_at | fromdate) - (.started_at | fromdate))] | max / 60 | ceil), (.labels[0] // "unknown")] | @tsv' \
    || echo "$id" >> "$d/failed"
done > "$d/jobs.tsv"
[ -s "$d/failed" ] && echo "jobs calls failed: $(wc -l < "$d/failed") runs; retry those ids"
# workflow file, event, runs, then minutes per runner label
awk -F'\t' 'NR == FNR { key[$1] = $2 "\t" $3; runs[$2 "\t" $3]++; next }
  { min[key[$1] "\t" $3] += $2 }
  END { for (k in runs) print k "\t" runs[k] " runs"; for (k in min) print k "\t" min[k] " min" }' "$d/runs.tsv" "$d/jobs.tsv" | sort
```

- A filtered runs query returns at most 1,000 runs: when the `total_count` line is above that, run the window in parts (`-f created=2026-10-01..2026-10-07`, one week at a time).
- The loop makes one jobs call per run: check the headroom first (`gh api rate_limit --jq .resources.core.remaining`) and shorten the window if it is short.
- `filter=all` includes earlier attempts, so re-runs count, as they are billed.
- Rows group by workflow file (`.path`), not display name: bot-created runs (Dependabot's `dynamic/...` paths) then fold into one row per kind instead of one per run. A run whose jobs were all skipped has no job rows.
- `.labels[0]` is the job's `runs-on` label: a larger runner shows under its own label, and each label is priced separately.

## Reading it

- **`push` minutes on a repo with a merge queue** are the duplicate candidate: the queue already tested that tree (`github-workflow`, CI for a gate: checklist, One full run per tree).
- **`pull_request` runs per merged PR** above the previous window mean more pushes per PR: batch commits and push once per round (`github-workflow`, Landing a change, rule 1).
- **`merge_group` runs per merged PR** above 1 are queue ejections and rebuilds: find the failing or flaky job before anything else.
- **One label dominating** (a macOS or Windows matrix, a multi-arch image build) is where a `changes` job gate pays first.

## Where to cut, by symptom

Measure first (above), cut one lever, then measure again. Compare the same metrics over equal windows before and after: runs per merged PR, p50 and p90 duration, queue-to-green, eject rate, skipped share. Use the repo's own CI health target (`make ci-health` in this marketplace's repos; elsewhere its run-history report). A CI change once re-triggered itself and made CI slower, so a lever counts only when the second measurement shows it. Levers are listed in priority order; the mechanics of each are in `github-workflow` (CI for a gate: checklist).

| Symptom in the run history | Likely cause | Lever | Confirm |
|---|---|---|---|
| PR runs per merged PR rising | superseded runs left running; one push per fix; many small PRs or stack layers | cancel superseded PR runs; push once per round; batch related work in one PR or stack | runs per merged PR and cancelled share, same window length |
| Hung or very long outliers; p90 far above p50 | a job with no timeout, or a hang that holds the gate | `timeout-minutes` on every job, from measured duration plus headroom | longest run falls; no timeout hits on healthy runs |
| Merge-group runs per merged PR rising; queue ejects | a flaky or slow job in the full tier; full checks repeated on the push to the default branch | find the failing job first; run the full tier only in `merge_group` (and nightly), not again on the push | eject rate; push minutes on the default branch drop |
| p90 or queue-to-green rising while queue wait stays near zero | not runner saturation: the critical path grew (serial jobs, one long job, cold caches) | run independent jobs in parallel; shard the longest; dependency caches | the longest job and the sum along `needs:` shrink |
| High skipped share; noise in the checks list | trigger-level filters or wide triggers that start runs that do nothing | narrow triggers (events, branches); job-level path filters behind one aggregate check | skipped share falls; the aggregate check still reports on every PR |
| A required check stuck pending | a trigger-level `paths` filter on a required workflow: no run, so no status | move the filter to a `changes` job; the aggregate `check` always runs | the check reports on a PR touching only ignored paths |
| One runner label dominates minutes (Windows, macOS, multi-arch) | heavy legs run on every PR push | heavy legs in the queue and nightly; on PRs only when their paths change | minutes per label; the leg still runs in the queue |
| Whole matrix cancelled on one failure, then re-run | `fail-fast: true` hides which legs fail and costs re-runs | keep `fail-fast: false` where legs are independent and a full failure picture saves re-runs; `true` where one failure makes the rest meaningless | re-run count falls |

Notes on the levers:

- **Two tiers.** Light tier on the PR, full tier on `merge_group` and nightly, each full check run once per tree.
- **Path filters.** Only job-level, behind ONE aggregate `check` that accepts a skip only when `changes` said the job was not needed.
- **Trust trade-off.** Moving a manual gate or an OS leg off the PR into the queue or nightly delays the signal: a break shows later and fails the queue entry instead of the PR. Record that trade-off in the PR that makes the move.
- **No merge queue** (for example a personal account, which cannot have one): there is no `merge_group`. The PR run, with branches required up to date, is the gate. Heavy legs go nightly plus PRs whose paths touch them. How much trust to trade is the owner's call; propose, do not decide.

## Gotchas

- A cost fix that changes workflow triggers, or commits from CI, can re-trigger itself. Test it on a branch and read the first runs before arming it.
- Cancelling `merge_group` or default-branch runs to save minutes drops queue entries or hides a break; only PR runs are cancelled.
- Fewer minutes with a higher eject rate is a loss: each eject pays the full tier again.
- Compare equal windows with similar volume; a quiet week flatters any change.
