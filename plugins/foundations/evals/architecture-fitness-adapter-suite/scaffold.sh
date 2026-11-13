#!/usr/bin/env bash
# A Python package with a Postgres and an in-memory repository and separate tests.
set -euo pipefail
mkdir -p src/orders tests
cat > pyproject.toml <<'T'
[project]
name = "orders"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["psycopg"]

[tool.pytest.ini_options]
pythonpath = ["src"]
T
cat > src/orders/ports.py <<'T'
from typing import Protocol


class OrderRepository(Protocol):
    def add(self, order_id: str, total: int) -> None: ...
    def get(self, order_id: str) -> int | None: ...
T
cat > src/orders/memory.py <<'T'
class InMemoryOrderRepository:
    def __init__(self) -> None:
        self._rows: dict[str, int] = {}

    def add(self, order_id: str, total: int) -> None:
        self._rows[order_id] = total  # silently overwrites a duplicate

    def get(self, order_id: str) -> int | None:
        return self._rows.get(order_id)
T
cat > src/orders/postgres.py <<'T'
import psycopg


class PostgresOrderRepository:
    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def add(self, order_id: str, total: int) -> None:
        self._conn.execute("INSERT INTO orders (id, total) VALUES (%s, %s)", (order_id, total))  # duplicate raises

    def get(self, order_id: str) -> int | None:
        row = self._conn.execute("SELECT total FROM orders WHERE id = %s", (order_id,)).fetchone()
        return row[0] if row else None
T
cat > tests/test_memory.py <<'T'
from orders.memory import InMemoryOrderRepository


def test_add_and_get():
    repo = InMemoryOrderRepository()
    repo.add("a", 10)
    assert repo.get("a") == 10
T
cat > tests/test_postgres.py <<'T'
import pytest

psycopg = pytest.importorskip("psycopg")


def test_add_and_get_needs_database():
    pytest.skip("needs a running Postgres")
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
