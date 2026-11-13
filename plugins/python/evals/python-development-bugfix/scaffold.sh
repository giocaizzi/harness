#!/usr/bin/env bash
# A small Python package whose parse_price mishandles thousands separators.
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
mkdir -p src/acme tests
cat > src/acme/pricing.py <<'PY'
def parse_price(text: str) -> float:
    cleaned = text.strip().lstrip("$")
    return float(cleaned.split(",")[0])
PY
cat > tests/test_pricing.py <<'PY'
from acme.pricing import parse_price


def test_plain() -> None:
    assert parse_price("12.50") == 12.5
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
