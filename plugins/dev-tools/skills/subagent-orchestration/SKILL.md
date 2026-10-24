---
name: subagent-orchestration
description: Use before starting work that needs a plan, a design, an investigation, a root-cause fix, a feature or a review, to route it to the agent that does it rather than doing it in the main session; and when spawning a subagent, splitting work in parallel, escalating after failed attempts, coordinating with other running sessions, waiting on a reviewer's verdict or capping review rounds, or choosing a model or effort. Claude Code, Copilot CLI, Codex, opencode and pi.
---

# Subagent orchestration

The main session (the hub) routes, tracks state and checks; typed agents do the work, each carrying the model and effort its role needs. Spend model power where judgement decides the outcome, not on lookups or on the hub.

## Who does what

This plugin's agents (`dev-tools:<name>` in Claude Code; a harness that lists agents by bare name uses the name, and Codex registers the worker as `dev-tools-worker`):

| Work | Agent |
|---|---|
| Lookups: find code, read logs, triage test output | `scout` |
| Edits whose every decision is already made: a written plan or a unit of one, a rename, a config rollout | `worker` |
| Anything that needs judgement, however small: a plan, a design, an investigation, a root-cause fix, a feature, the fix for a review finding | `driver` (a plan-only brief to plan) |
| Work a `driver` failed twice on | `escalate`, briefed with both reports and the worktree |
| Review before merge | `reviewer`, which never reviews its own change |

- **The hub does only mechanical work itself:** a lookup it can answer in one or two tool calls, commits, CI and merge checks (commit hash, green CI, closing keyword, merged state), relaying between sessions and the user. A judgement call on a gate or ruleset, such as lifting a protection rule, goes to a `driver` first.
- **The one effort override** is `high` for a review or gate of a change on a security or safety path: input trust, auth and credentials, secrets and redaction, kill switch and halt, merge and release gates, protected paths. Nothing preset goes above `high`; `xhigh` or `max` only when the user asks. More effort catches missed edge cases but does not fix a wrong approach, so re-plan instead.
- **Fixes go back to the author's tier.** A `CHANGES` verdict goes to the `driver` that wrote the change (a message to it by name, or a new spawn briefed with the verdict and the worktree); a purely mechanical fix may go to a `worker`.
- **The hub's own tier depends on the harness.** Where agents pin their own model (Claude Code; Copilot CLI through user settings), run the hub on the routine tier. In Codex, opencode and pi spokes take the hub's model, so run the hub, or the judgement work in its own session, at the driver tier. Tiers and mechanisms per harness: [references/harnesses.md](references/harnesses.md).

A workflow skill that defines its own gate, question channel, round cap or model table overrides this skill where they differ.

## Briefs and reports

- Fan out independent units; don't parallelize tightly coupled edits. Parallel editors each get their own worktree (`isolation: worktree`, `wt`).
- Say in every brief whether the run is attended, and check each report's evidence before relying on it.
- **Open questions go to the user, one at a time.** A `driver` or `escalate` reports the decisions that are the user's instead of guessing. Attended, name the spawn so it can be messaged, ask the user each question with the question tool, then send the answers to the same spoke so it keeps its context. Where it cannot be messaged, a new spawn's brief carries its report, the answers, and its worktree and branch, so it continues instead of starting over. Unattended, `unattended-runs` decides.
- Other running sessions, channels between agents, verdicts and review rounds: [references/collaboration.md](references/collaboration.md).

## Gotchas

- Built-in Plan and Explore agents run on the session's model and ignore `CLAUDE_CODE_SUBAGENT_MODEL`: plan with `driver`, look up with `scout`.
- An untyped spawn (`general-purpose`, `claude`) inherits `CLAUDE_CODE_SUBAGENT_MODEL` or the session's model, so a `/model` switch on the hub silently re-prices it: spawn `worker` instead.
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` drops every agent's own model and breaks the routing: leave it unset.
- A subagent cannot spawn subagents in Claude Code: only the hub spawns, so a `driver` returns a split and the hub spawns the workers.
- A nested spawn's report is lost once its parent's turn ends: a reviewer posts its verdict to a durable channel ([collaboration.md](references/collaboration.md#durable-verdicts)).
- A named spawn's requests carry no agent name in telemetry: name a spawn only when you will message it, which an attended `driver` always gets.
- In Codex, opencode and pi an agent's model pin does nothing: it runs on the session's model.
- Escalating is a spawn, never `/model` on the hub: a switch re-pays the prompt cache for the whole conversation.
- A typed agent that is missing (its plugin not installed) or fails: stop and say so. A general-purpose substitute runs on whatever model it inherits.
