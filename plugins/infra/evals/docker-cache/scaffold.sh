#!/usr/bin/env bash
# A Python service whose Dockerfile copies the source before installing dependencies.
set -euo pipefail
mkdir -p src/orders
cat > pyproject.toml <<'TOML'
[project]
name = "orders"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["fastapi", "uvicorn", "sqlalchemy"]
TOML
cat > src/orders/main.py <<'PY'
from fastapi import FastAPI

app = FastAPI()


@app.get("/orders")
def list_orders() -> list[dict]:
    return []
PY
cat > Dockerfile <<'DOCKER'
FROM python:3.13
WORKDIR /app
COPY . .
RUN pip install .
CMD uvicorn orders.main:app --host 0.0.0.0
DOCKER
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
