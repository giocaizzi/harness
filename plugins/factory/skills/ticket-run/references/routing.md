# Models, effort and cost per phase

Tiers, effort levels and escalation are `subagent-orchestration`'s; this is the fixed policy for a ticket. An untyped spawn (a Sonnet worker) sets its model and effort: without them it inherits the session's model, and its price. A typed agent (`dev-tools:scout`, `dev-tools:driver`, `factory:verifier`) carries its own; override it on the spawn only where this table says so: the verifier on Sonnet for docs, config or XS changes, and at `high` on security or safety paths.

## Policy

| Phase | Model | Effort |
|---|---|---|
| Lookups, logs, test-output reading | Haiku (scout tier); never for code edits | `low` |
| CI and merge waits | a background wait; else Haiku. Never a driver turn | `low` |
| Implement a clear XS/S unit from the plan | Sonnet | `medium` |
| Plan, split, integrate; M and larger or unclear work | Opus, as a `dev-tools:driver` spawn | `medium` |
| Verify docs, config or XS changes | Sonnet | `medium` |
| Verify code | Opus (the `verifier` preset) | `medium` |
| Verify security or safety paths | Opus | `high` |
| Escalate | per `subagent-orchestration`, after the driver failed twice on the same problem | |

**Security and safety paths** are any change to: input trust (who may trigger or approve), auth and credentials, secrets and redaction, a kill switch or halt, merge and release gates, protected paths. A repo may list its own in `.factory/config.yaml` (the `risk` tiers); a path in its highest tier counts too. A change that touches any of these is verified at `high`, whatever its size. Where the harness fixes effort in the agent definition, see [done.md](done.md#verify). Never above `high`.

The session running the ticket is the hub of the run (`subagent-orchestration`, Tiers), and only it spawns: in Claude Code a subagent cannot spawn subagents, so a driver cannot run the workers itself. Whatever the session's model, a `dev-tools:driver` spawn plans and splits; the session spawns the Sonnet workers for the clear XS/S units it returns; a `dev-tools:driver` spawn integrates them and runs the checks; M and larger or unclear work stays with the driver. The session only routes and checks mechanically (commit, CI, closing keyword, verifier verdict). Brief every driver spawn on a ticket to assume nothing: its open questions go on the ticket and park it.

## Deviations

The run may deviate from the table, but records each deviation with a reason in the run's checklist and in `result.json` (`routing`, [done.md](done.md#record)). A deviation is any actual model or effort that differs from the policy's, including a harness that downgraded a spawn. Repeated deviations are a signal to change the policy, not to keep deviating.

## When a phase struggles

Escalate in this order: add a check that exposes the problem, then raise the effort, then a bigger model. More effort catches missed edge cases; it does not fix a wrong approach, so on a wrong approach re-plan instead.

Never switch the model mid-session: it throws away the prompt cache. Switch through a subagent, or a new session handed a written brief (the checklist and the ticket's comments are most of it).

## Cost

A run costs its turns times the context each one resends, so the cheapest turn is the one not taken:

- Give every phase a real check (the component's tests or build) so it finds its mistakes early and finishes in fewer turns.
- Gather what a step needs in one pass and batch independent tool calls; do not re-read large files already in context.
- Wait with a background poll (`until <done>; do sleep 120; done`), not a turn per check.
- Record what `result.json` asks for (models, effort, tokens, turns, cost, sessions, host) as the harness reports it, so runs can be compared and joined to telemetry.
