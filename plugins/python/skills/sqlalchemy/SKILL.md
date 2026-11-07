---
name: sqlalchemy
description: SQLAlchemy 2.x ORM/Core conventions, sync and async. Use when defining models, writing queries, managing sessions/transactions, loading relationships, or tuning performance and migrations.
compatibility: "SQLAlchemy >=2.0, Python >=3.10"
---

# SQLAlchemy v2

## Defaults

- v2 API only: `select()`, `Mapped[T]`, `mapped_column()`. Legacy `Query`/`Column` mixes styles and loses typing.
- Async sessions only when both request handling and DB access are async-first (FastAPI, Starlette, aiohttp). Otherwise sync; scripts and CLIs are always sync.
- Explicit transactions via `with Session(engine) as session, session.begin():` (async: `async with`). It commits on success and rolls back on exception. Catch `IntegrityError`/`OperationalError` outside the block so rollback stays automatic, then translate to domain/API errors.
- Define reusable column types once with `Annotated` (`intpk`, `timestamp`, `str50`).
- `MappedAsDataclass` is optional: `default` affects `__init__`, `insert_default` affects SQL; collections need `default_factory`; `frozen`/`slots` unsupported.

## Async gotchas

- Set `expire_on_commit=False` on `async_sessionmaker`. After commit attributes expire, and reloading them is a lazy load, which raises `MissingGreenlet` in async.
- Sessions are not thread-safe or task-safe: one per request/task.
- Attributes accessed after session close raise `DetachedInstanceError`; eager-load what you need before closing.
- `AsyncAttrs` + `await obj.awaitable_attrs.rel` exists, but explicit eager loading is preferred.

## Relationships and loading

- Set `lazy="raise"` on every relationship unless there is a documented reason otherwise, and choose eager loading per query. This turns hidden N+1 queries (and async `MissingGreenlet`) into immediate errors.
- `selectinload` for collections (joinedload on collections multiplies rows and needs `.unique()`); `joinedload` for many-to-one scalars; `subqueryload` only for collections with complex filters.
- Convert ORM to Pydantic (`from_attributes=True`) only after relationships are eagerly loaded.

## Other opinions

- Pool for production: `pool_size`, `max_overflow`, `pool_pre_ping=True`, `pool_recycle` (stale connections otherwise surface as random request failures).
- Bulk writes: `session.execute(insert(Model), [...])`, not `bulk_save_objects()`.
- With DDD, SQLAlchemy is a driven adapter: ORM models are separate from domain entities, repositories return domain objects and hold no business logic.

## References

- [references/PERFORMANCE.md](references/PERFORMANCE.md): read for bulk operations, streaming, query optimization.
- [references/LARGE_COLLECTIONS.md](references/LARGE_COLLECTIONS.md): read for WriteOnlyMapped, AssociationProxy, `type_annotation_map`.
- [references/MIGRATIONS.md](references/MIGRATIONS.md): read for Alembic setup and practices.
- [references/DDD_INFRASTRUCTURE.md](references/DDD_INFRASTRUCTURE.md): read for mapper/repository/UoW implementation in a DDD project.
- [references/MODELS_AND_POOLING.md](references/MODELS_AND_POOLING.md): read for the API-choice routing table, Annotated types and full model examples, pool sizing numbers, and the anti-patterns list.
