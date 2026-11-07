# Anti-patterns

Symptom, then fix.

## Premature abstraction

Symptom: an interface, abstract base class or factory with one implementation; a `*Factory`, `*Manager` or `Base*` name; a change that touches the abstraction and its one implementation together.
Fix: inline it. Reintroduce the abstraction on the second implementation, declared by the consumer.

## Global state and singletons

Symptom: a module-level client, connection or settings object imported everywhere; tests that patch an import path; order-dependent tests.
Fix: construct it in `main` and pass it as a constructor parameter.

## Service locator

Symptom: code calls `container.get(Thing)` or a registry at runtime; a dependency is visible only by reading the body; a DI container used in domain code.
Fix: list collaborators as constructor parameters; the composition root is the only place that knows the wiring.

## Anemic god-service

Symptom: a `*Service` with dozens of methods holding all the rules, over entities that are bags of fields.
Fix: move each rule to the object whose data it uses (an aggregate or value object), and split the service by use case.

## Inheritance for reuse

Symptom: a subclass overrides half the parent and calls `super()` in the rest; a hierarchy three levels deep to share a helper.
Fix: extract a function or inject a collaborator. Inherit only for framework hooks, exceptions and shallow hierarchies you own.

## ORM models leaking into the domain

Symptom: domain code imports the ORM base class; a rule needs a session; a schema migration changes business objects.
Fix: keep domain objects plain and map them to ORM rows in the repository.
