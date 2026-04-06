---
name: sqlachemy
description: >-
  SQLAlchemy v2 best practices and conventions.
  Use when working with SQLAlchemy ORM or Core, database models, queries, sessions,
  or migrations. Activate when code imports sqlalchemy, uses Mapped, mapped_column,
  select, or session operations. Follow these guidelines always.
metadata:
  version: "4.0"
compatibility: "SQLAlchemy >=2.0, Python >=3.10"
---

# SQLAlchemy v2 Best Practices

## Core Principles

- **Always use v2 API** — `select()`, `Mapped[T]`, `mapped_column()`. Never legacy `Query` or `Column`.
- Use async sessions only when your application is async (FastAPI, async web servers).
- Sync sessions for scripts, CLI tools, and simpler use cases.

## Annotated Declarative Types (DRY)

Define reusable column types once:

```python
from typing import Annotated
from datetime import datetime
from sqlalchemy import String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

intpk = Annotated[int, mapped_column(primary_key=True)]
timestamp = Annotated[datetime, mapped_column(server_default=func.now())]
str50 = Annotated[str, mapped_column(String(50))]
```

## Model Definition

```python
from sqlalchemy.orm import relationship
from sqlalchemy import ForeignKey

class Base(DeclarativeBase):
    pass

class User(Base):
    __tablename__ = "users"

    id: Mapped[intpk]
    name: Mapped[str50]
    email: Mapped[str | None]
    created_at: Mapped[timestamp]

    posts: Mapped[list["Post"]] = relationship(back_populates="user", lazy="raise")

class Post(Base):
    __tablename__ = "posts"

    id: Mapped[intpk]
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str]

    user: Mapped["User"] = relationship(back_populates="posts", lazy="raise")
```

### MappedAsDataclass

Use when you want dataclass semantics (`__init__`, `__eq__`, `__repr__` auto-generated):

```python
from sqlalchemy.orm import MappedAsDataclass

class Product(MappedAsDataclass, Base):
    __tablename__ = "products"

    id: Mapped[intpk] = mapped_column(init=False)          # excluded from __init__
    name: Mapped[str]
    price: Mapped[float]
    created_at: Mapped[datetime] = mapped_column(insert_default=func.now(), init=False)
    tags: Mapped[list["Tag"]] = relationship(default_factory=list)  # collections need default_factory
```

Key differences: `default` controls `__init__()`, `insert_default` controls SQL defaults. `frozen`/`slots` not supported.

## Session Management

### Transaction Pattern (recommended)

Use `session.begin()` — auto-commits on success, auto-rollbacks on exception:

```python
# Sync
with Session(engine) as session, session.begin():
    session.add(User(name="Alice"))
    # commits automatically at end of block

# Async
async with AsyncSession(engine) as session, session.begin():
    session.add(User(name="Alice"))
```

### Session Factories

```python
# Sync
engine = create_engine("postgresql://user:pass@localhost/db")
SessionLocal = sessionmaker(engine)

# Async
engine = create_async_engine("postgresql+asyncpg://user:pass@localhost/db")
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)
```

### `expire_on_commit=False` (async)

**Critical for async.** After `commit()`, SQLAlchemy expires all attributes. In sync, accessing an expired attribute triggers a lazy load. In async, this raises `MissingGreenlet` because lazy loads are sync I/O. Set `expire_on_commit=False` on async session factories.

### Connection Pooling (production)

```python
engine = create_async_engine(
    database_url,
    pool_size=20,       # base connections
    max_overflow=10,    # temporary extra connections
    pool_pre_ping=True, # detect stale connections
    pool_recycle=3600,  # recycle connections after 1 hour
)
```

## Query Patterns

```python
from sqlalchemy import select

# Simple select
stmt = select(User).where(User.name == "Alice")
user = session.execute(stmt).scalar_one_or_none()

# Multiple results
users = session.execute(select(User)).scalars().all()

# Joins
stmt = select(User).join(User.posts).where(Post.title.like("%SQL%"))
users = session.execute(stmt).scalars().unique().all()

# Async: add await
user = (await session.execute(stmt)).scalar_one_or_none()
```

## Relationships and Loading

### Eager Loading Strategies

