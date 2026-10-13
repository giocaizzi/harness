---
name: subagent-orchestration
description: Routing work to subagents and models in Claude Code, Copilot CLI, Codex, opencode and pi - hub-and-spoke delegation, four model tiers, effort levels, escalation and verifying delegated results. Use when spawning subagents, splitting work in parallel, or choosing a model or effort for a task.
---

# Subagent orchestration

The main session (hub) plans, delegates and verifies. Subagents (spokes) do bounded work and report evidence. Spend model power where judgment decides the outcome, not on lookups.

## Tiers

| Tier | Work | Claude Code | Copilot CLI |
|---|---|---|---|
| 1 Scout | search, read logs, summarize test output | Haiku 5.5, `low` | GPT-5.4 mini or GPT-6 Luna |
| 2 Routine | mechanical edits, config rollouts across repos, PR/Dependabot triage, audits | Sonnet 5.5, `low`–`medium` | GPT-6 Luna |
| 3 Driver (default) | features, debugging, review: code that needs judgement | Opus 5.5, `medium`; `high` to verify | GPT-6.1 Sol |
| 4 Escalation | a problem that stalled at tier 3 | Fable 5.1 | GPT-6 Astra |

- **Scout for reading, not editing.** A weak model's mistake in a summary shows up as a missing detail; in an edit it ships a bug. Routine, well-specified edits go to Sonnet; anything needing judgement goes to the driver.
- **Escalate only after the driver failed twice at `xhigh` on the same problem.** Compact first, since the new model re-pays the cache write for the whole conversation, and return to the driver once solved.
- **Reviewer is not the author.** Review important changes at the author's tier or higher.

## Effort

- `low`: quick, in-the-loop work.
- `medium`: normal engineering.
- `high`: verification, edge cases, brownfield bugs.
- `xhigh`/`max`: autonomous work on hard problems.

Implement at `low`, verify at `high`. More effort catches missed edge cases; it does not fix a wrong approach, so re-plan instead of raising it. Give every agent a way to check its work (a test, a build), or effort buys little.

## Delegation

- Fan out independent units (one per service, file or source). Briefs are self-contained: goal, scope, what to report, what "done" means. Subagents do not see the conversation.
- Check each report's evidence before accepting it, then consolidate into one output.
- Keep teams small: agent teams cost several times a normal session.
- Don't parallelize tightly coupled edits, and don't delegate work smaller than its brief.
- If a subagent fails or returns something unexpected, surface its error and wait; don't silently retry or substitute.

## Mechanisms

Claude Code:
- `model` on each spawn (`haiku`, `sonnet`, `opus`, `fable`); `model` and `effort` in an agent definition.
- `CLAUDE_CODE_SUBAGENT_MODEL` sets all subagents; a definition's own `model` wins.
- `/model` and `/effort` change the session.
- This plugin ships `scout` (tier 1) and `escalate` (tier 4).

Copilot CLI:
- `/model [--session|--global|--repo|--local] [MODEL|auto TIER]` sets model and reasoning effort; auto tiers are `efficiency`, `balance`, `intelligence`.
- A custom agent's `model` is a string and inherits the default if unset; this plugin's agents leave it unset. Agent files have no effort property: set `model` and `effortLevel` per agent in user settings under `subagents.agents.<plugin>:<agent>` (e.g. `dev-tools:scout`), or interactively with `/subagents`. A model the account lacks falls back to an available one.

Codex:
- Custom agents are TOML in `~/.codex/agents/` (`make install HARNESS=codex` copies this plugin's): `model` and `model_reasoning_effort` per agent, `sandbox_mode` (scout is `read-only`). Unset `model` inherits the session's; `/model` changes it. Use the OpenAI rows of the table.

opencode:
- Subagents are Markdown in `~/.config/opencode/agents/` (`make install HARNESS=opencode`), run through the `task` tool or an `@name` mention. `model` is `provider/id`; unset inherits the session's. `permission` limits a subagent (scout denies `edit`).

pi:
- This repo's `subagent` tool (`agent`, `task`) runs an agent from this plugin in its own `pi -p` session with the session's model. `/model` and `--thinking <level>` set model and effort.

## Verify before relying on the table

Model lineups move fast. Check [Copilot supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models) and [model comparison](https://docs.github.com/en/copilot/reference/ai-models/model-comparison). The OpenAI rows follow GitHub's guidance: Astra for long-horizon autonomous work, Sol for interactive agentic coding, Luna for small tasks, mini for codebase exploration.
