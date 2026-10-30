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

A telemetry finding becomes an issue only with a reproduction (command text or a corpus row) and the guard version it was seen on.

## PR graph

`make pr-graph [RANGE=30d]` measures how consistently dependent PRs are stacked. It reads your own PRs through the `gh` GraphQL search on every authenticated host, across all owners, and prints aggregates only: the stacked share, open-together pairs already stacked, and should-have-been-stacked pairs (open together, sharing a file, not stacked), with the manifest-only ones split out. `node scripts/pr-graph.mjs --repos` adds a per-repo table for local reading; never paste it into a PR, issue or committed file. It needs no Loki and skips cleanly, printing one line, without `gh` authentication.

## Tracing hook_prompt spend

`query_source="hook_prompt"` is a request a plugin makes on its own: a mod forking the session (`$.model.fork`) or a `type: prompt`/`agent` hook. It reads the whole conversation, so each one costs about a main turn on the session's model. The review's `hookPromptCost` query splits it by `plugin_name`. When the plugin is empty (Claude Code before 2.1.310):

1. Break it down by `session_id` (an instant query, `sum by (session_id) (count_over_time(... [7d]))`) and by day: a range query with a one-day step (`count_over_time(... [1d])`, step `86400`, over the last 14 days; in Grafana's Loki tool, `queryType` `range` and `stepSeconds` `86400`). Look for the day it started or stopped.
2. Group by `input_tokens`: one mod sends the same question every time, so its requests share an input size.
3. Match those dates against the plugins enabled in your settings (`enabledPlugins`, and the history of the file that sets it). Sessions started before a plugin was disabled keep it until they restart.

The drill-down stays local: session IDs, transcripts and per-session rows never go into the report, a PR or an issue, which carry plugin names and aggregate counts only ([SKILL.md](../.agents/skills/agent-review/SKILL.md)).