| Strategy | Use For | How |
|----------|---------|-----|
| `selectinload` | **Collections** (one-to-many) | Separate IN query. Preferred for collections. |
| `joinedload` | **Scalars** (many-to-one) | Single JOIN query. Preferred for single relationships. |
| `subqueryload` | Collections with complex filters | Separate subquery. |
| `lazy="raise"` | **Default on all relationships** | Prevents N+1 by raising on implicit access. |

```python
from sqlalchemy.orm import selectinload, joinedload

# Collection: use selectinload
stmt = select(User).options(selectinload(User.posts))

# Scalar: use joinedload
stmt = select(Post).options(joinedload(Post.user))
```

**Always set `lazy="raise"` on relationships** and explicitly eager-load at query time. This prevents N+1 queries and is mandatory for async (implicit lazy loads raise `MissingGreenlet`).

### AsyncAttrs Mixin (async alternative)

```python
from sqlalchemy.ext.asyncio import AsyncAttrs

class Base(AsyncAttrs, DeclarativeBase):
    pass

# Then access relationships explicitly:
posts = await user.awaitable_attrs.posts
```

## Pydantic v2 Integration

```python
class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    email: str | None

# Convert ORM → Pydantic (relationships must be eagerly loaded first)
user_model = session.execute(select(User).options(selectinload(User.posts))).scalar_one()
response = UserResponse.model_validate(user_model)
```

## DDD Infrastructure Patterns

When using DDD, SQLAlchemy is an **infrastructure concern** — a driven adapter implementing domain Protocols. ORM models are separate from domain entities.

```python
# Mapper: domain ↔ ORM
class OrderMapper:
    @staticmethod
    def to_domain(model: OrderModel) -> Order:
        return Order.reconstitute(id=OrderId(model.id), status=OrderStatus(model.status))

    @staticmethod
    def to_persistence(entity: Order) -> OrderModel:
        return OrderModel(id=entity.id.value, status=entity.status.value)

# Repository: implements domain Protocol, returns domain models
class SqlAlchemyOrderRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, order_id: OrderId) -> Order:
        model = (await self._session.execute(
            select(OrderModel).where(OrderModel.id == order_id.value)
        )).scalar_one_or_none()
        if not model:
            raise OrderNotFound(order_id)
        return OrderMapper.to_domain(model)

    async def add(self, order: Order) -> None:
        self._session.add(OrderMapper.to_persistence(order))

# UoW: wraps session transaction
class SqlAlchemyUnitOfWork:
    def __init__(self, session_factory: async_sessionmaker) -> None:
        self._session_factory = session_factory

    async def __aenter__(self):
        self._session = self._session_factory()
        self.orders = SqlAlchemyOrderRepository(self._session)
        return self

    async def __aexit__(self, exc_type, *args):
        if exc_type:
            await self._session.rollback()
        await self._session.close()

    async def commit(self):
        await self._session.commit()
```

## Async Gotchas

- **`MissingGreenlet`**: Implicit lazy loading in async. Fix: `lazy="raise"` + explicit eager loading, or `AsyncAttrs`.
- **`expire_on_commit`**: Must be `False` for async sessions. Otherwise accessing attributes after commit fails.
- **Thread safety**: Sessions are NOT thread-safe. One session per request/task.
- **Detached instances**: Accessing attributes on objects after session close raises `DetachedInstanceError`. Eager-load everything needed before closing.

## Anti-Patterns

- `session.query(User)` → use `select(User)` (v2 style)
- `Column(String(50))` → use `Mapped[str] = mapped_column(String(50))`
- `joinedload` for collections → use `selectinload`
- `bulk_save_objects()` → use `session.execute(insert(Model), [...])`
- No `lazy="raise"` on relationships → implicit N+1 queries
- Business logic in repositories → repositories are persistence only
- Exposing ORM models from repositories → return domain models in DDD

## Additional References

- [references/PERFORMANCE.md](references/PERFORMANCE.md) — Bulk operations, streaming, query optimization
- [references/LARGE_COLLECTIONS.md](references/LARGE_COLLECTIONS.md) — WriteOnlyMapped, AssociationProxy, type_annotation_map
- [references/MIGRATIONS.md](references/MIGRATIONS.md) — Alembic patterns and best practices
