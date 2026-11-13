#!/usr/bin/env bash
# A Python package with mypy --strict configured and real type errors in src/report/.
set -euo pipefail
cat > pyproject.toml <<'TOML'
[project]
name = "acme"
version = "0.1.0"
requires-python = ">=3.14"
dependencies = []

[tool.mypy]
strict = true

[tool.pytest.ini_options]
testpaths = ["tests"]
TOML
mkdir -p src/report tests
touch src/report/__init__.py
printf '.PHONY: typecheck\ntypecheck:\n\tuv run mypy src\n' > Makefile
cat > src/report/build.py <<'PY'
def total(rows):
    return sum(r["amount"] for r in rows)


def by_customer(rows) -> dict[str, float]:
    out = {}
    for r in rows:
        out[r["customer"]] = out.get(r["customer"], 0) + r["amount"]
    return out


def top(rows, n: int = 3) -> list[str]:
    totals = by_customer(rows)
    return sorted(totals, key=totals.get, reverse=True)[:n]
PY
cat > src/report/render.py <<'PY'
from report.build import total, top


def render(rows: list[dict[str, float]]) -> str:
    lines = ["Total: " + total(rows)]
    for name in top(rows):
        lines.append(f"- {name}")
    return "\n".join(lines)


def title(name) -> str:
    return name.upper() + 1
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
