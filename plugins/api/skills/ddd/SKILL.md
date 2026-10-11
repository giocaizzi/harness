---
name: ddd
description: Domain-Driven Design with Hexagonal Architecture (ports and adapters) in Python. Use when designing bounded contexts, aggregates, domain events, use-case handlers, repositories, ports/adapters, or context maps.
---

# DDD with Hexagonal Architecture

Dependencies point inward only: domain knows nothing about application or infrastructure, so it stays testable without I/O mocks.

## Modeling opinions

- Aggregates are small consistency boundaries (usually root + value objects). Reference other aggregates by identity only; use eventual consistency across them, because large aggregates cause lock contention and tangled invariants.
- Entities: private `__init__`, factory classmethods (`create`, `reconstitute`), immutable ids. Value objects: immutable, self-validating, equal by value.
- One repository per aggregate root, collection-like (`add`, `get`, `find_by_*`, `remove`), persistence only. Read models/projections are not repositories; give them their own query implementations in infrastructure. Apply CQRS selectively, not every context needs it.
- Domain services are rare; most logic belongs in aggregates. Handlers are thin: UoW, load, call domain, collect events, commit, publish. Business logic in a handler is a smell.
- Event handlers must be idempotent (at-least-once delivery). Cross-context events are versioned integration events, not domain events; use a transactional outbox rather than dual writes.
- Sagas: start with choreography, move to orchestration when tracing gets hard.

## Ports and adapters

- Driven ports are named for business needs (`OrderRepository`, `EmailSender`), not technology. Define them as `typing.Protocol` in the domain/application package; implementations (`PostgresOrderRepository`, `SmtpEmailSender`) live in infrastructure and explicitly inherit the Protocol so drift is caught by the type checker.
- DIP is about ownership and direction: the abstraction lives with the consumer, in domain terms. It is not Dependency Injection, which only delivers the dependency. Apply DIP at layer boundaries, not inside a module.
- Constructor injection by default. The composition root (in FastAPI projects `api/dependencies/`) is the only place importing concrete implementations. Avoid Control Freak (class builds its own deps), Service Locator, and Bastard Injection (`repo or PostgresRepo()` default).

## Sharing across contexts

`shared/` is a common library, not a DDD Shared Kernel. Share only base types, truly generic value objects, and cross-cutting infrastructure with identical semantics everywhere. When in doubt, duplicate, because coupling between contexts costs more than duplicated code.

## Naming

- No layer suffix in filenames (`_handler.py`, `_service.py`, `_repository.py`): the folder already says it. Type suffixes (`Command`, `Query`, `Result`, `Event`) are fine.
- No `I` prefix on Protocols; name implementations by technology.

## References

- [references/LAYERS_AND_PATTERNS.md](references/LAYERS_AND_PATTERNS.md): read when placing a component in a layer, choosing a context-mapping pattern, applying the aggregate rules or services taxonomy, designing events/sagas (choreography vs orchestration vs process manager), or naming command/query DTOs.
- [references/PROJECT_STRUCTURE.md](references/PROJECT_STRUCTURE.md): read when scaffolding or auditing the annotated folder tree.
- [references/DI_AND_DIP.md](references/DI_AND_DIP.md): read for the DIP vs DI deep dive, the DI injection-type table (constructor / parameter / partial), anti-patterns, and dependency flow.
- [references/REFERENCES.md](references/REFERENCES.md): bibliography.
