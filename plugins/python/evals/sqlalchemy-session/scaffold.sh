#!/usr/bin/env bash
# SQLAlchemy 2 models with a User to Order relationship.
set -euo pipefail
printf '[project]\nname = "acme-app"\nversion = "0.1.0"\ndependencies = ["sqlalchemy>=2"]\n' > pyproject.toml
printf 'from sqlalchemy import ForeignKey\nfrom sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship\n\n\nclass Base(DeclarativeBase):\n    pass\n\n\nclass User(Base):\n    __tablename__ = "users"\n    id: Mapped[int] = mapped_column(primary_key=True)\n    name: Mapped[str]\n    orders: Mapped[list["Order"]] = relationship()\n\n\nclass Order(Base):\n    __tablename__ = "orders"\n    id: Mapped[int] = mapped_column(primary_key=True)\n    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))\n' > models.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
