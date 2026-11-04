# Measuring CI cost

Every change is tested up to three times (on the PR, in the merge queue, on the push to the default branch), and every push to a PR runs its CI again. Measure where the minutes go before changing a workflow, and compare each figure with the repo's own previous window, never with a fixed budget.

Both views below are read-only. They call `gh` with arguments only (no `eval`, no token on a command line or in output), and print counts and minutes, never repository names, run URLs or logs. Run them from inside the repo, where `gh` fills in `{owner}/{repo}`; keep anything that names a repository local, out of every PR, issue and committed file.

## Billed minutes (billing usage API)

The enhanced billing platform reports usage per day, product and SKU (one SKU per runner type). It needs billing read access to the account: your own user, or an organization you administer. Through `gh`, the user endpoints need the `user` scope (`gh auth refresh -h github.com -s user`) and answer 404, not 403, without it. Check the endpoints against the [billing usage docs](https://docs.github.com/en/rest/billing/usage) first; they are recent and change.

```bash
login=$(gh api user --jq .login)
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
# This repo, one month, Actions minutes per SKU (summary endpoint, public preview):
gh api -X GET "users/$login/settings/billing/usage/summary" \
  -f year=2026 -f month=10 -f product=actions -f repository="$repo" \
  --jq '.usageItems[] | [.sku, .netQuantity, .unitType, .netAmount] | @tsv'
# Every repository on the account, summed per SKU (no names printed):
gh api -X GET "users/$login/settings/billing/usage" -f year=2026 -f month=10 \
  --jq '[.usageItems[] | select(.product | ascii_downcase == "actions")]
        | group_by(.sku)[] | [.[0].sku, (map(.quantity) | add), (map(.netAmount) | add)] | @tsv'
```

For an organization the paths are `organizations/<org>/settings/billing/usage` and `.../usage/summary`. Standard runners on public repositories are free and may report no billed minutes; measure them with the runs API below. The per-run `actions/runs/<id>/timing` endpoint is closing down: don't build on it.

## Minutes per workflow and event (runs and jobs APIs)

Billing counts each job, rounded up to a whole minute, and every re-run attempt, per runner type. The same sum from the jobs of every run in a window:

```bash
since=$(date -u -d '30 days ago' +%F 2>/dev/null || date -u -v-30d +%F)  # GNU, then BSD date
gh api -X GET 'repos/{owner}/{repo}/actions/runs' -f created=">=$since" -f per_page=1 --jq .total_count
gh api --paginate -X GET 'repos/{owner}/{repo}/actions/runs' -f created=">=$since" -f per_page=100 \
  --jq '.workflow_runs[] | [.id, .name, .event] | @tsv' > runs.tsv
cut -f1 runs.tsv | while read -r id; do
  gh api --paginate -X GET "repos/{owner}/{repo}/actions/runs/$id/jobs" -f filter=all -f per_page=100 \
    --jq '.jobs[] | select(.started_at != null and .completed_at != null and .conclusion != "skipped")
          | [.run_id, ([0, ((.completed_at | fromdate) - (.started_at | fromdate))] | max / 60 | ceil), (.labels[0] // "unknown")] | @tsv'
done > jobs.tsv
# workflow, event, runs, then minutes per runner label
awk -F'\t' 'NR == FNR { key[$1] = $2 "\t" $3; runs[$2 "\t" $3]++; next }
  { min[key[$1] "\t" $3] += $2 }
  END { for (k in runs) print k "\t" runs[k] " runs"; for (k in min) print k "\t" min[k] " min" }' runs.tsv jobs.tsv | sort
```

- A filtered runs query returns at most 1,000 runs: when the `total_count` line is above that, run the window in parts (`-f created=2026-10-01..2026-10-07`, one week at a time).
- The loop makes one jobs call per run: check the headroom first (`gh api rate_limit --jq .resources.core.remaining`) and shorten the window if it is short.
- `filter=all` includes earlier attempts, so re-runs count, as they are billed.
- `.labels[0]` is the job's `runs-on` label: a larger runner shows under its own label, and each label is priced separately.

## Reading it

- **`push` minutes on a repo with a merge queue** are the duplicate candidate: the queue already tested that tree (`github-workflow`, CI for a gate: checklist, One full run per tree).
- **`pull_request` runs per merged PR** above the previous window mean more pushes per PR: batch commits and push once per round (`github-workflow`, Landing a change, rule 1).
- **`merge_group` runs per merged PR** above 1 are queue ejections and rebuilds: find the failing or flaky job before anything else.
- **One label dominating** (a macOS or Windows matrix, a multi-arch image build) is where a `changes` job gate pays first.
