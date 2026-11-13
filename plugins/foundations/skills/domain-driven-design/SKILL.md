---
name: domain-driven-design
description: "Use when a business rule must always hold (an invariant, or a state after which nothing may change), adding a use case to a service, rules spread across routes and queries, or money passed as primitives. House rules: DDD, ports and adapters."
---

# Domain-driven design with ports and adapters

Language-neutral rules; Go and Python specifics are in the references.

It is domain-driven design with ports and adapters (hexagonal architecture), also when the user does not say DDD.

## Opinions

1. **Dependencies point inward.** The domain imports no adapter, framework, ORM or HTTP package; the `architecture-fitness` skill turns that into a failing check.
2. **Aggregates are small**: a root plus value objects, referenced by id, one aggregate per transaction. Across aggregates, use events and accept eventual consistency.
3. **A port is named for the business need** (`InvoiceSender`) and declared by its consumer. Go: an interface in the consuming package (accept interfaces, return structs). Python: a `Protocol` the adapter inherits explicitly.
4. **One repository per aggregate root**, collection-like, persistence only. Read models are separate queries; CQRS only where reads differ from writes.
5. **A handler is thin**: load, call the domain, save, collect events, commit through the unit of work. Publish events from the outbox, never before the commit.
6. **The composition root is the only place that imports concrete adapters** (Go `cmd/<app>/main.go`, Python the app factory). No DI container, no service locator.
7. **`shared/` is a library, not a Shared Kernel.** When in doubt, duplicate across contexts.
8. **A CRUD context with no invariants gets no aggregates**: a plain layered module is fine.
9. **Folders by layer, features inside each layer.** No layer suffix in file names, no `I` prefix.

## Gotchas

- An ORM model returned as an entity lazy-loads after the session closes.
- An event published before the commit is a dual write: a crash between the two loses or invents it.
- A Go interface declared in the adapter package inverts the direction and invites import cycles.
- A repository returning screen DTOs is a read model in disguise.
- DIP is where the abstraction lives, not that one exists; DI only delivers the dependency.

## References

- [references/LAYERS_AND_PATTERNS.md](references/LAYERS_AND_PATTERNS.md): read when placing a component in a layer, choosing a context-mapping pattern, applying aggregate rules, or designing events and sagas.
- [references/GO.md](references/GO.md): read for the Go layout and the port, adapter and composition-root signatures.
- [references/PYTHON.md](references/PYTHON.md): read for the Python port and unit-of-work signatures.
- [references/REFERENCES.md](references/REFERENCES.md): bibliography.
