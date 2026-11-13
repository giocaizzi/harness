#!/usr/bin/env bash
# A repo with a docs/adr directory holding one existing decision record.
set -euo pipefail
mkdir -p docs/adr src/orders
cat > docs/adr/0001-use-postgres.md <<'T'
# 1. Use Postgres as the system of record

Status: accepted

## Context
We need transactions and relational queries for orders and payments.

## Decision
Use managed Postgres.

## Consequences
Schema migrations are part of every release.
T
cat > src/orders/events.py <<'T'
def publish_order_created(order_id: str) -> None:
    print(f"order.created {order_id}")  # placeholder until a broker is chosen
T
cat > README.md <<'T'
# Orders service

Peak load is about 300 orders per minute, expected to triple within a year.
Order events are consumed by billing and email, each owned by a different team.
T
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
