# Agent review

A weekly review of agent telemetry: what the agents cost, which skills get used, where the guard had to remind, how subagents were routed and which commands keep failing, turned into fixes and skill-trigger evals.

## Run it

- **With an agent (normal):** open a session in this repo and type `/agent-review` (`$agent-review` in Codex, `/skill:agent-review` in pi), optionally with a range such as `30d`. It needs a Loki query tool in the session, such as the Grafana connector. The skill lives in `.agents/skills/agent-review/` (Codex, Copilot, VS Code, opencode, pi), linked from `.claude/skills/` for Claude Code, which does not read `.agents/skills/` (checked on 2.1.302); on Windows the link needs `git config core.symlinks true` (Developer Mode) before checkout.
- **Without an agent:** `make agent-review [RANGE=7d] [EVALS=<dir>]` runs the same queries straight against Loki and prints Markdown; `EVALS` also writes trigger-eval stubs. It reads Loki access from the environment, from your secret store: `GRAFANA_URL` and `GRAFANA_TOKEN` (a Viewer service-account token; `LOKI_UID` if the datasource uid is not `loki`), or `LOKI_URL` plus `LOKI_HEADERS` (`Key=Value,...`).

## Prerequisites

Telemetry in Loki: Claude Code OTel logs (`service_name="claude-code"`) and the guard's decision log (`service_name="guard"`, [guard.md](guard.md)). Codex, Copilot, opencode and pi add to the cost section when the collector maps their records to `agent_event="api_request"`.

## Queries and how to read them

One source for both paths: [queries.json](../.agents/skills/agent-review/references/queries.json). What each section means, when to act, and how to write a trigger eval: [reading.md](../.agents/skills/agent-review/references/reading.md).

The routing-shape section (`agentIds`, `agentEdits`, `agentSpawns`, `agentCost`) reads one row per subagent and joins them on `agent_id`: `subagent_completed` names each agent's type and model, while `tool_result` and `api_request` carry the id of the agent that made the call, so an edit, a nested spawn or an `agent_summary` request is tied to the driver, worker or reviewer behind it. A resumed agent completes more than once, so the section counts unique ids. It prints aggregates only; the ids stay in memory.

The LSP-share section (`agentLsp`, `agentGrep`, `lspOps`) joins the same way: per agent type, LSP tool calls against Grep-tool and Bash `rg`/`grep` searches, plus the LSP failure rate; an empty agent id is the main session (agent-team teammates land there too).

The by-plugin-version section (`sessionVersions`, `sessionCost`, `sessionSubagentCost`, plus the session id on `agentIds`) joins Claude Code sessions to the guard's `guard.session` record on `session_id` and prints cost per session and routing shares per dev-tools version, aggregates only. It needs a guard that sends `guard.session` ([guard.md](guard.md#grafana)); sessions without one land under `(unknown)`.

A telemetry finding becomes an issue only with a reproduction (command text or a corpus row) and the guard version it was seen on.

## PR graph

`make pr-graph [RANGE=30d]` measures how your PRs are sized, paced and stacked. It reads your own PRs through the `gh` GraphQL search on every authenticated host, across all owners, and prints aggregates only:

- size and pace: PRs per day, changed lines (additions plus deletions) at p25, p50, p75 and p90, the share of PRs of 10 lines or fewer, the share of manifest-only PRs (every file a version manifest or changelog) and the median open-to-merge time;
- stacking: the stacked share, open-together pairs already stacked, and should-have-been-stacked pairs (open together, sharing a file, not stacked). The primary pair row drops hot files, the ones touched by more than 20% of a repo's PRs in the window and by at least 3 of them (an index, a changelog, a manifest every PR edits), so a pair counts only when it shares a file that is not hot. The old row, any shared file, stays as a secondary row, with its manifest-only pairs split out.

`node scripts/pr-graph.mjs --repos` adds a per-repo table for local reading; never paste it into a PR, issue or committed file. It needs no Loki and skips cleanly, printing one line, without `gh` authentication.

## CI health

`make ci-health [RANGE=30d]` compares the current window with the one before it, side by side, so it needs no stored baseline and writes nothing to disk. Read-only, on every authenticated host.

