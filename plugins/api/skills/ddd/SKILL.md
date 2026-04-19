---
name: ddd
description: >-
  Domain-Driven Design (DDD) with Hexagonal Architecture (Ports & Adapters).
  Use when designing bounded contexts, aggregates, domain events, application services,
  or working within a DDD/clean/hexagonal architecture. Activate when code touches
  domain models, repositories, use cases, commands, queries, ports, adapters, or
  context mapping. Follow these guidelines always.
metadata:
  version: "2.0"
---

# Domain-Driven Design (DDD) with Hexagonal Architecture

## Key Principles

- **Ubiquitous Language:** A shared language between developers and domain experts, reflected in code, docs, and conversation.
- **Bounded Contexts:** Isolate parts of the domain into autonomous contexts with explicit boundaries. Each context owns its model, language, and persistence.
- **Entities:** Objects with a distinct identity that persists over time. Private `__init__`, factory classmethods (`create`, `reconstitute`), immutable IDs.
- **Value Objects:** Immutable, self-validating objects defined by attributes, not identity. Implement `__eq__`/`__hash__` by value.
- **Aggregates:** Transactional consistency boundaries that enforce invariants. Only the aggregate root is repository-accessible.
- **Repositories:** Collection-like interfaces (`add`, `get`, `find_by_*`, `remove`) for persisting and retrieving aggregates. One per aggregate root.
- **Domain Services:** Stateless operations expressed in ubiquitous language that span multiple aggregates. RARE — most logic belongs in aggregates.
- **Factories:** Encapsulate complex aggregate creation. Use classmethods for simple cases (`create`, `reconstitute`), standalone Factory classes for complex multi-entity creation.

## Hexagonal Architecture (Ports & Adapters)

**Dependency Rule:** Dependencies point inward only. Domain knows nothing about infrastructure.

**Ports** (inside the hexagon — domain/application layer):
- **Driving (Primary) Ports:** How the outside world talks TO the application — use case interfaces, command/query contracts.
- **Driven (Secondary) Ports:** How the application talks to the outside world — repository interfaces, notification ports, payment gateways. Named after business needs, not technology.

**Adapters** (outside the hexagon — infrastructure layer):
- **Driving (Primary) Adapters:** HTTP controllers, CLI, message consumers — translate external input into port calls.
- **Driven (Secondary) Adapters:** PostgreSQL repository, SMTP email sender, Stripe client — implement driven port interfaces.

## Dependency Inversion Principle (DIP)

DIP (Robert C. Martin, 1996) is the **architectural principle** that makes hexagonal architecture enforceable. It is NOT Dependency Injection.

**Part A:** High-level modules must not depend on low-level modules. Both must depend on abstractions.
**Part B:** Abstractions must not depend on details. Details must depend on abstractions.

The word "inversion" means: in traditional layered design, domain imports infrastructure. DIP **inverts** this — infrastructure imports and implements domain-defined abstractions. The domain has zero knowledge of infrastructure.

**Ownership is the key:** The abstraction (Protocol) lives in the domain's package, defined in domain terms (`OrderRepository.add(order)`), not infrastructure terms (`DatabaseDriver.execute(sql)`). The infrastructure module depends on the domain's contract — never the reverse.

- Use `typing.Protocol` for DIP boundaries (structural subtyping, Pythonic, mypy-compatible).
- Apply DIP at **layer boundaries** (domain ↔ application ↔ infrastructure), not within a single module.

## Dependency Injection (DI) & Composition Root

DI (Martin Fowler, 2004) is a **technique** for providing dependencies from the outside. DIP decides the direction; DI decides the delivery.

| DI Type | Description | Use When |
|---------|-------------|----------|
| **Constructor injection** | Dependencies via `__init__` | Default for all services/handlers |
| **Parameter injection** | Dependencies per-call (FastAPI `Depends()`) | API layer, request-scoped deps |
| **Closures/partials** | `functools.partial` to bake in deps | Message bus handlers (Cosmic Python) |

**Composition Root** (Mark Seemann): The single location where the entire object graph is assembled. It is the **only place** allowed to know about all concrete implementations. In a DDD + FastAPI project, this is `api/dependencies/` — it imports from infrastructure and returns abstractions.

```
api/dependencies/     → COMPOSITION ROOT (imports concrete, returns abstract)
application/          → receives abstractions via constructor injection
domain/               → defines abstractions (Protocols), imports nothing
infrastructure/       → implements abstractions, imported only by composition root
```

