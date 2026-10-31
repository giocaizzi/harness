---
name: subagent-orchestration
description: Load first, before reading or editing code, whenever the user asks you to plan, design, investigate, find a root cause, fix a bug, build a feature or review a change - the main session routes that work to a typed agent instead of doing it. Also when spawning subagents, splitting work in parallel, escalating after failed attempts, coordinating with other running sessions, waiting on a review verdict, or choosing a model or effort. Claude Code, Copilot CLI, Codex, opencode and pi.
---

# Subagent orchestration

The main session (the hub) routes, tracks state and checks; typed agents do the work, each carrying the model and effort its role needs. Model is how capable, effort is how thorough: routine work runs on the smaller model, judgement on the larger one, and only verification of a sensitive change runs at higher effort.

## Who does what

This plugin's agents (`dev-tools:<name>` in Claude Code; a harness that lists agents by bare name uses the name, and Codex registers the worker as `dev-tools-worker`):

| Work | Agent |
|---|---|
| Lookups: find code, read logs, triage test output | `scout` |
| Edits whose every decision is already made: a written plan or a unit of one, a rename, a config rollout | `worker`, one per file-disjoint unit |
| Anything that needs judgement, however small: a plan, a design, an investigation, a root-cause fix, a feature, the fix for a review finding | `driver` (a plan-only brief to plan), which fans its edits out to `worker`s |
| Work a `driver` failed twice on | `escalate`, briefed with both reports and the worktree |
| Review before merge | `reviewer` at the routine tier, raised on the spawn for a sensitive review; it never reviews its own change |

- **The hub does only mechanical work itself:** a lookup it can answer in one or two tool calls, commits, CI and merge checks (commit hash, green CI, closing keyword, merged state), relaying between sessions and the user. It edits no files: a plan's edits, however fully specified, go to `worker`s. A judgement call on a gate or ruleset, such as lifting a protection rule, goes to a `driver` first.
- **The driver decides, workers edit.** A driver plans, splits the edits into units that touch disjoint files and spawns one `worker` per unit, all at once; it edits only the integration glue, or about 20 lines in at most 2 files. Where the harness lets a subagent spawn ([references/harnesses.md](references/harnesses.md)), the driver fans out itself; elsewhere it returns the split and the hub spawns the workers.
- **Raise only a sensitive review.** A review is sensitive when the change touches any of: security or input trust; auth and credentials; secrets and redaction; a kill switch or halt; merge and release gates; protected paths; a core process (what every run or every user goes through: billing, deploys, migrations, the routing and guard rules themselves); or when it is large or hard to reverse: 5 files or more, 150 changed lines or more (`git diff --shortstat <base>...`), or an effect a revert does not undo (data deleted or migrated, a release published, history rewritten). Spawn `reviewer` for it with `model: opus` and `effort: high` on the spawn. Every other review spawns `reviewer` with neither, and no other spawn passes a `model` or an `effort`. Nothing goes above `high`; `xhigh` or `max` only when the user asks. More effort catches missed edge cases but does not fix a wrong approach, so re-plan instead. Where the harness cannot raise a spawn, run the sensitive review in a session at the driver tier.
- **Fixes go back to the author's tier.** A `CHANGES` verdict goes to the `driver` that wrote the change (a message to it by name, or a new spawn briefed with the verdict and the worktree); a purely mechanical fix may go to a `worker`.
- **The hub's own tier depends on the harness.** Where agents pin their own model (Claude Code; Copilot CLI through user settings), run the hub on the routine tier. In Codex, opencode and pi spokes take the hub's model, so run the hub, or the judgement work in its own session, at the driver tier. Tiers and mechanisms per harness: [references/harnesses.md](references/harnesses.md).

A workflow skill that defines its own gate, question channel, round cap or model table overrides this skill where they differ.

## Briefs and reports

