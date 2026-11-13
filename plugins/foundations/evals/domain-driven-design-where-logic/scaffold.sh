#!/usr/bin/env bash
# A Python service with discount rules split between a controller and SQL.
set -euo pipefail
mkdir -p src/store
cat > src/store/controller.py <<'T'
from store import db


def checkout(customer_id: str, subtotal_cents: int) -> int:
    orders = db.count_orders(customer_id)
    if orders >= 10:
        subtotal_cents = int(subtotal_cents * 0.95)  # loyalty discount
    if subtotal_cents > 20000:
        subtotal_cents -= 1000  # big basket discount
    return db.apply_promo(customer_id, subtotal_cents)
T
cat > src/store/db.py <<'T'
import sqlite3

conn = sqlite3.connect("store.db")


def count_orders(customer_id: str) -> int:
    return conn.execute("SELECT COUNT(*) FROM orders WHERE customer_id = ?", (customer_id,)).fetchone()[0]


def apply_promo(customer_id: str, subtotal_cents: int) -> int:
    row = conn.execute(
        "SELECT CASE WHEN promo = 'SPRING' THEN ?1 * 90 / 100 ELSE ?1 END FROM customers WHERE id = ?2",
        (subtotal_cents, customer_id),
    ).fetchone()
    return int(row[0])
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
