#!/usr/bin/env bash
# A FastAPI app with a hard-coded database URL and debug flag.
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

DATABASE_URL = "postgresql://acme:secret@localhost:5432/acme"
DEBUG = True

app = FastAPI(debug=DEBUG)


@app.get("/info")
def info() -> dict[str, str]:
    return {"db": DATABASE_URL.rsplit("/", 1)[-1]}
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
