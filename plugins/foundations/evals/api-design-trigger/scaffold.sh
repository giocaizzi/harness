#!/usr/bin/env bash
# A tiny FastAPI service with customers and invoices tables.
set -euo pipefail
mkdir -p src/billing
cat > pyproject.toml <<'TOML'
[project]
name = "billing"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["fastapi"]
TOML
cat > src/billing/db.py <<'PY'
import sqlite3

conn = sqlite3.connect("billing.db", check_same_thread=False)
conn.row_factory = sqlite3.Row
conn.execute(
    "CREATE TABLE IF NOT EXISTS invoices ("
    "id TEXT PRIMARY KEY, customer_id TEXT, amount_minor INTEGER, currency TEXT, created_at TEXT)"
)
PY
cat > src/billing/app.py <<'PY'
from fastapi import FastAPI, HTTPException

from billing.db import conn

app = FastAPI()


@app.get("/customers/{customer_id}")
def get_customer(customer_id: str) -> dict:
    row = conn.execute("SELECT 1 FROM invoices WHERE customer_id = ?", (customer_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="customer not found")
    return {"id": customer_id}
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