**Which repos.** It measures the repos you merged at least one PR into during either window: the same `author:@me` search as the PR graph. A repo where you merged nothing in those days is absent, so the figures describe your repos, not an org. Within those repos every figure counts all authors and bots: "Merged PRs" is every PR merged there, not only yours. The repo set is the same for both windows, so a jump between them (more merged PRs, more runs) is a real change in volume in those repos, not a change of scope.

**What it prints:**

- runs: workflow runs per merged PR, PR runs and merge-group runs apart; run time and queue-to-green (run created to success, re-runs included) at p50 and p90; queue wait (job start minus job created, on a sample of 30 runs per repo and window); the cancelled, failure and re-run (a second attempt) shares; a flake proxy (a re-run that passed after its previous attempt failed); the merge-group eject rate (merge-group runs that failed or were cancelled); and skipped-run noise (runs skipped outright);
- flags: repos whose critical path (run time p50) grew by 20% or more, or whose re-run share rose, against their previous window, each with at least 5 runs in both windows;
- workflow audit, per repo, summed: concurrency set, PR workflows cancelling superseded runs, `timeout-minutes` on jobs (reusable-workflow calls excluded), a `merge_group` trigger where the default branch has a merge queue (a private repo on a plan without branch rules has none), trigger-level path filters without an aggregate check (a job with `needs:` and `if: always()`), caches, actions pinned by SHA and top-level `permissions`. The audit reads workflow files line by line, without a YAML parser, which is good enough for the usual workflow shapes; it should move to a shared YAML-aware workflow parser once one exists. A workflow file over 1 MB comes back from the contents API without content and is counted as skipped, not audited.

**Partial figures.** A query can fail (a permission, an outage, a rate limit that outlasts the retries) and a filtered runs query returns at most 1000 runs. The script retries a rate-limited (403 with a limit signal, 429) or server (5xx) failure up to 4 times, waiting for `Retry-After` or the rate-limit reset when it is under 2 minutes away and backing off otherwise. A chunk over 1000 runs is fetched again in smaller parts (a week by day, a day by 6 hours, 6 hours by hour), and an hour still over 1000 is counted as truncated. A repo with any failed or truncated query is partial: it is left out of every figure and flag, counted in the report's "Repos left out as partial", "Queries failed after retries" (split by kind: discovery, runs, merged, jobs, attempts, workflows, queue) and "Run queries truncated" rows, and shown as `unknown` in `--repos`. When those rows are above 0, read the figures as covering only the measured repos, and rerun later or with a shorter `RANGE`.

Skipped runs count only toward the noise figure. The default range is 30d, so the run reads 60 days of runs. It keeps at most 6 `gh` calls in flight (under GitHub's secondary rate limits), counts merged PRs through GraphQL search (REST search allows 30 requests a minute), samples queue wait from 30 runs per repo and window, and prints progress on stderr without repo names. Measured once: 27 repos took about 3.5 minutes and about 1,400 REST calls of the hourly 5,000, so run it when the token has that headroom (`gh api rate_limit`); a shorter `RANGE` reads fewer runs. `node scripts/ci-health.mjs --repos` adds a per-repo table with each repo's flags for local reading; never paste it into a PR, issue or committed file. It skips cleanly, printing one line, without `gh` authentication. How to read each figure and when to act: [reading.md](../.agents/skills/agent-review/references/reading.md).

## Tracing hook_prompt spend

`query_source="hook_prompt"` is a request a plugin makes on its own: a mod forking the session (`$.model.fork`) or a `type: prompt`/`agent` hook. It reads the whole conversation, so each one costs about a main turn on the session's model. The review's `hookPromptCost` query splits it by `plugin_name`. When the plugin is empty (Claude Code before 2.1.310):

1. Break it down by `session_id` (an instant query, `sum by (session_id) (count_over_time(... [7d]))`) and by day: a range query with a one-day step (`count_over_time(... [1d])`, step `86400`, over the last 14 days; in Grafana's Loki tool, `queryType` `range` and `stepSeconds` `86400`). Look for the day it started or stopped.
2. Group by `input_tokens`: one mod sends the same question every time, so its requests share an input size.
3. Match those dates against the plugins enabled in your settings (`enabledPlugins`, and the history of the file that sets it). Sessions started before a plugin was disabled keep it until they restart.

The drill-down stays local: session IDs, transcripts and per-session rows never go into the report, a PR or an issue, which carry plugin names and aggregate counts only ([SKILL.md](../.agents/skills/agent-review/SKILL.md)).
