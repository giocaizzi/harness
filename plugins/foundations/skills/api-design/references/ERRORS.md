# Errors

One shape on every endpoint, RFC 9457 `application/problem+json`. Members: `type` (a stable URI the client can switch on), `title` (short, the same for every occurrence of a `type`), `status` (the HTTP status), `detail` (this occurrence, for a human), `instance` (URI of this occurrence, optional). Extension members go beside them.

```json
{
  "type": "https://api.acme.example/problems/validation-error",
  "title": "Request validation failed",
  "status": 422,
  "detail": "2 fields are invalid.",
  "errors": [
    {"pointer": "/amount", "detail": "must be greater than 0"},
    {"pointer": "/currency", "detail": "must be a 3-letter ISO 4217 code"}
  ]
}
```

## Rules

- Send `Content-Type: application/problem+json`. Clients should send `Accept: application/json, application/problem+json`.
- `type` is a contract: never rename it, and add a new one rather than repurpose one. Clients branch on `type`, not on `title` or `detail`.
- Validation errors list every failing field in `errors[]` with a JSON pointer to it, not one error per round trip.
- `detail` never carries a stack trace, SQL, a hostname, a file path or an internal id. Log the cause with a correlation id and return that id in an extension member (`trace_id`).
- Status codes: 400 malformed, 401 unauthenticated, 403 authenticated but not allowed, 404 absent (or hidden, when existence is itself private), 409 state conflict, 422 well-formed but invalid, 429 with `Retry-After`; a 5xx never carries a client-fixable message.
- List the error `type`s an endpoint returns in OpenAPI, referencing the shared `Problem` schema, not redefining it per endpoint.

## FastAPI

Override both handlers so framework errors come out as problem+json too: `RequestValidationError` (map `exc.errors()` to `errors[]`) and Starlette's `HTTPException`. Register one handler for the domain exception base class that maps to `type` and `status`. Test the three paths: validation, domain error, unhandled (500 with no internals).

## Go

One `Problem` struct, one `writeProblem(w, p)` helper, used by the error-mapping middleware, the 404/405 handlers and the panic recovery, so no path writes a plain-text body.
