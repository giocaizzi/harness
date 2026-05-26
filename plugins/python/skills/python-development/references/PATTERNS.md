# Patterns Reference

Design patterns, error handling strategies, and idiomatic Python for 3.12+.

## Data Modeling

### Dataclasses (state without behavior)

```python
from dataclasses import dataclass, field

@dataclass(slots=True, frozen=True)
class Coordinate:
    x: float
    y: float

@dataclass(slots=True)
class User:
    name: str
    email: str
    roles: list[str] = field(default_factory=list)

    def has_role(self, role: str) -> bool:
        return role in self.roles
```

**Use `slots=True`** — faster attribute access, less memory.
**Use `frozen=True`** for immutable value objects.

### When to use what

| Pattern | Use when |
|---|---|
| `@dataclass(slots=True)` | Internal data; no validation needed |
| `@dataclass(frozen=True)` | Immutable value objects, dict keys |
| Pydantic `BaseModel` | External input validation, serialization |
| `TypedDict` | Typed dict shapes (JSON responses, configs) |
| `NamedTuple` | Lightweight immutable tuples with names |
| Plain `dict` | Never for structured data in application code |

## Composition Over Inheritance

Inject collaborators; don't subclass for reuse.

```python
from dataclasses import dataclass
from typing import Protocol

class EmailSender(Protocol):
    def send(self, to: str, subject: str, body: str) -> None: ...

@dataclass(slots=True)
class UserService:
    email_sender: EmailSender
    repo: UserRepository

    def register(self, name: str, email: str) -> User:
        user = self.repo.create(name=name, email=email)
        self.email_sender.send(to=email, subject="Welcome", body=f"Hi {name}")
        return user
```

### When inheritance is appropriate

- Framework hooks that require it (e.g., `Exception` subclasses)
- Shallow, stable hierarchies you own (1–2 levels max)
- Mixin traits providing a single capability (use sparingly)

## Error Handling Patterns

### Custom Exception Hierarchy

```python
class AppError(Exception):
    """Base for all application errors."""

class NotFoundError(AppError):
    """Resource not found."""
    def __init__(self, resource: str, id: str) -> None:
        self.resource = resource
        self.id = id
        super().__init__(f"{resource} {id!r} not found")

class ValidationError(AppError):
    """Input validation failed."""
    def __init__(self, field: str, message: str) -> None:
        self.field = field
        super().__init__(f"{field}: {message}")
```

### Exception Chaining

Always chain when wrapping lower-level exceptions:

```python
try:
    data = client.fetch(url)
except httpx.HTTPError as exc:
    raise ServiceUnavailableError(f"Failed to reach {url}") from exc
```

### ExceptionGroup (3.11+)

For parallel/concurrent operations that can produce multiple errors:

```python
async def fetch_all(urls: list[str]) -> list[Response]:
    errors: list[Exception] = []
    results: list[Response] = []
    for url in urls:
        try:
            results.append(await fetch(url))
        except FetchError as e:
            e.add_note(f"URL: {url}")
            errors.append(e)
    if errors:
        raise ExceptionGroup("Multiple fetch failures", errors)
    return results

# Handle selectively
try:
    data = await fetch_all(urls)
except* TimeoutError as eg:
    log.warning(f"{len(eg.exceptions)} timeouts")
except* ConnectionError as eg:
    log.error(f"{len(eg.exceptions)} connection failures")
```

### Context Managers for Cleanup

```python
from contextlib import contextmanager, asynccontextmanager
from collections.abc import Generator, AsyncGenerator

@contextmanager
def managed_connection(dsn: str) -> Generator[Connection, None, None]:
    conn = connect(dsn)
    try:
        yield conn
    finally:
        conn.close()

@asynccontextmanager
async def managed_session() -> AsyncGenerator[Session, None]:
    session = Session()
    try:
        yield session
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()
```

## Dependency Injection

Simple constructor injection — no framework needed for most cases:

```python
from dataclasses import dataclass
from typing import Protocol

class Clock(Protocol):
    def now(self) -> datetime: ...

class RealClock:
    def now(self) -> datetime:
        return datetime.now(UTC)

@dataclass(slots=True)
class TokenService:
    clock: Clock
    ttl: timedelta = timedelta(hours=1)

    def create_token(self, user_id: str) -> Token:
        return Token(user_id=user_id, expires_at=self.clock.now() + self.ttl)

# Production
service = TokenService(clock=RealClock())

# Testing
service = TokenService(clock=FakeClock(fixed_time))
```

## Functional Patterns

### Result Pattern (instead of exceptions for expected failures)

```python
from dataclasses import dataclass

@dataclass(frozen=True, slots=True)
class Ok[T]:
    value: T

@dataclass(frozen=True, slots=True)
class Err[E]:
    error: E

type Result[T, E] = Ok[T] | Err[E]

def parse_int(s: str) -> Result[int, str]:
    try:
        return Ok(int(s))
    except ValueError:
        return Err(f"Cannot parse {s!r} as int")

# Usage
match parse_int(user_input):
    case Ok(value):
        process(value)
    case Err(msg):
        log.warning(msg)
```

### Pattern Matching (3.10+)

```python
from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float

def describe(shape: Shape) -> str:
    match shape:
        case Circle(radius=r) if r > 10:
            return "large circle"
        case Circle(radius=r):
            return f"circle r={r}"
        case Rectangle(width=w, height=h) if w == h:
            return f"square {w}x{h}"
        case Rectangle(width=w, height=h):
            return f"rectangle {w}x{h}"
        case _:
            return "unknown"
```

## Async Patterns

### Structured concurrency with TaskGroup (3.11+)

```python
import asyncio

async def fetch_users_and_orders(user_ids: list[str]) -> tuple[list[User], list[Order]]:
    async with asyncio.TaskGroup() as tg:
        user_task = tg.create_task(fetch_users(user_ids))
        order_task = tg.create_task(fetch_orders(user_ids))
    return user_task.result(), order_task.result()
```

### Async iterators

```python
from collections.abc import AsyncIterator

async def paginate[T](fetcher: PageFetcher[T]) -> AsyncIterator[T]:
    page = 0
    while True:
        items = await fetcher.get_page(page)
        if not items:
            return
        for item in items:
            yield item
        page += 1
```

## Module Organization

- One concept per module; module name = noun (plural for collections)
- `__init__.py` re-exports the public API; internals stay private (`_prefixed`)
- Avoid circular imports by depending on protocols/interfaces, not implementations

```python
# src/my_package/__init__.py
from my_package.core.models import User, Order
from my_package.services.user import UserService

__all__ = ["User", "Order", "UserService"]
```
