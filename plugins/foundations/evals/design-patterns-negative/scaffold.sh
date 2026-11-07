#!/usr/bin/env bash
# A tiny project with one dataclass.
set -euo pipefail
mkdir -p src/orders
cat > pyproject.toml <<'TOML'
[project]
name = "orders"
version = "0.1.0"
requires-python = ">=3.12"
TOML
cat > src/orders/model.py <<'PY'
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Order:
    id: str
    customer_id: str
    total_minor: int
    currency: str
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
