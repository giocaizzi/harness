# Alembic Migrations

Alembic is the standard migration tool for SQLAlchemy.

## Setup

```bash
pip install alembic
alembic init migrations
```

Configure `migrations/env.py` to import your `Base.metadata`:

```python
from models import Base
target_metadata = Base.metadata
```

## Naming Conventions

Set on metadata to get predictable constraint names (required for reliable auto-generation):

```python
convention = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=convention)
```

## Auto-Generate Migrations

```bash
alembic revision --autogenerate -m "add users table"
```

**Always review generated migrations manually.** Auto-generate detects:
- Table/column additions and removals
- Type changes, nullable changes
- Index and constraint changes

It does **not** detect: table/column renames (shows as drop+create), data migrations, or custom DDL.

## Apply Migrations

```bash
alembic upgrade head      # apply all pending
alembic downgrade -1      # rollback one
alembic history           # show migration history
alembic current           # show current revision
```

## Async Alembic

For async engines, configure `env.py` with `run_async`:

```python
from sqlalchemy.ext.asyncio import create_async_engine

async def run_async_migrations():
    engine = create_async_engine(config.get_main_option("sqlalchemy.url"))
    async with engine.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await engine.dispose()
```

## Online / Zero-Downtime Migrations

For production with no downtime:
1. **Add columns as nullable** first, deploy code that writes to both old and new.
2. **Backfill data** in batches.
3. **Deploy code** that reads from new column.
4. **Add NOT NULL constraint** and drop old column.

Never rename columns directly — add new, migrate data, drop old.

## Best Practices

- One migration per logical change.
- Name migrations descriptively: `add_user_email_column`, not `migration_42`.
- Test migrations on a copy of production data before deploying.
- Keep migrations in version control alongside code.
- Never edit migrations that have been applied in production.
