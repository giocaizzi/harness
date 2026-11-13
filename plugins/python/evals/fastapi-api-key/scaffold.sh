#!/usr/bin/env bash
# A FastAPI app with public routes and an admin router.
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
from fastapi import APIRouter, FastAPI

app = FastAPI()
admin = APIRouter(prefix="/admin")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@admin.get("/users")
def list_users() -> list[dict[str, str]]:
    return [{"name": "ada"}]


@admin.delete("/users/{name}")
def delete_user(name: str) -> dict[str, str]:
    return {"deleted": name}


app.include_router(admin)
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
