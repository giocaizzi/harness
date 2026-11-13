#!/usr/bin/env bash
# A Python package with SQLAlchemy models and an Alembic dir holding one migration.
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
mkdir -p alembic/versions
cat > alembic.ini <<'INI'
[alembic]
script_location = alembic
sqlalchemy.url = sqlite:///acme.db
INI
cat > alembic/env.py <<'PY'
from alembic import context
from sqlalchemy import engine_from_config, pool

from acme.models import Base

config = context.config
target_metadata = Base.metadata


def run_migrations_online() -> None:
    connectable = engine_from_config(config.get_section(config.config_ini_section, {}), poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
PY
cat > alembic/versions/0001_initial.py <<'PY'
"""initial

Revision ID: 0001
Revises:
"""
import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
    )
    op.create_table(
        "posts",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("author_id", sa.ForeignKey("users.id"), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("posts")
    op.drop_table("users")
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
