# The OpenAPI document

Committed in the repo (`openapi.yaml` or `api/openapi.yaml`), reviewed like code, and checked in CI for drift and for breaking changes. OpenAPI 3.1 for new APIs.

## Per language

| Stack | Source of truth | Drift check |
|---|---|---|
| FastAPI (code-first) | The routes and Pydantic models. A make target dumps `app.openapi()` to the committed file. | CI exports again and fails if `git diff --exit-code openapi.yaml` is not empty. |
| Go (spec-first) | The committed spec. `oapi-codegen` generates the server interface and types from it (`//go:generate go tool oapi-codegen -config cfg.yaml ../../api.yaml`). | CI regenerates and fails on a diff in the generated code; handlers cannot drift because they implement the generated interface. |
| TypeScript | The zod schemas or the spec, whichever the repo already has; do not run both. | The same two checks, on whichever side is generated. |
| gRPC / protobuf | The `.proto` files. | `buf lint` and `buf breaking --against '.git#branch=main'`. |

## Breaking-change check

```sh
oasdiff breaking --fail-on ERR origin/main:openapi.yaml openapi.yaml
```

`oasdiff` takes a file, a URL or `<git ref>:<path>`. `--fail-on ERR` exits non-zero on definite breaks, `--fail-on WARN` also on possible ones; pick the level once for the repo. `oasdiff changelog` prints the non-breaking changes for the PR.

## Lint

Spectral, with a `.spectral.yaml` that extends the standard OpenAPI ruleset and adds the house rules:

```yaml
extends: ["spectral:oas"]
rules:
  operation-description: warn
  operation-operationId: error
  operation-tags: error
```

Add custom rules for: every operation lists a 4xx or `default` response referencing the shared `Problem` schema; every POST that creates or charges documents `Idempotency-Key`; every collection response has `next_cursor`. Run `spectral lint openapi.yaml` in CI.

## Habits

- Every operation has a stable `operationId` (generated client method names come from it) and at least one example.
- Shared schemas live in `components` and are referenced, not copied. Security schemes are defined and applied.
- Never hand-edit a generated client or server; change the spec and regenerate.
