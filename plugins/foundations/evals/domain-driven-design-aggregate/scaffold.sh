#!/usr/bin/env bash
# An order model with free-form item adds and a shipped status.
set -euo pipefail
mkdir -p src/orders tests
cat > pyproject.toml <<'T'
[project]
name = "orders"
version = "0.1.0"
requires-python = ">=3.12"

[tool.pytest.ini_options]
pythonpath = ["src"]
T
cat > src/orders/model.py <<'T'
from dataclasses import dataclass, field


@dataclass
class Order:
    id: str
    status: str = "open"
    items: list[tuple[str, int]] = field(default_factory=list)


def ship(order: Order) -> None:
    order.status = "shipped"
T
cat > src/orders/service.py <<'T'
from orders.model import Order


def add_item(order: Order, sku: str, qty: int) -> None:
    order.items.append((sku, qty))
T
cat > tests/test_service.py <<'T'
from orders.model import Order
from orders.service import add_item


def test_add_item():
    order = Order("o1")
    add_item(order, "lamp", 1)
    assert order.items == [("lamp", 1)]
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
