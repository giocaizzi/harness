#!/usr/bin/env bash
# A feature branch with uncommitted changes.
set -euo pipefail
mkdir -p app
cat > app/orders.py <<'P'
def place(order):
    print("placing", order)
    return True
P
echo '# app' > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git switch -q -c feat/order-validation
cat >> app/orders.py <<'P'


def validate(order):
    return bool(order.get("items"))
P
