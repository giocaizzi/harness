# FastAPI Patterns: Scoping, Schemas, Prohibited Patterns

## Dependency scoping and lifecycle

| Scope | Mechanism | Use for |
|-------|-----------|---------|
| Per-request | `Depends()` default | DB sessions, UoW, repositories |
| Cleanup control | `Depends(scope="function")` | Cleanup before the response is sent |
| Cleanup control | `Depends(scope="request")` | Cleanup after the response is sent (default for yield) |
| Singleton | `@lru_cache` on provider | Settings, config |
| App-scoped | `lifespan` + `app.state` | Connection pools, HTTP clients, engine |

## Key ConfigDict options

```python
class UserResponse(BaseModel):
    model_config = ConfigDict(
        from_attributes=True,   # ORM model -> Pydantic (replaces orm_mode)
        frozen=True,            # Immutable instances
        strict=False,           # Allow type coercion
        extra="forbid",         # Reject unknown fields
        json_schema_extra={"examples": [{"email": "user@example.com"}]},
    )
```

## Validators

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

## Base schemas (DRY)

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

## Prohibited patterns

Default rejection unless the repo has a documented exception.

- Raw `os.environ` (use Settings)
- `= Depends(...)` as default (use `Annotated`)
- Global mutable state or sessions
- Blocking I/O in `async def` endpoints (use `def` or `asyncio.to_thread`)
- Business logic in route handlers
- Endpoint-to-endpoint calls (use a shared service)
- `BaseHTTPMiddleware` for perf-critical paths (use pure ASGI)
- Single worker in production
- Missing type annotations on parameters
- Exposing tracebacks in production
- `on_startup`/`on_shutdown` (use `lifespan`)
