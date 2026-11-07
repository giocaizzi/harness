#!/usr/bin/env bash
# A small service with a payment handler that marks an order paid.
set -euo pipefail
mkdir -p src/billing
cat > pyproject.toml <<'TOML'
[project]
name = "billing"
version = "0.1.0"
requires-python = ">=3.12"
TOML
cat > src/billing/handler.py <<'PY'
import sqlite3


def handle_payment_webhook(db: sqlite3.Connection, payload: dict) -> None:
    order_id = payload["order_id"]
    with db:
        db.execute("UPDATE orders SET status = 'paid' WHERE id = ?", (order_id,))
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
