# Models, effort and cost per phase

Tiers, effort levels and escalation are `subagent-orchestration`'s; this is how they map onto a ticket. Set the model and effort explicitly on every spawn: a subagent with neither inherits the session's model, and its price.

| Phase | Model | Effort |
|---|---|---|
| Lookups, log and test-output reading | scout tier (Haiku or Sonnet); never for code edits | `low` |
| Implement XS and S with clear acceptance checks | Sonnet | `low`-`medium` |
| Implement M and larger, or brownfield work without a clear spec | Opus | `medium` |
| Verify a non-trivial change | Opus (the `verifier` preset) | `high` |
| Verify a trivial change (XS, docs-only, config-only) | Sonnet | `medium`, or `low` under a deterministic check |
| Escalate | per `subagent-orchestration`, after the driver failed twice on the same problem | |

When a phase struggles, escalate in this order: add a check that exposes the problem, then raise the effort, then a bigger model. More effort catches missed edge cases; it does not fix a wrong approach, so on a wrong approach re-plan instead.

Never switch the model mid-session: it throws away the prompt cache. Switch through a subagent, or a new session handed a written brief (the checklist and the ticket's comments are most of it).

## Cost

A run costs its turns times the context each one resends, so the cheapest turn is the one not taken:

- Give every phase a real check (the component's tests or build) so it finds its mistakes early and finishes in fewer turns.
- Gather what a step needs in one pass and batch independent tool calls; do not re-read large files already in context.
- Record what `result.json` asks for (models, effort, tokens, turns, cost, sessions, host) as the harness reports it, so runs can be compared and joined to telemetry.
