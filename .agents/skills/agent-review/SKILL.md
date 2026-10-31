---
name: agent-review
description: Weekly review of agent telemetry in Loki - cost by harness, model and source, subagent routing, skills the model never picks, guard reminders and false positives, manual approvals, failing commands, rate limits - turned into fixes and skill-trigger evals in this repo. Use when the user asks for an agent, cost, skill-usage or telemetry review, or types /agent-review (optionally a range such as 30d).
---

# Agent review

Read a window of agent telemetry, say what to change, and change it. Argument: the range (default `7d`). The argument is the text after the skill name, repeated here when the harness fills it in: $ARGUMENTS

1. **Query.** Run every query in [references/queries.json](references/queries.json) as an instant query, `$r` replaced by the range, through the session's Loki tool (a Grafana connector's Loki query; datasource uid `loki`). Without one, `make agent-review` runs the same queries and needs Loki credentials in the environment ([docs/agent-review.md](../../../docs/agent-review.md)). Report a query that errors; never drop it silently.
   **PR graph and CI health.** Run `make pr-graph RANGE=<range>` and `make ci-health RANGE=<range>` and add their sections to the report; only their aggregates leave the session.
2. **Compare skills.** The installed skills are the ones in the session's own skill list. A skill with no load is unused; one loaded only by the user (`user-slash`, guard `via=prompt`) or by another skill (`nested-skill`) is never picked by the model from its description.
3. **Report** one screen: for each section of [references/reading.md](references/reading.md) with something to act on, the numbers that matter and the action. Costs are list-price equivalents, not the bill.
4. **Act.** Each action becomes a PR in the repo that owns it (a guard rule with its test, a reworded description with its trigger eval, a settings change) or a GitHub issue carrying the evidence.

Reports, PRs and issues carry counts and rule or skill names only: raw log lines, prompts, session IDs and command lines hold private values.
