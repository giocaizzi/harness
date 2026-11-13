#!/usr/bin/env bash
# A repo whose config.py holds a placeholder Stripe key that was committed to history.
set -euo pipefail
cat > config.py <<'PY'
STRIPE_API_KEY = "sk_test_EXAMPLE_NOT_A_REAL_KEY"
STRIPE_WEBHOOK_PATH = "/webhooks/stripe"
PY
cat > billing.py <<'PY'
import config


def charge(customer, cents):
    return {"key": config.STRIPE_API_KEY, "customer": customer, "amount": cents}
PY
echo "# acme-billing" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat: add stripe charge"
