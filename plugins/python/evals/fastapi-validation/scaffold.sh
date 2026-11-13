#!/usr/bin/env bash
# A FastAPI app whose POST /orders takes a plain Pydantic model with no constraints.
set -euo pipefail
cat > pyproject.toml <<'TOML'
[project]
name = "acme"
version = "0.1.0"
requires-python = ">=3.14"
dependencies = ["fastapi", "uvicorn", "pydantic", "pydantic-settings"]

[tool.mypy]
strict = true

[tool.pytest.ini_options]
testpaths = ["tests"]
TOML
mkdir -p src/acme tests
cat > src/acme/main.py <<'PY'
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class OrderIn(BaseModel):
    sku: str
    quantity: int


@app.post("/orders", status_code=201)
def create_order(order: OrderIn) -> dict[str, int | str]:
    return {"sku": order.sku, "quantity": order.quantity}
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
