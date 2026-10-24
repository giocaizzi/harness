#!/usr/bin/env bash
# A catalog service with read-heavy database access.
set -euo pipefail
mkdir -p catalog
cat > catalog/db.py <<'PY'
import sqlite3


def connect(path="catalog.db"):
    return sqlite3.connect(path)


def product(conn, pid):
    return conn.execute("select id, name, price, stock from products where id = ?", (pid,)).fetchone()


def category_products(conn, cid):
    return conn.execute("select id, name, price from products where category = ? order by name", (cid,)).fetchall()


def update_price(conn, pid, price):
    conn.execute("update products set price = ? where id = ?", (price, pid))


def update_stock(conn, pid, delta):
    conn.execute("update products set stock = stock + ? where id = ?", (delta, pid))
PY
cat > catalog/api.py <<'PY'
from catalog import db


def get_product(conn, pid):
    return db.product(conn, pid)


def list_category(conn, cid):
    return db.category_products(conn, cid)


def set_price(conn, pid, price):
    db.update_price(conn, pid, price)


def reserve(conn, pid, qty):
    db.update_stock(conn, pid, -qty)
PY
cat > README.md <<'MD'
# catalog

Product catalog service. Reads are about 95% of traffic; prices change a few times a day, stock on every order. It runs as 4 replicas behind a load balancer.
MD
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
