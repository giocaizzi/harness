#!/usr/bin/env bash
# A uv project with a ruff config and one unused variable.
set -euo pipefail
mkdir -p src/shop
cat > pyproject.toml <<'TOML'
[project]
name = "shop"
version = "0.1.0"
requires-python = ">=3.12"

[tool.ruff.lint]
select = ["E", "F"]
TOML
cat > src/shop/cart.py <<'PY'
def cart_total(prices: list[float]) -> float:
    count = len(prices)
    return sum(prices)
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
