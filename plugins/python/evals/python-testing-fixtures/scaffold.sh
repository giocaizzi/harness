#!/usr/bin/env bash
# A uv project whose order tests hang off a deep fixture chain.
set -euo pipefail
mkdir -p src/shop tests
cat > pyproject.toml <<'TOML'
[project]
name = "shop"
version = "0.1.0"
requires-python = ">=3.12"

[dependency-groups]
dev = ["pytest"]
TOML
cat > src/shop/__init__.py <<'PY'
PY
cat > src/shop/orders.py <<'PY'
from dataclasses import dataclass, field


@dataclass
class Customer:
    email: str
    vip: bool = False


@dataclass
class Order:
    customer: Customer
    lines: list[tuple[str, float, int]] = field(default_factory=list)

    def total(self) -> float:
        subtotal = sum(price * qty for _, price, qty in self.lines)
        return round(subtotal * (0.9 if self.customer.vip else 1.0), 2)
PY
cat > tests/conftest.py <<'PY'
import random

import pytest

from shop.orders import Customer, Order


@pytest.fixture
def email():
    return f"user{random.randint(1, 9999)}@example.com"


@pytest.fixture
def customer(email):
    return Customer(email=email)


@pytest.fixture
def vip_customer(customer):
    customer.vip = True
    return customer


@pytest.fixture
def order(customer):
    return Order(customer=customer)


@pytest.fixture
def filled_order(order):
    order.lines.append(("book", 12.5, 2))
    order.lines.append(("pen", 1.2, 3))
    return order


@pytest.fixture
def vip_order(vip_customer, filled_order):
    filled_order.customer = vip_customer
    return filled_order
PY
cat > tests/test_orders.py <<'PY'
def test_total(filled_order):
    assert filled_order.total() == 28.6


def test_vip_total(vip_order):
    assert vip_order.total() == 25.74


def test_empty(order):
    assert order.total() == 0
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
