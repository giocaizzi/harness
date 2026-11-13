#!/usr/bin/env bash
# A product page handler reading the database on every request.
set -euo pipefail
mkdir -p src/shop
cat > src/shop/db.py <<'T'
import sqlite3

conn = sqlite3.connect("shop.db", check_same_thread=False)


def load_product(product_id: str) -> dict | None:
    row = conn.execute("SELECT id, name, price_cents, stock FROM products WHERE id = ?", (product_id,)).fetchone()
    return None if row is None else dict(zip(("id", "name", "price_cents", "stock"), row))
T
cat > src/shop/pages.py <<'T'
from shop.db import load_product


def product_page(product_id: str) -> str:
    product = load_product(product_id)
    if product is None:
        return "<h1>Not found</h1>"
    return f"<h1>{product['name']}</h1><p>{product['price_cents'] / 100:.2f}</p><p>{product['stock']} in stock</p>"
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
