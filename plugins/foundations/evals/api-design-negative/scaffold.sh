#!/usr/bin/env bash
# A tiny FastAPI service whose /health reads a required env var.
set -euo pipefail
mkdir -p src/orders
cat > pyproject.toml <<'TOML'
[project]
name = "orders"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["fastapi"]
TOML
cat > src/orders/app.py <<'PY'
import os

from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "region": os.environ["REGION"]}
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