- **One unit, one worker, all at once.** N file-disjoint units are N `worker` spawns in a single message, never one worker for all of them or one spawn after another. Units that share a file go to the same worker, or run in sequence. Don't parallelize tightly coupled edits.
- **Parallel workers need their own files, or their own worktrees.** In Claude Code the `worker` definition gives each one an isolated worktree, branched from the default branch, so the brief names the base branch the worker starts from and the driver or hub merges each unit's branch. Where the harness has no worktree isolation, workers share one checkout: the units must be file-disjoint and the hub serialises any that overlap.
- Brief a batch, not one issue per spawn: related issues that can land in one review go to one driver, one worktree and one PR (`github-workflow`, Landing a change), and the brief says so. The driver splits that batch into workers' units. Every brief carries the batching rule (`github-workflow`, Landing a change, rule 1).
- A brief that ends in a PR names `github-workflow`'s Landing a change rules 4, 5 and 7-9 (stacking, the check on the merged tree, folding every related finding in before review, and what may change after a verdict), and the self-check before hand-back ([references/pre-review.md](references/pre-review.md)). The hub lands approved PRs together with `land`'s `land-many`, never one at a time.
- **Report once, then stay quiet.** A spoke or peer that has delivered its report sends nothing more until it is asked or its state changes: an idle notice that restates a delivered report costs the receiver a turn. Say so in the brief.
- Say in every brief whether the run is attended, and check each report's evidence before relying on it.
- **Open questions go to the user, one at a time.** A `driver` or `escalate` reports the decisions that are the user's instead of guessing. Attended, name the spawn so it can be messaged, ask the user each question with the question tool, then send the answers to the same spoke so it keeps its context. Where it cannot be messaged, a new spawn's brief carries its report, the answers, and its worktree and branch, so it continues instead of starting over. Unattended, `unattended-runs` decides.
- Other running sessions, channels between agents, verdicts and review rounds: [references/collaboration.md](references/collaboration.md). The author's self-check before review: [references/pre-review.md](references/pre-review.md).

## Waiting on other agents

A wait ends on every terminal outcome, never on success alone: a loop until a PR merges never returns once a required check fails. Wait on a PR with `land`'s `wait-pr` script. Inside a teammate, wait in the foreground ([collaboration.md](references/collaboration.md#durable-verdicts)).

- **The deadline lives inside the command** (`wait-pr --timeout`, or a loop that counts its polls): the command exiting is what wakes the session. In an interactive Claude Code session the Bash tool's timeout is ignored for a background command; a Monitor wakes the session when its `timeout_ms` expires (at most 30 min).
- Where a background exit is not known to wake the session (not checked in Copilot CLI, Codex, opencode or pi), also set that harness's own timer when it has one.
- After a network or host drop, check each PR and session before resuming: [references/network-drop.md](references/network-drop.md).

## Gotchas

- Built-in Plan and Explore agents run on the session's model and ignore `CLAUDE_CODE_SUBAGENT_MODEL`: plan with `driver`, look up with `scout`.
- An untyped spawn (`general-purpose`, `claude`) inherits `CLAUDE_CODE_SUBAGENT_MODEL` or the session's model, so a `/model` switch on the hub silently re-prices it: spawn `worker` instead.
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` drops every agent's own model and breaks the routing, and `CLAUDE_CODE_EFFORT_LEVEL` overrides every spawn's effort, the raise included: leave both unset.
- A per-spawn `effort` needs Claude Code 2.1.292 or later; an older one runs the reviewer at its definition's effort.
- Claude Code nests subagents three layers below the hub by default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; `1` turns nesting off), so a driver spawns its own workers. `worker`, `scout` and `reviewer` have no spawn tool, so they are leaves. At the limit the spawn tool is withheld: the driver returns the split.
- A nested spawn's report is lost once its parent's turn ends: a reviewer posts its verdict to a durable channel ([collaboration.md](references/collaboration.md#durable-verdicts)).
- With agent teams off, a named spawn stays an ordinary subagent, tracked in telemetry. With agent teams on, a spawn from the main session that has a `name` starts as a teammate instead: its requests carry no agent id or name, so its spend is unattributed, and it runs in the main checkout whatever its definition's `isolation` says. Keep agent teams off, and name a spawn only when you will message it, which an attended `driver` always gets.
- In Codex, opencode and pi an agent's model pin does nothing: it runs on the session's model.
- Escalating is a spawn, never `/model` on the hub: a switch re-pays the prompt cache for the whole conversation.
- A typed agent that is missing (its plugin not installed) or fails: stop and say so. A general-purpose substitute runs on whatever model it inherits.
