---
name: subagent-orchestration
description: Routing work to subagents and models in Claude Code, Copilot CLI, Codex, opencode and pi - hub-and-spoke delegation, four model tiers, effort levels, escalation and verifying delegated results. Use when spawning subagents, splitting work in parallel, coordinating with other running sessions, waiting on a reviewer's verdict or capping review rounds, or choosing a model or effort for a task.
---

# Subagent orchestration

The main session (hub) routes, tracks state and coordinates. Subagents (spokes) do bounded work and report evidence. Spend model power where judgment decides the outcome, not on lookups.

## Tiers

| Tier | Work | Claude Code | Copilot CLI |
|---|---|---|---|
| 1 Scout | search, read logs, summarize test output | Haiku 5.5, `low` | GPT-5.4 mini or GPT-6 Luna |
| 2 Routine | mechanical edits, config rollouts across repos, PR/Dependabot triage, audits | Sonnet 5.5, `low`–`medium` | GPT-6 Luna |
| 3 Driver (default) | features, debugging, review: code that needs judgement | Opus 5.5, `medium` | GPT-6.1 Sol |
| 4 Escalation | a problem that stalled at tier 3 | Fable 5.1 | GPT-6 Astra |

- **Scout for reading, not editing.** A weak model's mistake in a summary shows up as a missing detail; in an edit it ships a bug. Routine, well-specified edits go to Sonnet; anything needing judgement goes to the driver.
- **Spawns default to tier 2.** With `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` (Claude Code), an untyped spawn without a model runs on Sonnet; an untyped spawn for tier 1 work passes its model; tier 3 and 4 work goes to `driver` and `escalate`. Other harnesses have no such default: a spawn runs on the session's model unless the agent's own settings pin one (see the model bullet below).
- **Judgement work goes to `driver`, whatever the hub runs on.** The hub (tier 2 at `medium` by default, but any model) routes, tracks state, relays between sessions and runs mechanical checks (commit hash, green CI, closing keyword, merged-tree equality). Investigation, design, planning, security triage and implementation that needs judgement go to a `driver` spawn with a written brief (`escalate` after two failures), even on an Opus hub: never a `general-purpose` spawn with an Opus model, and never the built-in Plan agent, which runs on the session's model. Routine, well-specified implementation goes to tier 2; review goes to a `reviewer` that is not the author (on a factory ticket, the factory `verifier`). A merge OK rests on the verifier's verdict plus the mechanical checks. A hub-side judgment call on a gate or ruleset, such as lifting a protection rule, goes to a `driver` or `escalate` advisor first. The hub keeps only work smaller than its brief. "Whatever the hub runs on" raises the tier only where the agent file or settings pin the driver's model (Claude Code; Copilot CLI through user settings). In Codex, opencode and pi the driver runs on the session's model unless its override sets one, so there the rule buys the role and the brief, not a tier: run the hub at the driver tier, or the judgement work in a separate session at that tier.
- **One rule for models on spawns.** A typed agent (`dev-tools:scout`, `driver`, `reviewer`, `escalate`, `factory:verifier`) carries its model and effort in its definition: pass neither on the spawn, since a spawn's values override it, except in the two cases Effort names: `high` effort for a `reviewer` or `verifier` on security or safety paths, and the factory verifier on Sonnet for trivial changes. An untyped spawn always pins its model: without one it inherits the session's, and `/model` changes it too, so a switch to a cheaper hub silently downgrades every inheriting spoke.
- **Escalate only after the driver failed twice on the same problem.** Compact first, since the new model re-pays the cache write for the whole conversation, and return to the driver once solved.
- **Reviewer is not the author.** Review important changes at the author's tier or higher.

## Effort

- `low`: quick, in-the-loop work.
- `medium`: normal engineering, verification, edge cases.
- `high`, `xhigh`, `max`: only when the user asks for them, with one exception below for security or safety paths.

Anything preset or automatic (agent definitions, settings, spawns you choose) stays at `medium` or below. Implement at `low` or `medium`, verify at `medium`. The one exception is a `reviewer` or `verifier` spawn for security or safety paths (input trust, auth and credentials, secrets and redaction, kill switch and halt, merge and release gates, protected paths), which goes to `high` on the spawn, as the `factory` plugin's routing table does for its `verifier`, whose preset is `medium`; for trivial changes (XS, docs-only, config-only) spawn the verifier on Sonnet at `medium`. These two are the only overrides a typed spawn takes. Nothing preset goes above `high`. More effort catches missed edge cases; it does not fix a wrong approach, so re-plan instead of raising it. Give every agent a way to check its work (a test, a build), or effort buys little.

