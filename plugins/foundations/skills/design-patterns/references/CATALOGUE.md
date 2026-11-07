# Catalogue

Eight patterns. Each: the problem it solves, when it is the wrong tool, and which skill owns the detail. Repository, unit of work, outbox and idempotent consumer are described once, in their owner skill; this file only places them.

## Ports and adapters

The domain declares what it needs (a port); infrastructure implements it (an adapter). Dependencies point inward. Use when swapping or faking I/O matters, or the domain has rules worth testing without a database. Not for a script or a thin CRUD service where the "domain" is the table. Owner: `domain-driven-design`.

## Repository and unit of work

A repository is a collection-like store for one aggregate root; the unit of work is the transaction boundary that saves the changes together. Use when an aggregate has invariants. Not for read models, reports or a table with no rules: query it directly. Owner: `domain-driven-design`.

## Domain events with outbox

An aggregate records a fact; other parts react. The outbox stores the event in the same transaction as the state change and publishes it afterwards, so no dual write. Use when another context must learn of a change. Not when one process owns both effects in one transaction. Owners: `domain-driven-design` (events), `system-design` (outbox).

## Anti-corruption layer

A translator between an upstream model and yours, so its names, quirks and changes stop at the boundary. Use for a legacy system or a third party whose model differs from yours. Not for a clean API you are happy to adopt. Owner: `domain-driven-design`.

## Strategy

Interchangeable behaviours behind one small interface, chosen at runtime (pricing rules, export formats). Use when there are three or more and more are expected. Not for two branches: an `if` is clearer. In Go and TypeScript the interface is declared by the consumer; in Python a `Protocol` or a callable.

## Decorator for cross-cutting concerns

Wrap an implementation with another of the same interface to add retry, timeout, caching, logging or metrics, so the wrapped code stays about one thing. Use when the same concern wraps several clients (the retry-and-log code copied around four HTTP clients). Not to add business rules. Order matters: outermost sees every attempt (logging), then retry, then timeout around the single call.

## Composition root

One place (`main`) builds every collaborator and passes it down through constructors. Use always. Not a DI container or a service locator that code calls into; a function that builds its own dependencies is hard to test and hides coupling.

## Idempotent consumer

A handler that can receive the same message twice and applies it once (dedupe by message id, or make the effect naturally repeatable). Use for every at-least-once queue. Not needed when the effect is already idempotent (set a value, upsert by key). Owner: `system-design`. The HTTP counterpart is the idempotency key, owned by `api-design`.
