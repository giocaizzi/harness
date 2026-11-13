---
name: system-design
description: "Use when designing a feature that crosses a process or service boundary or calls a slow dependency, adding a queue, event, cache or datastore, sending something when an event happens, changing a schema that has production data, deciding between options, or writing or reviewing a design or ADR. Trade-offs, consistency, timeouts and retries, the outbox, expand/contract migrations."
---

# System design

Decide with numbers and name the failure before drawing boxes. The opinions below are defaults; deviate only with a recorded reason (an ADR).

## Opinions

1. NFRs come before boxes: p99 latency, throughput, availability, RPO/RTO and a cost ceiling, as numbers. A design with no numbers cannot be reviewed. Template: [NFR.md](references/NFR.md).
2. Synchronous inside a context; asynchronous only across contexts or when the caller does not need the result. Every async path names its retry, dead-letter queue (DLQ) and ordering. See [MESSAGING.md](references/MESSAGING.md).
3. Delivery is at-least-once, so every consumer is idempotent: a dedupe key stored with the effect in the same transaction.
4. "Write the DB and publish an event" is always a transactional outbox, never two writes.
5. Strong consistency inside an aggregate, eventual across aggregates, with the staleness bound stated.
6. Every outbound call has a timeout shorter than its caller's, retries with backoff and jitter within a budget, and a stated fallback. Table per dependency: [FAILURE_MODES.md](references/FAILURE_MODES.md).
7. Schema changes on live data are expand/contract, one deploy per step (expand, backfill, dual-read, switch, contract). Never rename in place. See [MIGRATIONS.md](references/MIGRATIONS.md).
8. A new datastore, queue or cloud service needs an ADR: one decision per file in `docs/adr/NNNN-slug.md`, or the repo's own ADR folder when it has one; superseded, never edited. See [ADR.md](references/ADR.md).
9. Prefer boring managed services, and treat cost as an NFR. See [CLOUD_DESIGN.md](references/CLOUD_DESIGN.md).

## Gotchas

- A retry without idempotency double-charges.
- The outbox relay must keep order per aggregate.
- A backfill in the same migration as the `NOT NULL` locks the table.
- Go's zero `http.Client` and Python `requests` have no timeout.
- "Eventually consistent" without a bound is not a design.

## Owned elsewhere

- Repository, unit of work, aggregates: `domain-driven-design`.
- HTTP contract detail (error shape, pagination, `Idempotency-Key` header): `api-design`.

## References

Load only what the task needs.

- [NFR.md](references/NFR.md): NFR table template.
- [FAILURE_MODES.md](references/FAILURE_MODES.md): per-dependency failure table.
- [MESSAGING.md](references/MESSAGING.md): outbox, idempotent consumer, ordering, DLQ.
- [MIGRATIONS.md](references/MIGRATIONS.md): expand/contract per change type.
- [ADR.md](references/ADR.md): template, when to write one.
- [CLOUD_DESIGN.md](references/CLOUD_DESIGN.md): managed vs self-hosted, regions, IAM, network edges, cost.
- [design-review.md](references/design-review.md): reviewer rubric for a design, architecture or API-contract change.
- [infra-review.md](references/infra-review.md): reviewer rubric for IaC, containers, CI and cloud.
