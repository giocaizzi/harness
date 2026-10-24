#!/usr/bin/env bash
# A small app whose fetch_user is called from several modules.
set -euo pipefail
mkdir -p src/app tests
cat > src/app/users.py <<'PY'
from app.db import query


def fetch_user(user_id):
    rows = query("select * from users where id = ?", user_id)
    return rows[0] if rows else None


def fetch_users(ids):
    return [fetch_user(i) for i in ids]
PY
cat > src/app/db.py <<'PY'
def query(sql, *args):
    raise NotImplementedError
PY
for m in billing profile admin reports notify; do
  cat > src/app/$m.py <<PY
from app.users import fetch_user


def show(user_id):
    user = fetch_user(user_id)
    return {"$m": user}
PY
done
cat > tests/test_users.py <<'PY'
from app import users


def test_fetch_user_missing(monkeypatch):
    monkeypatch.setattr(users, "query", lambda *a: [])
    assert users.fetch_user(1) is None
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