## Delegation

- Fan out independent units (one per service, file or source). Briefs are self-contained: goal, scope, what to report, what "done" means. Subagents do not see the conversation.
- Check each report's evidence before accepting it, then consolidate into one output.
- Keep teams small: agent teams cost several times a normal session.
- Don't parallelize tightly coupled edits, and don't delegate work smaller than its brief.
- **Open questions go to the user, one at a time.** A `driver` reports the decisions that are the user's as open questions instead of guessing. Attended, name the `driver` spawn so it can be messaged, ask the user each question with the question tool, then send the answers to the same spoke so it keeps its context (Claude Code: a message to the named agent). Where it cannot be messaged, a new spawn's brief carries its report, the answers, and its worktree and branch, so it continues the work instead of starting over. On a factory ticket they are the ticket's question and park it (`ticket-run`); unattended, `unattended-runs` decides. Say in the brief whether the run is attended.
- If a subagent fails or returns something unexpected, surface its error and wait; don't silently retry or substitute.
- Before starting in a repo, check which other sessions are running and coordinate with any that overlap. Coordinate through the lightest channel that fits (brief and report, fork, message, shared file, doc or artifact, GitHub): [references/collaboration.md](references/collaboration.md).

## Waiting on other agents

- **Verdicts go somewhere durable.** A delegated reviewer or verifier posts its verdict where the waiting side can read it without a hand-back: a PR or MR comment opening with a fixed marker (`Review round N — verdict:`), or a file path named in the brief. The waiter polls that, and never waits on a hand-back or background notice that may not come; a report the spawn call actually returned also counts. Why: [references/collaboration.md](references/collaboration.md#durable-verdicts).
- **Decisions go in the brief.** A running teammate reads messages only between its turns, so a later message can land after it acted. Check it acted (the PR head, the comment) before relying on it.
- **The hub checks merges itself** (`gh pr view <n> --json state,mergeCommit`, or the forge's equivalent), never trusting a "will merge" or "merged" report.
- **At most 2 review rounds per PR.** Round 2 also re-reviews the round-1 fix diff for regressions. After round 2, fix Blockers, Majors and any regression, file Minors as issues, then `land` with checks green. Never merge with a known regression. A workflow with its own verdict channel and round rules (the `factory` verifier) keeps them.
- **Commits after approval need a hub check and a landing note** before the merge: `land` step 2.

## Mechanisms

Claude Code:
- `model` (`haiku`, `sonnet`, `opus`, `fable`) and `effort` on each spawn; both also in an agent definition.
- `CLAUDE_CODE_SUBAGENT_MODEL` is the default for subagents: the spawn's `model` wins, then the definition's `model`, then this variable, then the session's model (v2.1.251+; earlier versions let the variable override both). A definition's `model: inherit` beats the variable and keeps the session's model. The built-in `general-purpose` and `claude` agents follow this order; built-in Explore and Plan run on the session's model and ignore the variable. A family alias passed on a spawn or in a definition (`opus`) resolves to the session's exact model when it is of that family; the variable's alias always resolves to the alias's current version. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (v2.1.257+) forces the variable onto every subagent and drops spawn and definition models, which breaks tier routing: leave it unset. Source: [sub-agents](https://code.claude.com/docs/en/sub-agents#choose-a-model).
- `/model` and `/effort` change the session.
- Give a spawn a `name` only when you will message it, which an attended `driver` spawn always gets (its open questions come back to it): a named spawn's requests carry no agent name in telemetry, so its cost cannot be told apart from any other named spawn's. Pass `subagent_type` either way. A subagent that hit a fallback chain reports `model_swapped` and `final_model` on `subagent_completed`; record the swap as a deviation where a run tracks routing.
- This plugin ships `scout` (tier 1), `driver` and `reviewer` (tier 3) and `escalate` (tier 4). Spawn them by `subagent_type` (`dev-tools:driver`), which carries their model and effort, without a `model` override (Effort names the two exceptions); a plan-only brief to `driver` is how to plan; a routine tier 2 unit is a `general-purpose` spawn on Sonnet.

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
