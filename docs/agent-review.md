# Agent review

A weekly review of agent telemetry: what the agents cost, which skills get used, where the guard had to remind, how subagents were routed and which commands keep failing, turned into fixes and skill-trigger evals.

## Run it

- **With an agent (normal):** open a session in this repo and type `/agent-review` (`$agent-review` in Codex, `/skill:agent-review` in pi), optionally with a range such as `30d`. It needs a Loki query tool in the session, such as the Grafana connector. The skill lives in `.agents/skills/agent-review/` (Codex, Copilot, VS Code, opencode, pi), linked from `.claude/skills/` for Claude Code, which does not read `.agents/skills/` (checked on 2.1.302); on Windows the link needs `git config core.symlinks true` (Developer Mode) before checkout.
- **Without an agent:** `make agent-review [RANGE=7d] [EVALS=<dir>]` runs the same queries straight against Loki and prints Markdown; `EVALS` also writes trigger-eval stubs. It reads Loki access from the environment, from your secret store: `GRAFANA_URL` and `GRAFANA_TOKEN` (a Viewer service-account token; `LOKI_UID` if the datasource uid is not `loki`), or `LOKI_URL` plus `LOKI_HEADERS` (`Key=Value,...`).

## Prerequisites

Telemetry in Loki: native harness usage where configured, Guard logs (`service_name="guard"`) and synthetic usage for opencode, pi and Antigravity ([guard.md](guard.md)). The collector maps native and `usage_schema="guard.usage.v1"` records to `agent_event="api_request"`; canonical `harness` values are `claude-code`, `copilot-cli`, `vscode-copilot`, `codex-cli`, `opencode`, `pi` and `antigravity`. During alias migration, queries may also read `harness_legacy` on the four renamed values only. Cost is available only when the source reports it. Antigravity synthetic usage supplies observed token counts but no cost because its artifacts lack enough pricing discriminators; native Codex telemetry also has no documented cost field.

## Queries and how to read them

