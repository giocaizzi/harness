#!/usr/bin/env bash
# Three API handlers with no validation.
set -euo pipefail
mkdir -p api/handlers tests
: > api/__init__.py
: > api/handlers/__init__.py
for h in users orders invoices; do
  cat > api/handlers/$h.py <<PY
def create(payload):
    return {"status": 201, "body": payload}
PY
done
cat > api/schema.md <<'MD'
- users: name (str), email (str), age (int, optional)
- orders: user_id (int), items (list of str), total (float)
- invoices: order_id (int), amount (float), due (ISO date str)
MD
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
