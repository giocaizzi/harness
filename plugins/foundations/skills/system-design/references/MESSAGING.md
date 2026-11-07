# Messaging patterns

Owns: transactional outbox, idempotent consumer, ordering, DLQ. Aggregates and repositories belong to `domain-driven-design`.

## Transactional outbox

Write the state change and an `outbox` row in one transaction; a relay publishes rows and marks them sent.

| Column | Note |
|---|---|
| `id` | unique event id, also the consumer's dedupe key |
| `aggregate_id` | partition and ordering key |
| `type`, `payload` | versioned schema |
| `created_at`, `sent_at` | relay sets `sent_at` after broker ack |

Relay rules:
- Publishes at-least-once; may duplicate after a crash between publish and mark.
- Publishes in sequence order per `aggregate_id`; one worker per partition, or `FOR UPDATE SKIP LOCKED` with per-aggregate order preserved.
- Prune sent rows by age.
- Alert on the age of the oldest unsent row.

```go
type OutboxRelay interface {
    // PublishPending sends unsent rows in per-aggregate order and marks them sent.
    PublishPending(ctx context.Context, batch int) (published int, err error)
}
```

## Idempotent consumer

Store the dedupe key with the effect, in the same transaction.

```python
class Consumer(Protocol):
    def handle(self, event_id: str, payload: dict) -> None:
        """One transaction: insert event_id into processed_events (unique);
        on conflict return with no effect; else apply the effect."""
```

- Unique constraint on `event_id` per consumer; keep rows longer than the broker's redelivery window.
- Natural idempotency (upsert, set-to-value) beats a dedupe table when available.
- A side effect outside the DB (email, payment) needs its own idempotency key passed downstream.

## Ordering

| Need | Do |
|---|---|
| Order per entity | ordering key = aggregate id |
| Global order | avoid; if unavoidable, one partition and state the throughput cap |
| Out-of-order tolerance | version number in the event; ignore anything older than stored |

## Retry and DLQ

| Decision | State |
|---|---|
| Retries | count, backoff with jitter |
| Poison message | after N attempts to the DLQ with error and original headers |
| DLQ owner | who is alerted, retention |
| Replay | consumer is idempotent; replay is a runbook |

Every async path in a design lists: retry, DLQ, ordering key, expected lag.
