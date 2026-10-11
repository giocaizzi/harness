# Layer Placement, Strategic and Event Patterns

Read when deciding where a component lives, mapping contexts, designing events/sagas, or naming DTOs.

## Domain layer (`domain/`, no I/O, no frameworks)

- `aggregates/{name}/`: root, child entities, domain events. Aggregates collect events in `_domain_events` and expose `pull_domain_events()`.
- `value_objects/`: immutable, self-validating dataclasses.
- `specifications/`: `is_satisfied_by(candidate) -> bool`, composable with and/or/not. Use for complex reusable rules.
- `repositories/`: one Protocol per aggregate root.
- `ports/`: external systems the domain itself needs (rare).
- `services/`: pure, stateless, ubiquitous language (rare).
- `errors/`: inherit `DomainError`, no infrastructure references.

## Application layer (`application/`, thin orchestration)

- `commands/`: command + handler, one handler per command. Handler: open UoW, load aggregates, call domain, collect events, commit, publish. `handle(command) -> Result`.
- `queries/`: read-only handlers over read models/projections.
- `events/`: reactions with side effects (email, analytics). Must be idempotent.
- `ports/`: email, payments, notifications, event publishers.
- `policies/`: authorization, rate limiting, idempotency, retries.
- `uow.py`: transaction boundary, context manager with `commit()`/`rollback()`.
- `errors/`: inherit `ApplicationError`.

## Infrastructure layer (`infrastructure/`, all I/O)

- `persistence/`: repositories, ORM models, mappers, UoW implementation; `persistence/read_models/` for CQRS read side.
- `adapters/{category}/`: port implementations; several per port allowed (`SmtpEmailSender`, `SendGridEmailSender`).
- `messaging/`: event bus, publishers, subscribers, dead-letter queue.
- `workers/`: background processors, outbox consumers, scheduled jobs.
- `config/`: env, secrets, feature flags.
- Errors inherit `InfrastructureError`. Implementations explicitly inherit their port Protocols so type checkers catch drift.

## Shared core

| Share (identical semantics in ALL contexts) | Keep per-context |
|---|---|
| `Entity`, `AggregateRoot`, `ValueObject`, `DomainEvent` bases | Context-specific value objects (`OrderStatus` differs per context) |
| Generic VOs: `Money`, `Email`, `PhoneNumber`, `Timestamp` | Repository interfaces |
| DB pools, logging, telemetry, config | Application ports |
| Error handlers, middleware, auth, common responses | API schemas |
| In-process event bus | Domain errors |

## Context mapping

| Pattern | Use when |
|---|---|
| Anti-Corruption Layer | Protect your model from an external/legacy one; translate at the boundary |
| Open Host Service + Published Language | Expose a well-defined API/schema (OpenAPI, Protobuf) to many consumers |
| Customer-Supplier | Upstream serves downstream's needs with agreed deliverables |
| Conformist | Downstream adopts upstream's model as-is |
| Shared Kernel | Two contexts co-own a small model; needs coordinated changes |
| Partnership | Teams co-evolve and sync releases |
| Separate Ways | No integration |

## Aggregate design rules (Vernon)

1. Model true invariants in consistency boundaries.
2. Design small aggregates: about 70% are just a root entity plus value objects.
3. Reference other aggregates by identity only, never by direct object reference.
4. Use eventual consistency outside the aggregate boundary.

## Services taxonomy

- Domain services: pure business logic spanning multiple aggregates. Stateless, no I/O, in ubiquitous language. Rare.
- Application services (handlers): use-case orchestration: UoW, aggregates, domain calls, events, commit. Thin, no business logic.
- Infrastructure services: technical capabilities (email, storage, caching). Implement port interfaces defined in domain/application.

## Events and sagas

- Domain events: internal to a context, past tense (`OrderPlaced`), in-process.
- Integration events: cross-context, async via broker, own versioned schema.
- Transactional outbox: persist aggregate and events in one transaction; a relay publishes. Avoids dual writes.
- Consistency: strong within an aggregate, eventual between aggregates (domain events) and between contexts (integration events).
- Workflows spanning multiple aggregates or contexts:
  - Choreography: decentralized, event-based; each step reacts to the previous event. Best for simple 2-3 step flows.
  - Orchestration (saga): a central coordinator dispatches commands and handles responses and compensations. Best for complex multi-step workflows.
  - Process manager: stateful orchestrator with a state machine. Best for long-running processes with branching, timeouts or human intervention.
  - Start with choreography; move to orchestration when debugging or tracing becomes difficult.

## Application DTO naming

| Type | Pattern |
|---|---|
| Command / result | `{Action}{Entity}Command` / `{Action}{Entity}Result` |
| Query / result | `Get{Entity}Query` / `Get{Entity}Result` |
| List query / result | `List{Entities}Query` / `List{Entities}Result` |
