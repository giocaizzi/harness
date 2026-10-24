# Models and effort per phase

Roles, spawn rules, effort and escalation are `dev-tools`' `subagent-orchestration`; this is a ticket run's fixed policy on top of it.

## Policy

| Phase | Agent | Model, effort |
|---|---|---|
| Lookups, logs, test-output reading | `dev-tools:scout` | Haiku, `low` |
| CI and merge waits | a background poll (`until <done>; do sleep 120; done`), never an agent turn | |
| The plan comment, size and risk tier, scope and fold-in calls, integration, fixes for verifier findings; anything unclear | `dev-tools:driver` | Opus, `medium` |
| A clear unit from the plan | `dev-tools:worker` | Sonnet, `medium` |
| Verify code | `factory:verifier`, no override | Opus, `medium` |
| Verify docs, config or XS changes | `factory:verifier`, `model: sonnet` on the spawn | Sonnet, `medium` |
| Verify security or safety paths | `factory:verifier`, `effort: high` on the spawn | Opus, `high` |
| Escalate, after a driver failed twice on the same problem | `dev-tools:escalate`, while the run's budget allows | Fable, `medium` |

Agent names are Claude Code's (`<plugin>:<agent>`). A harness that lists agents by bare name uses `scout`, `driver`, `worker`, `escalate` and `verifier`, except Codex, which registers the worker as `dev-tools-worker`.

**Security and safety paths** are `subagent-orchestration`'s list plus any path in the repo's highest `risk` tier (`.factory/config.yaml`), whatever the change's size. Where the harness fixes effort in the agent definition, see [done.md](done.md#verify).

**Workers' worktrees.** Parallel workers each get their own worktree on a branch off the ticket branch (`isolation: worktree`); sequential workers may share the ticket worktree. The integrating driver merges their branches into the ticket branch.

## Deviations

The run may deviate from the table, but records each deviation with a reason in the run's checklist and in `result.json` (`routing`, [done.md](done.md#record)). A deviation is any actual model or effort that differs from the policy's, including a harness that downgraded a spawn. Repeated deviations are a signal to change the policy, not to keep deviating. Record the models, effort, tokens, turns, cost and sessions `result.json` asks for as the harness reports them, so runs can be compared and joined to telemetry.
