---
name: design-patterns
description: "Use when deciding whether to add an interface, base class, factory or layer, when the same code is copied or wrapped in several places, or when reviewing a design for over-engineering. Which pattern fits."
---

# Design patterns

Not abstracting is the default. A pattern earns its place by removing a cost you can point at in this code, not by being available.

- **Rule of three.** Extract on the third copy, not the second. Two similar things may still diverge.
- **One implementation, no interface**, unless a test needs the seam. The second implementation introduces it, declared by the consumer, next to the code that uses it.
- **SOLID is a set of review questions, not goals.** Does this class have one reason to change? Can a new case be added without editing this branch? Can any implementation replace another without surprising the caller? Does the caller depend on methods it never uses? Does the policy depend on a detail it could receive instead?
- **High cohesion inside a module, low coupling across modules.** Things that change together live together; a change in one module should not force edits in three others.
- **Composition over inheritance.** Inherit only for framework hooks, exceptions and shallow hierarchies you own.

## Catalogue

One line each: use when / not when / owner. Detail in [references/CATALOGUE.md](./references/CATALOGUE.md).

- **Ports and adapters**: use when the domain must not know its I/O (database, queue, third party); not when the code is a thin script. Owner: `domain-driven-design`.
- **Repository and unit of work**: use when an aggregate is loaded and saved as one consistent unit; not for read models or a CRUD table with no rules. Owner: `domain-driven-design`.
- **Domain events with outbox**: use when another context must learn of a change without a dual write; not when one process owns both effects in one transaction. Owner: `domain-driven-design` (events), `system-design` (outbox).
- **Anti-corruption layer**: use when an upstream model would leak its terms into yours; not for a stable API you can adopt as is. Owner: `domain-driven-design`.
- **Strategy**: use when three or more interchangeable behaviours are chosen at runtime; not for two branches (an `if`). Owner: this skill.
- **Decorator for cross-cutting concerns**: use for retry, timeout, logging, caching or metrics wrapped around one interface; not to add business rules. Owner: this skill.
- **Composition root**: use always, once, in `main`: build collaborators there and pass them down; not a DI container or service locator. Owner: this skill (language skills show the form).
- **Idempotent consumer**: use for any at-least-once message handler; not for a handler whose effect is naturally repeatable. Owner: `system-design`.

Named anti-patterns, each with symptom and fix: [references/ANTI_PATTERNS.md](./references/ANTI_PATTERNS.md).

## Gotchas

- A strategy for two branches is just an `if`.
- Decorator order matters: a retry wraps the timeout, not the reverse, and logging goes outside both to see every attempt.
- A DI container drifts into a service locator; constructor parameters and one composition root do the same job.
- A module-level client is a singleton under another name, and tests cannot replace it.
- A base class added "for reuse" couples every subclass to its changes; extract a function or inject a collaborator instead.