One source for both paths: [queries.json](../.agents/skills/agent-review/references/queries.json). What each section means, when to act, and how to write a trigger eval: [Reading the figures](#reading-the-figures).

The routing-shape section (`agentIds`, `agentEdits`, `agentSpawns`, `agentCost`) reads one row per subagent and joins them on `agent_id`: `subagent_completed` names each agent's type and model, while `tool_result` and `api_request` carry the id of the agent that made the call, so an edit, a nested spawn or an `agent_summary` request is tied to the driver, worker or reviewer behind it. A resumed agent completes more than once, so the section counts unique ids. It prints aggregates only; the ids stay in memory.

The LSP-share section (`agentLsp`, `agentGrep`, `lspOps`) joins the same way: per agent type, LSP tool calls against Grep-tool and Bash `rg`/`grep` searches, plus the LSP failure rate; an empty agent id is the main session (agent-team teammates land there too).

The by-plugin-version section (`sessionVersions`, `sessionCost`, `sessionSubagentCost`, plus the session id on `agentIds`) joins Claude Code sessions to the guard's `guard.session` record on `session_id` and prints cost per session and routing shares per dev-tools version, aggregates only. It needs a guard that sends `guard.session` ([guard.md](guard.md#grafana)); sessions without one land under `(unknown)`.

A telemetry finding becomes an issue only with a reproduction (command text or a corpus row) and the guard version it was seen on.

## PR graph

`make pr-graph [RANGE=30d]` measures how your PRs are sized, paced and stacked. It reads your own PRs through the `gh` GraphQL search on every authenticated host, across all owners, and prints aggregates only:

- size and pace: PRs per day, changed lines (additions plus deletions) at p25, p50, p75 and p90, the share of PRs of 10 lines or fewer, the share of manifest-only PRs (every file a version manifest or changelog) and the median open-to-merge time;
- stacking: the stacked share (a PR counts when its base is not the default branch now or ever, read from its base-change events, since upper layers are retargeted to the default branch as lower ones merge), open-together pairs already stacked (any two PRs of one base/head chain, not only adjacent layers), and overlapping open PRs (open together, sharing a file, not stacked: fold into one PR, or stack if dependent). The primary pair row drops hot files, the ones touched by more than 20% of a repo's PRs in the window and by at least 3 of them (an index, a changelog, a manifest every PR edits), so a pair counts only when it shares a file that is not hot; the share of PRs in an overlapping pair uses that row. Overlap clusters (connected groups of those pairs) sit beside the pair count, since pairs grow quadratically with the group. Superseded pairs (the earlier PR closed unmerged, the later one opened while it was open) are replacements and get their own row. The any-shared-file row stays as a secondary row, with its manifest-only pairs split out.

`node scripts/pr-graph.mjs --repos` adds a per-repo table for local reading; never paste it into a PR, issue or committed file. It needs no Loki and skips cleanly, printing one line, without `gh` authentication.

## CI health

`make ci-health [RANGE=30d]` compares the current window with the one before it, side by side, so it needs no stored baseline and writes nothing to disk. Read-only, on every authenticated host.

**Which repos.** It measures the repos you merged at least one PR into during either window: the same `author:@me` search as the PR graph. A repo where you merged nothing in those days is absent, so the figures describe your repos, not an org. Within those repos every figure counts all authors and bots: "Merged PRs" is every PR merged there, not only yours. The repo set is the same for both windows, so a jump between them (more merged PRs, more runs) is a real change in volume in those repos, not a change of scope.

**What it prints:**

- runs: workflow runs per merged PR, PR runs and merge-group runs apart; run time and queue-to-green (run created to success, re-runs included) at p50 and p90; queue wait (job start minus job created, on a sample of 30 runs per repo and window); the cancelled, failure and re-run (a second attempt) shares; a flake proxy (a re-run that passed after its previous attempt failed); the merge-group eject rate (merge-group runs that failed or were cancelled); and skipped-run noise (runs skipped outright);
- flags: repos whose critical path (run time p50) grew by 20% or more, or whose re-run share rose, against their previous window, each with at least 5 runs in both windows;
- workflow audit, per repo, summed: concurrency set, PR workflows cancelling superseded runs, `timeout-minutes` on jobs (reusable-workflow calls excluded), a `merge_group` trigger where the default branch has a merge queue (a private repo on a plan without branch rules has none), trigger-level path filters without an aggregate check (a job with `needs:` and `if: always()`), caches, actions pinned by SHA and top-level `permissions`. The audit reads workflow files line by line, without a YAML parser, which is good enough for the usual workflow shapes; it should move to a shared YAML-aware workflow parser once one exists. A workflow file over 1 MB comes back from the contents API without content and is counted as skipped, not audited.

**Partial figures.** A query can fail (a permission, an outage, a rate limit that outlasts the retries) and a filtered runs query returns at most 1000 runs. The script retries a rate-limited (403 with a limit signal, 429) or server (5xx) failure up to 4 times, waiting for `Retry-After` (seconds or a date) or the rate-limit reset, and backing off exponentially when the failure gives no wait signal; a wait signal over 120 s fails the query at once, and it is counted as failed. A chunk over 1000 runs is fetched again in smaller parts (a week by day, a day by 6 hours, 6 hours by hour), and an hour still over 1000 is counted as truncated. A repo with any failed or truncated query is partial: it is left out of every figure and flag, counted in the report's "Repos left out as partial", "Queries failed after retries" (split by kind: discovery, runs, merged, jobs, attempts, workflows, queue) and "Run queries truncated" rows, and shown as `unknown` in `--repos`. When those rows are above 0, read the figures as covering only the measured repos, and rerun later or with a shorter `RANGE`.

Skipped runs count only toward the noise figure. The default range is 30d, so the run reads 60 days of runs. It keeps at most 6 `gh` calls in flight (under GitHub's secondary rate limits), counts merged PRs through GraphQL search (REST search allows 30 requests a minute), samples queue wait from 30 runs per repo and window, and prints progress on stderr without repo names. Measured once: 27 repos took 302 s and about 1,650 REST calls of the hourly 5,000, so run it when the token has that headroom (`gh api rate_limit`); a shorter `RANGE` reads fewer runs. `node scripts/ci-health.mjs --repos` adds a per-repo table with each repo's flags for local reading; never paste it into a PR, issue or committed file. It skips cleanly, printing one line, without `gh` authentication. How to read each figure and when to act: [Reading the figures](#reading-the-figures).

## Reading the figures

### Review sections

| Section | Act when |
|---|---|
| Cost by harness and model | A harness or model grows without a reason; compare with the budget. |
| Claude Code cost by source | `hook_prompt`, `away_summary` or `prompt_suggestion` are a large share: background spend no task asked for. |
| hook_prompt by plugin | A plugin's row is a large share: its mod forks the session (`$.model.fork`) or runs a prompt hook, each a full-context request on the session's model. A fork stays on the session's model to share its cache, so cut its triggers (a mod option such as a minimum answer length) or disable it. For a `type: prompt` or `agent` hook, pin a cheaper model on the hook or disable it. An empty plugin is a session on Claude Code before 2.1.310, which did not label these requests: match the sessions' dates against when a mod was enabled. |
| Subagent routing | Subagent spend on Opus or Fable is high: lookups belong on Haiku, routine edits on Sonnet (`subagent-orchestration`). |
| Routing shape | Fewer than 1.5 workers per driver, under half of the workers spawned by a driver, drivers making over 30% of subagent edits or a median above 3 edits each: drivers edit instead of fanning out to `worker`s (`subagent-orchestration`, the driver prompt). Track Opus per driver against the previous window: it should fall as edits move to workers. |
| LSP share | With at least 30 searches in the window, the share is below 5% for `main`, `driver`, `scout`, `worker` or `reviewer`, or one of them has 0 LSP calls: agents grep for symbols instead of using the LSP tool. First check the language servers start (Claude Code `/plugin` errors, `lspOps` failures above 10% mean a broken server), then the agent prompts, skills and the guard `lsp` hint. |
| Reviewer tier | Under 80% of reviewers on Sonnet: hubs raise the reviewer for routine changes; `model: opus` with `effort: high` belongs only to the sensitive-review set. |
| Effort high | A row for any agent outside the reviewers and verifiers (`reviewer`, `api-reviewer`, `verifier`): a spawn raised its effort where the routing table does not. |
| agent_summary share | Above 10% of subagent spend: the background summaries of running subagents, priced on each subagent's model; long Opus drivers drive it. |
| By plugin version | Against the previous version, cost per session or the Opus share of subagent cost rises, workers per driver falls, or effort high+ or agent_summary share rises: a dev-tools change (agent prompts, routing rules) moved routing; read that version's changes. `(unknown)` large: sessions on a guard without `guard.session` or started before the window; only Claude Code sessions are joined. |
| Subagent cost by agent | Spend without an agent id is agent-team teammates: with agent teams on, a named spawn becomes a teammate that telemetry cannot tie to an agent. Turn agent teams off, or name a spawn only when you will message it. |
| Spawns with no model pinned | Any row: the spawn ran on the session's model. Fix the skill or brief that spawned it. |
| Model swaps | Any row: a subagent finished on a fallback model; a factory run records it as a routing deviation. |
| Skills: never loaded | Not used in the window. Keep a skill at least 30 days before pruning it; check it is still installed. |
| Skills: never picked by the model | Loaded only when typed or by another skill: its description does not trigger. Write a trigger eval (below), then rework the description ([docs/skills.md](skills.md)). |
| Guard reminders | A rule reminds often: the matching skill's description misses that situation, or the read hint fires for commands a read tool cannot replace. |
| Guard decisions | An ask the user always approves is a false positive; fix the rule in `plugins/guard/core/rules.mjs` with a test, and add the command (paraphrased, no private values) as a row in `plugins/guard/core/corpus.json`. A risky command that ran with no ask is a row too. Denies of a runner's registered run carry the rules `run-label`, `run-config`, `protected-path`, `run-registration` and `run-unregistered` ([guard.md](guard.md#run-contract-v2)): they are the runner's contract at work, not false positives, unless `run-registration` or `run-unregistered` fires on a run that should be registered. |
| PR splits by reason | `other-owner` or `separate-release` rise, or `invalid` and `none` denies repeat: agents open more PRs than the fewest (`github-pull-requests`, Branch lifecycle); read the briefs that led to them. A reason that is never used may be dropped from the list in `rules.mts`. |
| Guard asks answered | `timeout` or `unavailable` is a large share of asks: the asks land while the user is away; look at which rule asks (decisions, `via`) before raising the timeout. A rule whose asks are nearly all `allow` is a false positive. |
| Manual approvals | A tool approved often by hand is a candidate for an allow rule in the harness settings. |
| Failing shell commands | A tool that is missing, a wrong flag, or reads done through the shell. |
| PR graph | Overlap clusters and overlapping pairs with hot files dropped are above 0 or rise, or the stacked share falls. Read clusters first (pairs grow quadratically with a group). Act by folding same-deliverable PRs into one PR (`github-pull-requests` rule 1) and stacking dependent ones (rule 4; the guard `stack` hint). Superseded pairs are replacements of a closed PR, not a stacking failure. Pairs on any shared file well above the hot-file-free row mean a few hot files (an index, a changelog) collide, not dependent work: give each PR its own entry file or generate the shared one. Manifest-only pairs are parallel PRs bumping the same version, which the versioning rules handle, not stacking. |
| PR graph: PRs per day | Read with the size figures: a rising rate of tiny PRs multiplies CI runs and queue entries per change; a falling rate with growing size means work is batching up. |
| PR graph: changed lines p25 / p50 / p75 / p90 | The p90 grows against the previous window: large PRs review and merge slower; split them into a stack. A p50 near zero with a high rate: changes are sliced finer than one reviewable unit. |
| PR graph: PRs of 10 lines or fewer | A large and rising share: fold follow-up fixes into the PR that needs them (the fold-in test), batch related issues in one PR (`github-pull-requests`), and fix review findings before merging rather than after. |
| PR graph: manifest-only PRs | Above 0 outside a release flow: a version bump went out on its own; bump as the last commit of the change that needs it (AGENTS.md, Versioning). Release-bot PRs land here by design. |
| PR graph: median open-to-merge | Rises against the previous window: PRs wait on review or CI; read CI health (queue-to-green, queue wait) before blaming review. |

### CI health

`make ci-health` prints the previous window beside the current one; act on the direction of a figure against its own previous window, not on a fixed number.

| Figure | Act when |
|---|---|
| Repos left out as partial, queries failed, run queries truncated | Above 0: the figures cover fewer repos than were found; compare windows only with this in mind. Failed queries after retries point at a rate limit or a permission gap: rerun when the token has headroom or with a shorter `RANGE`. Truncated queries mean a repo runs over 1000 workflow runs in an hour: that volume is itself the finding (skipped-run noise, superseded runs). |
| Runs per merged PR | PR runs per merged PR rise: pushes re-trigger full CI; batch fix-up commits before pushing, cancel superseded runs (concurrency with `cancel-in-progress` on PR workflows), and keep docs-only changes off the expensive jobs with job-level path filtering behind one aggregate check. Merge-group runs well above 1: the queue re-runs groups after ejects; read the eject rate. |
| Run time p50 / p90 | Rises, or the repo is flagged for critical path: the longest job chain grew. Split the slow job, run independent jobs in parallel, cache dependencies, and move heavy suites to the merge group only. A p90 far above the p50 is a few slow runs: read the queue wait and the cancelled share. |
| Queue-to-green p50 / p90 | Rises while run time does not: the time goes to runner queues and re-runs; read queue wait and re-run share. |
| Queue wait p50 / p90 | Rises: runners are saturated; cancel superseded runs, drop redundant matrix legs, or add runner capacity. |
| Cancelled share | High with low failure: superseded runs cancelled by concurrency, which is the point. High in merge groups: the queue reshuffles after ejects. |
| Failure share | Rises: read which workflow fails; a failure that passes on a re-run is a flake (next rows). |
| Re-run share | Rises, or the repo is flagged for re-runs: re-runs paper over flakes or infrastructure errors; fix the flaky test or step rather than re-running. |
| Flake proxy | Above 0: the same commit failed then passed. Quarantine or fix the test, add retries only around the network step that flakes, and keep `timeout-minutes` on every job so a hung job fails fast. |
| Merge-group eject rate | Rises: PRs pass on their branch but fail merged with the queue ahead; run the same checks on PRs as on the merge group, and rebase stacks before queuing. |
| Skipped-run noise | A large share: workflows trigger on every event and then skip; narrow their triggers (`on:` filters, a workflow per event) so the Actions list and run counts show real work. |
| Workflow audit | Any check below 100% (or a count above 0) is a technique to apply: concurrency on every workflow with `cancel-in-progress` on PR ones, `timeout-minutes` on every job, a `merge_group` trigger on required checks where a merge queue runs, path filters at job level behind one aggregate `check` (a trigger-level filter leaves a required check pending), dependency caches, actions pinned by SHA with an update bot, and a top-level `permissions:` of least privilege (`github-actions`; the platform-neutral techniques in `ci-cd`). |

File each action as a GitHub issue, or fix it in a PR the same day.

### Trigger evals

One case per skill the model never picks itself, in `plugins/<plugin>/evals/<skill>-trigger/` (`make agent-review EVALS=<dir>` writes the stubs):

- `prompt.md`: a request phrased the way a user would type it, without naming the skill and without private values; frontmatter `max_turns: 10`, `allowed_tools: [Read, Glob, Grep, Skill]`, `tags: [trigger]`.
- `graders/skill-fired.md`: `type: tool_used`, `tool: Skill`, `input_match: '"skill"\s*:\s*"(?:[\w-]+:)?<skill>"'`.

Run from the plugin directory:

```sh
claude plugin eval . --tag trigger --ablation none
```

A skill that fires only mid-task (editing code, not answering a question) needs a repo to work in: write `case.yaml` with the prompt under `execution` and `context.scaffold_script: scaffold.sh`, a script that builds the repo in its working directory (a top-level `scaffold_script` is silently ignored), and add `Edit` and `Write` to `allowed_tools`. Run it with `--scaffold --allow-tools Edit Write`. Example: `plugins/dev-tools/evals/docs-sync-trigger/`.

`--ablation none` scores the trigger itself; under the default with/without ablation a `Skill` grader is only reported as an indicator. A case that fails points at the description: reword it, rerun, and commit the case with the fix so the next review catches a regression.

## Tracing hook_prompt spend

`query_source="hook_prompt"` is a request a plugin makes on its own: a mod forking the session (`$.model.fork`) or a `type: prompt`/`agent` hook. It reads the whole conversation, so each one costs about a main turn on the session's model. The review's `hookPromptCost` query splits it by `plugin_name`. When the plugin is empty (Claude Code before 2.1.310):

1. Break it down by `session_id` (an instant query, `sum by (session_id) (count_over_time(... [7d]))`) and by day: a range query with a one-day step (`count_over_time(... [1d])`, step `86400`, over the last 14 days; in Grafana's Loki tool, `queryType` `range` and `stepSeconds` `86400`). Look for the day it started or stopped.
2. Group by `input_tokens`: one mod sends the same question every time, so its requests share an input size.
3. Match those dates against the plugins enabled in your settings (`enabledPlugins`, and the history of the file that sets it). Sessions started before a plugin was disabled keep it until they restart.

The drill-down stays local: session IDs, transcripts and per-session rows never go into the report, a PR or an issue, which carry plugin names and aggregate counts only ([SKILL.md](../.agents/skills/agent-review/SKILL.md)).