**DI Anti-patterns — avoid these:**
- **Control Freak:** Class creates its own dependencies (`self._repo = PostgresRepo()`). Violates IoC.
- **Service Locator:** Global registry classes pull from (`ServiceLocator.get(Repo)`). Hides dependencies.
- **Bastard Injection:** Constructor defaults to concrete (`repo=None; self._repo = repo or PostgresRepo()`).

## Aggregate Design Rules (Vernon)

1. **Model true invariants** in consistency boundaries.
2. **Design small aggregates** — ~70% are just root entity + value objects.
3. **Reference other aggregates by identity only** — no direct object references.
4. **Use eventual consistency** outside the aggregate boundary.

## Domain Layer Rules

**NO I/O, NO frameworks, NO infrastructure dependencies.** Testable with minimal test doubles — domain logic needs no I/O mocks. Domain services using port interfaces require stubs/fakes.

- **Aggregates:** `domain/aggregates/{name}/` — co-locate root entity, child entities, and domain events. Entities collect events via `_domain_events: list[DomainEvent]`, expose `pull_domain_events()`.
- **Value Objects:** `domain/value_objects/` — immutable dataclasses, self-validating.
- **Specifications:** `domain/specifications/` — reusable business rule objects. `is_satisfied_by(candidate) -> bool`. Support `and`/`or`/`not` composition.
- **Repository Protocols:** `domain/repositories/` — collection-like interface per aggregate root.
- **Domain Ports:** `domain/ports/` — external system interfaces needed by domain logic (rare).
- **Domain Services:** `domain/services/` — pure, stateless, expressed in ubiquitous language. Use rarely.
- **Domain Errors:** `domain/errors/` — inherit from `DomainError`. No infrastructure references.
- **Domain Guards:** Invariant enforcement within entities/aggregates. Self-validating value objects, aggregate precondition checks. Use Specification pattern for complex composable rules.

## Application Layer Rules

**Thin orchestration.** Delegates all business logic to the domain. The handler IS the use case.

- **Commands:** `application/commands/` — command definitions + handlers. One handler per command. Handler opens UoW -> loads aggregates -> calls domain methods -> collects events -> commits -> publishes events. Pattern: `handle(command) -> Result`.
- **Queries:** `application/queries/` — query definitions + handlers. Read-only, no business logic. Query read models/projections optimized for the read side.
- **Event Handlers:** `application/events/` — react to domain events with side effects (send email, update analytics, notify). Must be idempotent.
- **Application Ports:** `application/ports/` — interfaces for external systems (email, payments, notifications, event publishers).
- **Policies:** `application/policies/` — cross-cutting concerns: authorization, rate limiting, idempotency, retries.
- **Unit of Work:** `application/uow.py` — transaction boundary interface. Context manager with `commit()`/`rollback()`.
- **Application Errors:** `application/errors/` — inherit from `ApplicationError`.
- **Application Guards:** Authorization checks, input validation at use case boundary, idempotency verification.

## Infrastructure Layer Rules

**Implements domain/application interfaces. All I/O lives here.**

- **Persistence:** `infrastructure/persistence/` — repositories, ORM models, mappers, UoW implementation.
- **Read Models:** `infrastructure/persistence/read_models/` — CQRS read-side projections and optimized query implementations.
- **Adapters:** `infrastructure/adapters/{category}/` — concrete implementations of port interfaces. Multiple implementations per port allowed (e.g., `SmtpEmailSender`, `SendGridEmailSender`).
- **Messaging:** `infrastructure/messaging/` — event bus, publishers, subscribers, dead letter queue.
- **Workers:** `infrastructure/workers/` — background processors, outbox consumers, scheduled jobs.
- **Config:** `infrastructure/config/` — environment variables, secrets, feature flags.
- **Infrastructure Errors:** Inherit from `InfrastructureError` — DB connection failures, HTTP errors.
- **Infrastructure Guards:** Rate limiting, circuit breakers, authentication token validation.
- **All implementations MUST explicitly inherit from their port protocols.**

## Shared Core

The `shared/` module is a **common library** (NOT a DDD Shared Kernel — see Context Mapping). It contains cross-cutting infrastructure and truly generic abstractions.

**Share when:** (1) identical semantics across ALL contexts, (2) changes are coordinated, (3) coupling is acceptable. **When in doubt, duplicate.**

| Share | Examples |
|-------|----------|
| Base types | `Entity`, `AggregateRoot`, `ValueObject`, `DomainEvent` base classes |
| Generic value objects | `Money`, `Email`, `PhoneNumber`, `Timestamp` — same semantics everywhere |
| Infrastructure | DB connection pools, logging config, telemetry, config management |
| API utilities | Error handlers, middleware, auth, common response types |
| Event bus | In-process pub/sub implementation |

