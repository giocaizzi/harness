#!/usr/bin/env bash
# A Python package with app.cli and app.api subpackages and a Makefile check target.
set -euo pipefail
mkdir -p src/app/cli src/app/api tests
cat > pyproject.toml <<'T'
[project]
name = "app"
version = "0.1.0"
requires-python = ">=3.12"

[tool.pytest.ini_options]
pythonpath = ["src"]
T
cat > Makefile <<'T'
.PHONY: lint test check
lint:
	uv run ruff check .
test:
	uv run pytest
check: lint test
T
touch src/app/__init__.py src/app/cli/__init__.py src/app/api/__init__.py
cat > src/app/api/service.py <<'T'
def list_users() -> list[str]:
    return ["ada", "grace"]
T
cat > src/app/cli/main.py <<'T'
from app.api.service import list_users


def main() -> None:
    for user in list_users():
        print(user)
T
cat > tests/test_cli.py <<'T'
def test_placeholder():
    assert True
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
