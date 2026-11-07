#!/usr/bin/env bash
# A service with an orders table and a migrations directory.
set -euo pipefail
mkdir -p migrations
cat > migrations/0001_create_orders.sql <<'SQL'
CREATE TABLE orders (
    id BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL,
    amount_cents BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL
cat > migrations/0002_add_orders_status_index.sql <<'SQL'
CREATE INDEX CONCURRENTLY orders_status_idx ON orders (status);
SQL
cat > README.md <<'MD'
Orders service. Production holds about 40 million rows in `orders`.
Migrations in `migrations/` are applied in order on deploy.
MD
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
