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

More effort catches missed edge cases; it does not fix a wrong approach. On a wrong approach, re-plan instead of raising the effort.

## Cost

A run costs its turns times the context each one resends, so the cheapest turn is the one not taken:

- Give every phase a real check (the component's tests or build) so it finds its mistakes early and finishes in fewer turns.
- Gather what a step needs in one pass and batch independent tool calls; do not re-read large files already in context.
- Record `harness`, `model`, `effort`, `turns` and `cost_usd` in `result.json` when the harness exposes them, so runs can be compared.
