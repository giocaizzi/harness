#!/usr/bin/env bash
# A Python package with a synchronous SQLAlchemy repository layer.
set -euo pipefail
cat > pyproject.toml <<'TOML'
[project]
name = "acme"
version = "0.1.0"
requires-python = ">=3.14"
dependencies = ["sqlalchemy>=2", "alembic"]

[tool.mypy]
strict = true

[tool.pytest.ini_options]
testpaths = ["tests"]
TOML
mkdir -p src/acme
cat > src/acme/models.py <<'PY'
from datetime import datetime

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    posts: Mapped[list["Post"]] = relationship(back_populates="author")


class Post(Base):
    __tablename__ = "posts"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(default=datetime.now)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    author: Mapped[User] = relationship(back_populates="posts")
PY
cat > src/acme/db.py <<'PY'
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

engine = create_engine("postgresql+psycopg://acme:secret@localhost/acme")
SessionLocal = sessionmaker(engine)
PY
cat > src/acme/repository.py <<'PY'
from sqlalchemy import select
from sqlalchemy.orm import Session

from acme.models import Post, User


class UserRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, user_id: int) -> User | None:
        return self._session.get(User, user_id)

    def by_email(self, email: str) -> User | None:
        return self._session.scalars(select(User).where(User.email == email)).first()

    def posts_of(self, user_id: int) -> list[Post]:
        return list(self._session.scalars(select(Post).where(Post.author_id == user_id)))

    def add(self, user: User) -> None:
        self._session.add(user)
        self._session.commit()
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