| Keep per-context | Why |
|-------------------|-----|
| Context-specific value objects | `OrderStatus` means different things per context |
| Repository interfaces | Each context owns its persistence contracts |
| Application ports | Each context has unique external system needs |
| API schemas (request/response) | Each context owns its API surface |
| Domain errors | Business rule violations are context-specific |

## Context Mapping (Strategic Patterns)

Document relationships between bounded contexts using a Context Map.

| Pattern | Use When |
|---------|----------|
| **Anti-Corruption Layer (ACL)** | Protect your context from an external/legacy model. Translate at the boundary. |
| **Open Host Service (OHS)** | Expose a well-defined API for consumers. Pair with Published Language. |
| **Published Language** | Shared schema/protocol (OpenAPI, Protobuf, JSON Schema) for inter-context contracts. |
| **Customer-Supplier** | Upstream team serves downstream's needs with agreed-upon deliverables. |
| **Conformist** | Downstream adopts upstream's model as-is (no translation budget). |
| **Shared Kernel** | Two contexts co-own a small piece of model. Requires coordinated changes from both teams. |
| **Partnership** | Two teams synchronize releases and co-evolve. |
| **Separate Ways** | No integration — contexts are independent. |

## Event-Driven Architecture

- **Domain Events:** Internal to a bounded context. Raised by aggregates during state changes. Past-tense names (`OrderPlaced`, `PaymentReceived`). In-process dispatch.
- **Integration Events:** Cross-context, asynchronous, via message broker. Explicitly designed contracts with their own schemas. Must be versioned for schema evolution.
- **Event Bus:** In-process pub/sub for domain event handlers within a context.
- **Transactional Outbox:** Save aggregate + events atomically in the same DB transaction. A relay process publishes to the broker. Prevents dual-write problems.
- **Eventual Consistency:** Within an aggregate: strong consistency. Between aggregates: eventual consistency via domain events. Between contexts: eventual consistency via integration events.
- **Idempotency:** All event handlers must be idempotent — events may be delivered more than once.

## Saga / Process Manager

For workflows spanning multiple aggregates or bounded contexts:

- **Choreography:** Decentralized, event-based. Each step reacts to the previous event. Best for simple 2-3 step flows.
- **Orchestration (Saga):** Central coordinator dispatches commands and handles responses/compensations. Best for complex multi-step workflows.
- **Process Manager:** Stateful orchestrator with a state machine. Best for long-running processes with branching, timeouts, or human intervention.

Start with choreography. Move to orchestration when debugging/tracing becomes difficult.

## Services Taxonomy

- **Domain Services:** Pure business logic spanning multiple aggregates. Stateless, no I/O, expressed in ubiquitous language. RARE.
- **Application Services (Handlers):** Use case orchestration. UoW -> aggregates -> domain calls -> events -> commit. Thin, no business logic.
- **Infrastructure Services:** Technical capabilities (email, storage, caching). Implement port interfaces defined in domain/application.

## CQRS & Read Models

- **Write side:** Aggregates + repositories. Enforce invariants, raise events.
- **Read side:** Purpose-built DTOs/projections optimized for queries. Not domain models.
- **Separation:** Repositories are exclusively for aggregates. Read models have their own query implementations in infrastructure.
- Apply CQRS selectively — not every context needs separate read/write models.

## Naming Conventions

**Never suffix filenames with their architectural layer** (`_handler.py`, `_service.py`, `_repository.py`). The folder structure provides context. Domain type suffixes (`Command`, `Query`, `Result`, `Event`) are standard.

Use Python Protocols for port interfaces — no `I` prefix (use `EmailSender`, not `IEmailSender`). Name concrete implementations by technology (`SmtpEmailSender`, `PostgresOrderRepository`).

### Application DTOs

| Type | Pattern | Example |
|------|---------|---------|
| Command | `{Action}{Entity}Command` | `CreateShopCommand` |
| Command Result | `{Action}{Entity}Result` | `CreateShopResult` |
| Query | `Get{Entity}Query` | `GetUserQuery` |
| Query Result | `Get{Entity}Result` | `GetUserResult` |
| List Query | `List{Entities}Query` | `ListUsersQuery` |
| List Result | `List{Entities}Result` | `ListUsersResult` |

## Project Structure

See [references/PROJECT_STRUCTURE.md](references/PROJECT_STRUCTURE.md) for the full annotated folder structure with component placement rules.

## Additional References

- [references/DI_AND_DIP.md](references/DI_AND_DIP.md) — Deep dive on Dependency Inversion Principle, Dependency Injection, Composition Root, anti-patterns, and the full dependency flow.
