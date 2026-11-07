# Failure modes per dependency

One row per outbound dependency (database, cache, queue, third-party API, internal service). Complete before approving.

| Dependency | Failure (down / slow / wrong) | Timeout | Retry (policy, budget) | Idempotent? | Fallback / degraded mode | Alert |
|---|---|---|---|---|---|---|
| payments API | slow | 2 s (caller: 5 s) | 2x, exp backoff + jitter, only on 5xx/timeout | key sent | queue and show "pending" | error rate > 2% |
| | | | | | | |

## Rules

- Timeout of a call < timeout of its caller, so the caller can still answer.
- Retry only idempotent operations or ones carrying an idempotency key; cap attempts and total time (retry budget); add jitter.
- Never retry a 4xx other than 408/429; honour `Retry-After`.
- Circuit breaker or load shedding for any dependency whose slowness can exhaust threads or connections.
- A fallback is a decision: stale data, a default, queue for later, or fail fast. "Retry forever" is not one.
- Bulkhead: separate pools for dependencies that must not starve each other.
- Test the fallback; an untested one is absent.

## Timeout defaults (library traps)

| Stack | Default | Do |
|---|---|---|
| Go `http.Client{}` | none | set `Timeout` and a context deadline |
| Python `requests` | none | pass `timeout=(connect, read)` |
| Python `httpx` | 5 s | set explicitly per client |
| SQL driver | none | set connect and statement timeouts |
