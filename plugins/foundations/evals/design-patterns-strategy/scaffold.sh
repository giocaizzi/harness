#!/usr/bin/env bash
# A pricing module with a long if/elif on customer type.
set -euo pipefail
mkdir -p src/shop tests
cat > pyproject.toml <<'T'
[project]
name = "shop"
version = "0.1.0"
requires-python = ">=3.12"

[tool.pytest.ini_options]
pythonpath = ["src"]
T
cat > src/shop/pricing.py <<'T'
def price(customer_type: str, base_cents: int, quantity: int) -> int:
    if customer_type == "retail":
        total = base_cents * quantity
    elif customer_type == "wholesale":
        total = base_cents * quantity
        if quantity >= 100:
            total = int(total * 0.80)
        else:
            total = int(total * 0.90)
    elif customer_type == "student":
        total = int(base_cents * quantity * 0.85)
    elif customer_type == "employee":
        total = int(base_cents * quantity * 0.70)
    else:
        raise ValueError(f"unknown customer type: {customer_type}")
    return total
T
cat > tests/test_pricing.py <<'T'
from shop.pricing import price


def test_retail():
    assert price("retail", 1000, 2) == 2000


def test_wholesale_bulk():
    assert price("wholesale", 1000, 100) == 80000
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
