#!/usr/bin/env bash
# A small orders service with a README typo.
set -euo pipefail
mkdir -p services/orders
cat > services/orders/README.md <<'MD'
# Orders service

Handles order placement and cancelation. Run it with `make run`; it listens
on port 8080 and reads its settings from the enviroment.
MD
cat > services/orders/main.py <<'PY'
def main() -> None:
    print("orders service")
PY
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
