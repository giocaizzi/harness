---
name: fastapi
description: >-
  FastAPI best practices with Pydantic v2 for production REST APIs.
  Use when building APIs with FastAPI, handling routes, schemas, dependencies,
  middleware, or configuration. Activate when code imports fastapi or uses
  APIRouter, Depends, BaseModel, or BaseSettings. Follow these guidelines always.
metadata:
  version: "4.0"
compatibility: "Python >=3.10, Pydantic >=2.9.0, Starlette >=1.0.0"
---

# FastAPI Best Practices

Modern FastAPI with **Pydantic v2**. Leverage automatic validation, serialization, and OpenAPI docs — don't fight them.

## Application Factory & Lifespan

Use the application factory pattern. Use `lifespan` for startup/shutdown — `on_startup`/`on_shutdown` are deprecated.

```python
from contextlib import asynccontextmanager
from typing import TypedDict
from fastapi import FastAPI

class State(TypedDict):
    engine: AsyncEngine
    http_client: httpx.AsyncClient

@asynccontextmanager
async def lifespan(app: FastAPI):
    engine = create_async_engine(settings.database_url)
    async with httpx.AsyncClient() as client:
        yield State(engine=engine, http_client=client)
    await engine.dispose()

def create_app() -> FastAPI:
    return FastAPI(title="My API", version="1.0.0", lifespan=lifespan)
```

## Settings

```python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False)
    database_url: str
    debug: bool = False
```

Singleton via `@lru_cache`: `def get_settings() -> Settings: return Settings()`

## Dependency Injection with Depends()

FastAPI's `Depends()` is **parameter injection** — it inspects signatures, resolves the dependency tree per-request, and provides results as arguments.

### Core Rules

- **Always use `Annotated[Type, Depends(...)]`** — never `= Depends(...)` as default.
- **Return abstractions**, not concretions — hide concrete types inside dependency functions.
- **Define dependencies in a dedicated module** (`dependencies/` or `dependencies.py`) — this is the composition root.

### Scoping & Lifecycle

| Scope | Mechanism | Use For |
|-------|-----------|---------|
| Per-request | `Depends()` default | DB sessions, UoW, repositories |
| Cleanup control | `Depends(scope="function")` | Cleanup **before** response sent |
| Cleanup control | `Depends(scope="request")` | Cleanup **after** response sent (default for yield) |
| Singleton | `@lru_cache` on provider | Settings, config |
| App-scoped | `lifespan` + `app.state` | Connection pools, HTTP clients, engine |

### Dependency Chains (layered / DDD architecture)

```python
# dependencies/uow.py — composition root
async def get_uow(session: SessionDep) -> AsyncGenerator[AbstractUnitOfWork, None]:
    yield SqlAlchemyUnitOfWork(session)

UnitOfWorkDep = Annotated[AbstractUnitOfWork, Depends(get_uow)]
```

### Testing Overrides

```python
app.dependency_overrides[get_uow] = lambda: FakeUnitOfWork()
app.dependency_overrides.clear()  # reset after test
```

## async def vs def

**Critical performance rule.** Getting this wrong is the #1 FastAPI performance killer.

- **`async def`**: For I/O-bound operations (database, HTTP calls, file I/O with async libs). Runs on the event loop.
- **`def`** (sync): For CPU-bound or blocking operations. FastAPI runs these in a threadpool automatically.
- **Never block the event loop**: Blocking I/O inside `async def` starves all concurrent requests. Use `def` or `asyncio.to_thread()`.

## Routes & Endpoints

- **Type everything** with Pydantic models: request bodies, responses, query/path params.
- **Organize with `APIRouter`** by feature/domain.
- **Routes are thin** — validate, dispatch to service/handler, return response. No business logic.
- **Response model**: prefer return type annotation for simple cases. Use `response_model` parameter when return type differs or for security filtering (exclude fields).

```python
@router.get("/items", response_model=list[ItemResponse])
async def list_items(params: Annotated[ItemQueryParams, Query()], session: SessionDep):
    return await item_service.list_items(session, params)
```

## Pydantic v2 Schemas

### Naming

| Type | Pattern | Example |
|------|---------|---------|
| Request | `{Action}{Entity}Request` | `CreateUserRequest` |
| Response | `{Entity}Response` | `UserResponse` |
| List Response | `{Entity}ListResponse` | `UserListResponse` |
| Query Params | `{Entity}QueryParams` | `ProductQueryParams` |

