# Tiers and mechanisms per harness

## Tiers

| Tier | Agent | Claude Code | Copilot CLI |
|---|---|---|---|
| 1 Scout | `scout` | Haiku 5.5, `low` | GPT-5.4 mini or GPT-6 Luna |
| 2 Routine | `worker`, `reviewer`; the hub where agents pin their model | Sonnet 5.5, `medium` | GPT-6 Luna |
| 3 Driver | `driver`; `reviewer` on a sensitive review, raised on the spawn | Opus 5.5, `medium` (a sensitive review: `high`) | GPT-6.1 Sol |
| 4 Escalation | `escalate` | Fable 5.1, `medium` | GPT-6 Astra |

A weak model's mistake in a summary shows up as a missing detail; in an edit it ships a bug. So tier 1 only reads, tier 2 edits only what a plan already decided and reviews routine changes, and judgement starts at tier 3. Effort is how thorough, not how capable: it goes up only to verify a sensitive change.

## Fan-out and raised reviews per harness

| Harness | A driver spawns its workers | Per-spawn model and effort (the sensitive-review raise) | Parallel workers isolated |
|---|---|---|---|
| Claude Code | yes, three layers deep by default | yes: `model` and `effort` on the spawn | yes: the `worker` definition sets `isolation: worktree` |
| Copilot CLI | not stated in its docs: return the split | no: model and effort per agent in user settings only | no: file-disjoint units, overlaps serialised |
| VS Code Copilot | only with nesting turned on | `model` on the spawn, no effort | no |
| Codex | not stated in its docs: return the split | spawn values exist, but the agent file wins | no |
| opencode | only with `subagent_depth` raised to 2 | not stated | no |
| pi (this repo's `subagent` tool) | yes, three layers deep | no: the tool takes only the agent and the task | no |

Where the driver cannot spawn, it returns the split (each unit's files, brief and checks) and the hub spawns the workers. Where a spawn cannot be raised, run a sensitive review in a session at the driver tier. Where workers share a checkout, the units must touch disjoint files.

## Mechanisms

Claude Code:
- `model` (`haiku`, `sonnet`, `opus`, `fable`) and `effort` on each spawn and in an agent definition. A spawn's values override the definition's; a per-spawn `effort` needs 2.1.292 or later, and `CLAUDE_CODE_EFFORT_LEVEL` overrides both, so leave it unset.
- Precedence: the spawn's `model`, then the definition's, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the session's model (since 2.1.251; before it the variable came first). A definition's `model: inherit` beats the variable. A family alias on a spawn or in a definition (`opus`) resolves to the session's exact model when it is of that family; the variable's alias always resolves to the alias's current version. Source: [sub-agents](https://code.claude.com/docs/en/sub-agents#choose-a-model).
- Nesting: a subagent can spawn its own, up to three layers below the hub (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; `1` turns it off). At the limit the `Agent` tool is withheld. An agent with a `tools` list that leaves out `Agent` (`worker`, `scout`, `reviewer`) never spawns.
- Isolation: `isolation: worktree` in a definition runs the agent in a temporary worktree branched from the default branch, not the parent's `HEAD`, and removes it when the agent changed nothing. So a worker commits before it reports, and its brief names the base branch to start from.
- At most 20 subagents run at once (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`); a spawn past it fails and must not be retried in a loop.
- Agent teams: with them on, a spawn from the main session with a `name` starts as a teammate, which telemetry records with no agent id or name and which runs in the main checkout whatever the definition's `isolation`. With them off, a named spawn is an ordinary subagent.
- `/model` and `/effort` change the session.
- Pass `subagent_type` on every spawn. A subagent that hit a fallback chain reports `model_swapped` and `final_model` on `subagent_completed`; record the swap where a run tracks routing.

Copilot CLI:
- `/model [--session|--global|--repo|--local] [MODEL|auto TIER]` sets model and reasoning effort; auto tiers are `efficiency`, `balance`, `intelligence`.
- A custom agent's `model` is a string and inherits the default if unset; this plugin's agents leave it unset. Copilot CLI agent files carry no effort: set `model` and `effortLevel` per agent in user settings under `subagents.agents.<plugin>:<agent>` (e.g. `dev-tools:worker`), or interactively with `/subagents`. A model the account lacks falls back to an available one. A spawn cannot raise them, and nesting is not stated in its docs.
- VS Code's own agent format has `model` and `reasoning-effort`, but VS Code reads this plugin's Claude-format agent files. Nesting is off until `chat.subagents.allowInvocationsFromSubagents` is on (then up to five layers); `runSubagent` takes a `model`, not an effort.

Codex:
- Custom agents are TOML in `~/.codex/agents/` (`make install HARNESS=codex` copies this plugin's): `model` and `model_reasoning_effort` per agent. Unset `model` inherits the session's; `/model` changes it. A spawn can pass a model and effort, but the agent file's values win. `sandbox_mode` in an agent file is ignored: a subagent runs in the parent's sandbox, so the scout is read-only by its prompt only. Nesting depth is not stated. Use the OpenAI rows of the table. This plugin's `worker` registers there as `dev-tools-worker`, since a user agent named `worker` would replace Codex's built-in role.

opencode:
- Subagents are Markdown in `~/.config/opencode/agents/` (`make install HARNESS=opencode`), run through the `task` tool or an `@name` mention. `model` is `provider/id`, and provider options such as `reasoningEffort` pass through; this plugin sets neither (its `model` names a Claude tier), so agents run on the session's model. `permission` limits a subagent (scout and reviewer deny `edit`). `subagent_depth` defaults to 1: set it to 2 for a driver to spawn workers.

pi:
- This repo's `subagent` tool (`agent`, `task`) runs an agent from this plugin in its own `pi -p` session with the session's model and the agent's `effort` as its thinking level. The driver and escalate children get the tool again (they have no `tools` list), so a driver fans out; the tool refuses past three layers (`PI_SUBAGENT_DEPTH`). `/model` and `--thinking <level>` set model and effort for the session.

## Verify before relying on the table

Model lineups move fast. Check [Copilot supported models](https://docs.github.com/en/copilot/reference/ai-models/supported-models) and [model comparison](https://docs.github.com/en/copilot/reference/ai-models/model-comparison). The OpenAI rows follow GitHub's guidance: Astra for long-horizon autonomous work, Sol for interactive agentic coding, Luna for small tasks, mini for codebase exploration.
