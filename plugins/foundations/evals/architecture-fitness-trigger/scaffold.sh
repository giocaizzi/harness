#!/usr/bin/env bash
# A uv project whose domain package imports the db module.
set -euo pipefail
mkdir -p src/acme/domain src/acme/db
cat > pyproject.toml <<'TOML'
[project]
name = "acme"
version = "0.1.0"
requires-python = ">=3.12"
TOML
touch src/acme/__init__.py src/acme/domain/__init__.py src/acme/db/__init__.py
cat > src/acme/db/session.py <<'PY'
def save(table: str, row: dict[str, object]) -> None:
    print(f"insert into {table}: {row}")
PY
cat > src/acme/domain/orders.py <<'PY'
from acme.db import session


def place_order(order_id: str, total: float) -> None:
    if total <= 0:
        raise ValueError("total must be positive")
    session.save("orders", {"id": order_id, "total": total})
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
