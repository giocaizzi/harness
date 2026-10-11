# Models, Pooling, Routing and Anti-Patterns

## Routing table

| Question | Default |
|----------|---------|
| Which API style? | v2 only. |
| How to manage transactions? | Explicit boundaries with `session.begin()`. |
| When to use async sessions? | Only when both request handling and database access run through async code paths in async-first frameworks (FastAPI, Starlette, aiohttp). Otherwise sync. |

## Annotated types

```python
from typing import Annotated
from datetime import datetime
from sqlalchemy import String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

intpk = Annotated[int, mapped_column(primary_key=True)]
timestamp = Annotated[datetime, mapped_column(server_default=func.now())]
str50 = Annotated[str, mapped_column(String(50))]
```

## Model example

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

## MappedAsDataclass

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

`default` controls `__init__()`, `insert_default` controls SQL defaults. `frozen`/`slots` are not supported.

## Connection pooling (production)

```python
engine = create_async_engine(
    database_url,
    pool_size=20,       # base connections
    max_overflow=10,    # temporary extra connections
    pool_pre_ping=True, # detect stale connections
    pool_recycle=3600,  # recycle connections after 1 hour
)
```

## Anti-patterns

- `session.query(User)` -> use `select(User)`
- `Column(String(50))` -> use `Mapped[str] = mapped_column(String(50))`
- `joinedload` for collections -> use `selectinload`
- `bulk_save_objects()` -> use `session.execute(insert(Model), [...])`
- No `lazy="raise"` on relationships -> implicit N+1 queries
- Business logic in repositories -> repositories are persistence only
- Exposing ORM models from repositories -> return domain models in DDD
