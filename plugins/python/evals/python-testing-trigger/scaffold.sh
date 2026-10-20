#!/usr/bin/env bash
# A tiny uv project with an untested pricing function.
set -euo pipefail
mkdir -p src/shop
cat > pyproject.toml <<'TOML'
[project]
name = "shop"
version = "0.1.0"
requires-python = ">=3.12"
TOML
cat > src/shop/pricing.py <<'PY'
def apply_discount(price: float, percent: float) -> float:
    if not 0 <= percent <= 100:
        raise ValueError("percent must be between 0 and 100")
    return round(price * (1 - percent / 100), 2)
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
