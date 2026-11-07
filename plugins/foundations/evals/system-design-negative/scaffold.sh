#!/usr/bin/env bash
# A small package with a pure money formatting function.
set -euo pipefail
mkdir -p src/shop
cat > pyproject.toml <<'TOML'
[project]
name = "shop"
version = "0.1.0"
requires-python = ">=3.12"
TOML
cat > src/shop/money.py <<'PY'
def format_money(cents: int, currency: str = "EUR") -> str:
    sign = "-" if cents < 0 else ""
    whole, frac = divmod(abs(cents), 100)
    return f"{sign}{whole}.{frac:02d} {currency}"
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
