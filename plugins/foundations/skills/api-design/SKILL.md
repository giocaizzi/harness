---
name: api-design
description: "Use when renaming, removing or changing a field or endpoint that clients read (is it breaking?), adding an endpoint, error format or OpenAPI/proto file; also pagination, retries, idempotency, versioning, long-running operations."
---

# API design

The contract is the product: handlers can change, a published contract cannot. Review the contract diff before the handlers.

Security review (vulnerabilities, RBAC) is the `api-reviewer` agent's, not this skill's.

## Opinions

1. **The OpenAPI document is committed, and CI fails on drift and on a breaking change** (`oasdiff breaking`, `buf breaking`). Code-first in FastAPI (export the schema, then diff it); spec-first in Go (`oapi-codegen`). Tooling per language: [references/OPENAPI.md](./references/OPENAPI.md).
2. **Errors are RFC 9457 `application/problem+json`** with a stable `type`, the same shape on every endpoint, validation errors listed per field, and nothing internal leaked. [references/ERRORS.md](./references/ERRORS.md).
3. **Additive changes take no version.** A breaking change gets a new major path (`/v2`), and the old one sends `Deprecation` and `Sunset` headers for a stated window. No header or media-type versioning. The release version a breaking change takes: `semver`. What counts as breaking: [references/VERSIONING.md](./references/VERSIONING.md).
4. **Collections that grow use cursor pagination**: an opaque cursor, a capped `limit`, a stable sort with an id tiebreaker. Never offset. [references/PAGINATION.md](./references/PAGINATION.md).
5. **Every side-effecting POST accepts `Idempotency-Key`.** Store the key, request hash and response for 24 h; the same key with a different body gets 422. [references/IDEMPOTENCY.md](./references/IDEMPOTENCY.md).
6. **Field casing follows the repo's existing contract**; a new API with none copies its closest sibling. Timestamps are RFC 3339 UTC, money is integer minor units plus a currency code, ids are opaque strings.
7. **Long-running work returns 202** and a status resource the client polls.

## Gotchas

- FastAPI's default 422 body is not problem+json: override the validation handler.
- Adding an enum value breaks strict clients; document enums as open, or version the change.
- OpenAPI 3.1 has no `nullable`: write `type: [x, "null"]`.
- Offset pages skip or repeat rows under concurrent inserts.
- A retried request that timed out may have succeeded: only an idempotency key makes the retry safe (across services and queues: `system-design`).
- A route missing from the exported schema ships an undocumented contract: diff the exported file, not the code.