### Key ConfigDict Options

```python
class UserResponse(BaseModel):
    model_config = ConfigDict(
        from_attributes=True,   # ORM model → Pydantic (replaces orm_mode)
        frozen=True,            # Immutable instances
        strict=False,           # Allow type coercion
        extra="forbid",         # Reject unknown fields
        json_schema_extra={"examples": [{"email": "user@example.com"}]},
    )
```

### Validators

```python
from pydantic import field_validator, model_validator

class CreateOrderRequest(BaseModel):
    items: list[OrderItemRequest]
    discount_code: str | None = None

    @field_validator("items")
    @classmethod
    def must_have_items(cls, v: list) -> list:
        if not v:
            raise ValueError("Order must have at least one item")
        return v

    @model_validator(mode="after")
    def validate_discount(self) -> "CreateOrderRequest":
        if self.discount_code and len(self.items) < 3:
            raise ValueError("Discount requires 3+ items")
        return self
```

### Base Schemas (DRY)

```python
class UserBase(BaseModel):
    email: EmailStr
    username: str

class CreateUserRequest(UserBase):
    password: str

class UserResponse(UserBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
```

## Error Handling

- **Custom exception handlers** convert domain/application exceptions to HTTP responses.
- **Consistent format**: `{"error": str, "code": str, "details": dict | None}`.
- **Never expose tracebacks in production.**

```python
@app.exception_handler(DomainError)
async def domain_error_handler(request: Request, exc: DomainError):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.message, "code": exc.code})
```

## Performance

- **`ORJSONResponse`** for 20-50% faster JSON serialization: `pip install orjson`, set as `default_response_class`.
- **Pure ASGI middleware** instead of `BaseHTTPMiddleware` for performance-critical paths (~40% faster).
- **Stream large responses** with `StreamingResponse` — don't buffer in memory.
- **`uvloop` + `httptools`**: 2-4x throughput. `pip install uvloop httptools`, uvicorn auto-detects.
- **Multiple workers** in production: `uvicorn --workers $(nproc)` or Gunicorn with UvicornWorker.

## Architecture

### Simple CRUD APIs

```
project/
├── main.py              # App factory + lifespan
├── config.py            # Pydantic BaseSettings
├── dependencies.py      # Dependency providers (composition root)
├── routes/              # APIRouter modules by feature
├── services/            # Business logic
├── models/              # SQLAlchemy/DB models
└── schemas/             # Pydantic request/response DTOs
```

### With DDD / Hexagonal Architecture

FastAPI is the **driving adapter** (primary adapter) — translates HTTP into application commands/queries:

```
contexts/{name}/
├── api/                 # DRIVING ADAPTER (FastAPI)
│   ├── routes/          # Thin: validate → dispatch → respond
│   ├── dependencies/    # COMPOSITION ROOT: wires concrete → abstract
│   ├── schemas/         # Pydantic DTOs (NOT domain models)
│   └── middleware/      # Error translation, auth, logging
├── domain/              # No FastAPI imports
├── application/         # No FastAPI imports
└── infrastructure/      # Concrete implementations
```

## Testing

```python
import pytest
from httpx import ASGITransport, AsyncClient

@pytest.fixture
async def client(app: FastAPI):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c

@pytest.mark.anyio
async def test_create_user(client: AsyncClient):
    response = await client.post("/users", json={"email": "a@b.com", "username": "test", "password": "secret"})
    assert response.status_code == 201
```

Override dependencies for isolation: `app.dependency_overrides[get_uow] = lambda: FakeUnitOfWork()`

## Prohibited Patterns

- Raw `os.environ` (use Settings)
- `= Depends(...)` as default (use `Annotated`)
- Global mutable state or sessions
- Blocking I/O in `async def` endpoints (use `def` or `asyncio.to_thread`)
- Business logic in route handlers
- Endpoint-to-endpoint calls (use shared service)
- `BaseHTTPMiddleware` for perf-critical paths (use pure ASGI)
- Single worker in production
- Missing type annotations on parameters
- Exposing tracebacks in production
- `on_startup`/`on_shutdown` (use `lifespan`)

## Additional References

- [references/SSE.md](references/SSE.md) — Server-Sent Events with `EventSourceResponse`
- [references/SECURITY.md](references/SECURITY.md) — OAuth2, JWT, API keys, scopes
- [references/ASYNC_PATTERNS.md](references/ASYNC_PATTERNS.md) — Background tasks, streaming, WebSocket, file uploads
