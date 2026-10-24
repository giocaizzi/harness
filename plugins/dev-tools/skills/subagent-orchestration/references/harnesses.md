# Tiers and mechanisms per harness

## Tiers

| Tier | Agent | Claude Code | Copilot CLI |
|---|---|---|---|
| 1 Scout | `scout` | Haiku 5.5, `low` | GPT-5.4 mini or GPT-6 Luna |
| 2 Routine | `worker`; the hub where agents pin their model | Sonnet 5.5, `medium` | GPT-6 Luna |
| 3 Driver | `driver`, `reviewer` | Opus 5.5, `medium` | GPT-6.1 Sol |
| 4 Escalation | `escalate` | Fable 5.1, `medium` | GPT-6 Astra |

A weak model's mistake in a summary shows up as a missing detail; in an edit it ships a bug. So tier 1 only reads, tier 2 edits only what a plan already decided, and judgement starts at tier 3.

## Mechanisms

Claude Code:
- `model` (`haiku`, `sonnet`, `opus`, `fable`) and `effort` on each spawn and in an agent definition. A spawn's values override the definition's.
- Precedence: the spawn's `model`, then the definition's, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the session's model. A definition's `model: inherit` beats the variable. A family alias on a spawn or in a definition (`opus`) resolves to the session's exact model when it is of that family; the variable's alias always resolves to the alias's current version. Source: [sub-agents](https://code.claude.com/docs/en/sub-agents#choose-a-model).
- `/model` and `/effort` change the session.
- Pass `subagent_type` on every spawn. A subagent that hit a fallback chain reports `model_swapped` and `final_model` on `subagent_completed`; record the swap where a run tracks routing.

Copilot CLI:
- `/model [--session|--global|--repo|--local] [MODEL|auto TIER]` sets model and reasoning effort; auto tiers are `efficiency`, `balance`, `intelligence`.
- A custom agent's `model` is a string and inherits the default if unset; this plugin's agents leave it unset. Agent files have no effort property: set `model` and `effortLevel` per agent in user settings under `subagents.agents.<plugin>:<agent>` (e.g. `dev-tools:worker`), or interactively with `/subagents`. A model the account lacks falls back to an available one.

Codex:
- Custom agents are TOML in `~/.codex/agents/` (`make install HARNESS=codex` copies this plugin's): `model` and `model_reasoning_effort` per agent, `sandbox_mode` (scout is `read-only`). Unset `model` inherits the session's; `/model` changes it. Use the OpenAI rows of the table. This plugin's `worker` registers there as `dev-tools-worker`, since a user agent named `worker` would replace Codex's built-in role.

opencode:
- Subagents are Markdown in `~/.config/opencode/agents/` (`make install HARNESS=opencode`), run through the `task` tool or an `@name` mention. `model` is `provider/id`; unset inherits the session's. `permission` limits a subagent (scout and reviewer deny `edit`).

pi:
- This repo's `subagent` tool (`agent`, `task`) runs an agent from this plugin in its own `pi -p` session with the session's model. `/model` and `--thinking <level>` set model and effort.

## Verify before relying on the table

Model lineups move fast. Check [Copilot supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models) and [model comparison](https://docs.github.com/en/copilot/reference/ai-models/model-comparison). The OpenAI rows follow GitHub's guidance: Astra for long-horizon autonomous work, Sol for interactive agentic coding, Luna for small tasks, mini for codebase exploration.
