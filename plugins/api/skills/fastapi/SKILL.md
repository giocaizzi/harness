---
name: fastapi
description: FastAPI with Pydantic v2 for production REST APIs. Use when writing routes, schemas, dependencies, middleware, settings, or tests for a FastAPI app.
compatibility: "Python >=3.10, Pydantic >=2.9.0, Starlette >=1.0.0"
---

# FastAPI (Pydantic v2)

Lean on automatic validation, serialization and OpenAPI rather than fighting them. When rules conflict, prefer in this order: app factory with `lifespan`; thin routes; Pydantic-typed inputs/outputs; `Annotated` dependencies; `async def` only for non-blocking I/O.

## Application and settings

- Use an app factory (`create_app()`) with `lifespan` for engines, HTTP clients and pools, yielding a typed state; `on_startup`/`on_shutdown` are deprecated.
- Configuration lives in a typed `BaseSettings` class, never raw `os.environ`; cache the provider with `@lru_cache`.
- No global mutable state or global sessions; app-scoped resources go through `lifespan`.

## Dependencies

- Declare with `Annotated[Type, Depends(...)]` (aliases like `SessionDep`, `UnitOfWorkDep`), not `= Depends(...)` defaults, so signatures stay reusable and type-checkable.
- Providers return an interface/protocol, keeping concrete construction inside the provider; they live in one module (`dependencies/`), which is the composition root.
- `Depends(scope="function")` cleans up before the response is sent; the default `scope="request"` cleans up after. Pick `function` when the resource (e.g. a session) must be released before streaming/slow responses.
- Tests swap providers with `app.dependency_overrides[...]` and clear it afterwards.

## Async vs sync

Blocking I/O inside `async def` starves every concurrent request and is the most common FastAPI performance bug. Use `async def` for async I/O; use plain `def` (FastAPI runs it in a threadpool) or `asyncio.to_thread()` for blocking or CPU-bound work.

## Routes

- Routes are transport adapters: validate, dispatch to a service/handler, shape the response. No business logic, and no endpoint calling another endpoint (share a service).
- Organize `APIRouter`s by feature. Annotate every parameter.
- Prefer return-type annotations for responses; use `response_model` when the return type differs or to filter fields for security.

## Schemas

- Names: `{Action}{Entity}Request`, `{Entity}Response`, `{Entity}ListResponse`, `{Entity}QueryParams`.
- `ConfigDict(extra="forbid")` on requests to reject unknown fields; `from_attributes=True` on responses built from ORM objects. Share fields via a base schema, and keep API schemas separate from domain models.
- Validators only for real invariants.

## Errors

Map domain/application exceptions to HTTP with exception handlers, using one format `{"error": str, "code": str, "details": dict | None}`. Never expose tracebacks in production.

## Performance and deployment

- `ORJSONResponse` as `default_response_class`; `uvloop` + `httptools` for throughput.
- Pure ASGI middleware instead of `BaseHTTPMiddleware` on hot paths (it is markedly slower).
- `StreamingResponse` for large payloads.
- Run multiple workers in production (uvicorn `--workers` or Gunicorn with UvicornWorker), never a single one.

## Structure

Simple CRUD: `main.py`, `config.py`, `dependencies.py`, `routes/`, `services/`, `models/`, `schemas/`. With DDD/hexagonal, FastAPI is the driving adapter only: `contexts/{name}/api/{routes,dependencies,schemas,middleware}`, while `domain/` and `application/` never import FastAPI.

## Testing

Test through `httpx.AsyncClient(transport=ASGITransport(app=app))` and override dependencies with fakes to keep tests fast and isolated.

## References

- [references/SECURITY.md](references/SECURITY.md): read when implementing OAuth2, JWT, API keys or scopes.
- [references/ASYNC_PATTERNS.md](references/ASYNC_PATTERNS.md): read for background tasks, streaming, WebSocket, or file uploads.
- [references/SSE.md](references/SSE.md): read for Server-Sent Events with `EventSourceResponse`.
- [references/PATTERNS.md](references/PATTERNS.md): read for the dependency scoping table, ConfigDict options, validator and base-schema examples, and the prohibited-patterns list.
