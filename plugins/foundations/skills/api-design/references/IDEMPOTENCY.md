# Idempotency keys

For every POST (or PATCH) with a side effect the client may retry: payments, orders, sends. GET, PUT and DELETE are idempotent by definition and take no key.

## Contract

- Header `Idempotency-Key: <client-generated unique string>` (a UUIDv4 or similar, at most 255 characters). A missing key on an endpoint that requires it is a 400 problem.
- First request: record the key as in progress, run the operation, store the response, return it.
- Same key and same body: return the stored response (same status and body) without running the operation again.
- Same key and a different body (compare a hash of the canonical request: method, path, body): 422 problem, `type` `.../idempotency-key-reuse`.
- Same key while the first request is still running: 409 problem with `Retry-After`.
- Keep key, request hash and response for 24 h, then expire them. Scope a key to the caller (tenant or user) so two callers cannot collide.
- Store 2xx and deterministic 4xx results; do not store a 5xx, so the client's retry runs the operation again.

The key record and the business write commit atomically (one transaction), or the key can say "done" for work that was rolled back. A unique constraint on `(scope, key)` decides the race between two concurrent first requests.

## Key store interface

Declared by the consumer (the HTTP layer), implemented over Postgres or Redis.

Go:

```go
type Record struct {
	RequestHash string
	Status      int
	Body        []byte
	Completed   bool
}

type KeyStore interface {
	// Begin inserts (scope, key) as in progress, or returns the existing record.
	Begin(ctx context.Context, scope, key, requestHash string) (rec Record, existed bool, err error)
	// Complete stores the response and marks the key done.
	Complete(ctx context.Context, scope, key string, status int, body []byte) error
}
```

Python:

```python
@dataclass(frozen=True, slots=True)
class Record:
    request_hash: str
    status: int
    body: bytes
    completed: bool


class KeyStore(Protocol):
    def begin(self, scope: str, key: str, request_hash: str) -> tuple[Record, bool]:
        """Insert (scope, key) as in progress, or return the existing record and True."""

    def complete(self, scope: str, key: str, status: int, body: bytes) -> None:
        """Store the response and mark the key done."""
```

Wrap it once as middleware or a dependency, not in each handler.

## Message consumers

Deduplicating by message id is the idempotent consumer, owned by `system-design`.
