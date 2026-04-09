# Performance Patterns

## Bulk Operations

`bulk_save_objects()` is effectively deprecated. Use Core-level bulk inserts:

```python
from sqlalchemy import insert

# Bulk insert (much faster than individual session.add() calls)
session.execute(
    insert(User),
    [
        {"name": "Alice", "email": "alice@example.com"},
        {"name": "Bob", "email": "bob@example.com"},
    ],
)
await session.commit()

# Bulk update
from sqlalchemy import update

session.execute(
    update(User).where(User.active == False).values(archived=True)
)

# Bulk delete
from sqlalchemy import delete

session.execute(
    delete(User).where(User.last_login < cutoff_date)
)
```

## Streaming Large Result Sets

### `yield_per` (server-side batching)

```python
# Sync
stmt = select(User)
for user in session.execute(stmt).scalars().yield_per(1000):
    process(user)

# Async — use stream() + yield_per()
async with session.stream(stmt) as result:
    async for user in result.scalars().yield_per(1000):
        await process(user)
```

### `stream_results` (server-side cursors)

For PostgreSQL with psycopg2/asyncpg, `stream()` uses server-side cursors automatically. For other drivers, enable explicitly:

```python
result = session.execute(stmt, execution_options={"stream_results": True})
```

## Compiled Query Cache

SQLAlchemy v2 automatically caches compiled SQL statements. The cache is per-engine and speeds up repeated queries. No configuration needed — it's on by default.

Monitor cache with `engine.echo = True` and look for `[cached since Xs ago]` in logs.

## Index Optimization

```python
from sqlalchemy import Index

class User(Base):
    __tablename__ = "users"

    id: Mapped[intpk]
    email: Mapped[str] = mapped_column(unique=True, index=True)
    name: Mapped[str]
    created_at: Mapped[timestamp]

    # Composite index
    __table_args__ = (
        Index("ix_user_name_email", "name", "email"),
    )
```

## Query Optimization Tips

- **Use `scalar_one()` / `scalar_one_or_none()`** — avoid fetching rows you don't need.
- **Eager-load relationships** needed for serialization in the same query.
- **Use `.unique()`** after `joinedload` on collections to deduplicate.
- **Avoid N+1**: set `lazy="raise"` globally, eager-load explicitly.
- **Use Core for read-heavy queries** when ORM overhead matters: `select(User.id, User.name)` returns plain tuples.
