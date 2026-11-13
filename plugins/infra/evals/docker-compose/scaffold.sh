#!/usr/bin/env bash
# A Python service with a Dockerfile and no compose file.
set -euo pipefail
mkdir -p src/orders
cat > pyproject.toml <<'T'
[project]
name = "orders"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["fastapi", "uvicorn", "sqlalchemy", "psycopg", "redis"]
T
cat > src/orders/main.py <<'P'
import os

from fastapi import FastAPI

app = FastAPI()
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://orders:orders@localhost/orders")
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")


@app.get("/orders")
def list_orders() -> list[dict]:
    return []
P
cat > Dockerfile <<'D'
FROM python:3.13-slim
WORKDIR /app
COPY pyproject.toml .
COPY src ./src
RUN pip install --no-cache-dir .
CMD ["uvicorn", "orders.main:app", "--host", "0.0.0.0", "--port", "8000"]
D
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
