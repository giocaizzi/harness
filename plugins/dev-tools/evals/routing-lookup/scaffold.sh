#!/usr/bin/env bash
# A web app whose handlers reach the database through several layers of helpers.
set -euo pipefail
mkdir -p app/web app/domain app/infra
cat > app/infra/db.py <<'PY'
def query(sql, *args):
    raise NotImplementedError


def execute(sql, *args):
    raise NotImplementedError
PY
cat > app/infra/cache.py <<'PY'
_store = {}


def cached(key, load):
    if key not in _store:
        _store[key] = load()
    return _store[key]
PY
cat > app/domain/users.py <<'PY'
from app.infra import db
from app.infra.cache import cached


def user(uid):
    return cached(("user", uid), lambda: db.query("select * from users where id = ?", uid))


def rename(uid, name):
    db.execute("update users set name = ? where id = ?", name, uid)
PY
cat > app/domain/orders.py <<'PY'
from app.domain.users import user
from app.domain.pricing import total


def order_summary(order):
    return {"buyer": user(order["uid"]), "total": total(order["lines"])}
PY
cat > app/domain/pricing.py <<'PY'
def total(lines):
    return sum(l["qty"] * l["price"] for l in lines)
PY
cat > app/domain/reports.py <<'PY'
from app.infra import db


def daily(day):
    return db.query("select * from orders where day = ?", day)
PY
cat > app/domain/audit.py <<'PY'
from app.domain import reports


def audit(day):
    return len(reports.daily(day))
PY
cat > app/web/handlers.py <<'PY'
from app.domain.orders import order_summary
from app.domain.pricing import total
from app.domain.users import rename
from app.domain.audit import audit


def get_order(req):
    return order_summary(req["order"])


def get_quote(req):
    return total(req["lines"])


def post_rename(req):
    rename(req["uid"], req["name"])


def get_audit(req):
    return audit(req["day"])
PY
cat > app/web/health.py <<'PY'
def health(req):
    return {"ok": True}
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
