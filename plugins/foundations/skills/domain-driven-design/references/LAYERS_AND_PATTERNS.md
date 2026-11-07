# Layer placement, strategic and event patterns

Read when deciding where a component lives, mapping contexts, designing events and sagas, or naming DTOs. Names are language-neutral; the language references give the file layout.

## Domain layer (no I/O, no frameworks)

- Aggregates: the root, its child entities and the domain events it raises. The root collects events and hands them out (`pull events`) after the operation.
- Value objects: immutable, self-validating, equal by value.
- Specifications: a composable predicate (`isSatisfiedBy(candidate)`, and/or/not) for complex reusable rules.
- Repository ports: one per aggregate root.
- Other ports the domain itself needs (rare).
- Domain services: pure, stateless, in the ubiquitous language; only for logic spanning aggregates (rare).
- Domain errors: no infrastructure references.

## Application layer (thin orchestration)

- Commands: a command plus its handler, one handler per command: open the unit of work, load aggregates, call the domain, collect events, commit.
- Queries: read-only handlers over read models.
- Event reactions with side effects (email, analytics): idempotent.
- Ports: email, payments, notifications, event publishers.
- Policies: authorization, rate limiting, idempotency, retries.
- Unit of work: the transaction boundary with commit and rollback.

## Adapter layer (all I/O)

- Persistence: repositories, ORM or SQL models, mappers, the unit-of-work implementation, read models for the CQRS read side.
- Port implementations, several per port allowed (SMTP and a hosted email API).
- Messaging: event bus, publishers, subscribers, dead-letter queue.
- Workers: background processors, outbox relays, scheduled jobs.
- Driving adapters (HTTP, CLI, consumers) translate the transport to a command or query and back; no business logic.
- Config: environment, secrets, feature flags.

## Shared core

| Share (identical semantics in ALL contexts) | Keep per context |
|---|---|
| Entity, aggregate root, value object and event base types | Context-specific value objects (an order status differs per context) |
| Generic value objects: money, email, phone number, timestamp | Repository ports |
| DB pools, logging, telemetry, config | Application ports |
| Error handlers, middleware, auth, common responses | API schemas |
| In-process event bus | Domain errors |

## Context mapping

| Pattern | Use when |
|---|---|
| Anti-Corruption Layer | Protect your model from an external or legacy one; translate at the boundary |
| Open Host Service + Published Language | Expose a well-defined API or schema (OpenAPI, Protobuf) to many consumers |
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

- Domain services: pure business logic spanning aggregates. Stateless, no I/O. Rare.
- Application services (handlers): use-case orchestration. Thin, no business logic.
- Infrastructure services: technical capabilities (email, storage, caching) implementing ports declared by the domain or application.

## Events and sagas

- Domain events: internal to a context, past tense (`OrderPlaced`), in-process.
- Integration events: cross-context, asynchronous via a broker, own versioned schema.
- Transactional outbox: persist the aggregate and its events in one transaction; a relay publishes. Avoids dual writes.
- Consistency: strong within an aggregate, eventual between aggregates (domain events) and between contexts (integration events).
- Workflows spanning aggregates or contexts:
  - Choreography: decentralised, each step reacts to the previous event. Best for simple 2-3 step flows.
  - Orchestration (saga): a central coordinator dispatches commands and handles responses and compensations. Best for complex multi-step workflows.
  - Process manager: a stateful orchestrator with a state machine. Best for long-running processes with branching, timeouts or human steps.
  - Start with choreography; move to orchestration when tracing gets hard.

## Application DTO naming

| Type | Pattern |
|---|---|
| Command / result | `{Action}{Entity}Command` / `{Action}{Entity}Result` |
| Query / result | `Get{Entity}Query` / `Get{Entity}Result` |
| List query / result | `List{Entities}Query` / `List{Entities}Result` |
