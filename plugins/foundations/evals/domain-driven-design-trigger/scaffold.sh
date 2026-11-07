#!/usr/bin/env bash
# A small FastAPI service whose route queries SQLAlchemy directly.
set -euo pipefail
mkdir -p src/shop
cat > pyproject.toml <<'TOML'
[project]
name = "shop"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["fastapi", "sqlalchemy"]
TOML
cat > src/shop/app.py <<'PY'
from fastapi import FastAPI, HTTPException
from sqlalchemy import create_engine, text

app = FastAPI()
engine = create_engine("sqlite:///shop.db")


@app.post("/orders/{order_id}/pay")
def pay_order(order_id: int) -> dict[str, str]:
    with engine.begin() as conn:
        row = conn.execute(
            text("SELECT status FROM orders WHERE id = :id"), {"id": order_id}
        ).one_or_none()
        if row is None:
            raise HTTPException(404)
        if row.status != "placed":
            raise HTTPException(409)
        conn.execute(
            text("UPDATE orders SET status = 'paid' WHERE id = :id"), {"id": order_id}
        )
    return {"status": "paid"}
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
