#!/usr/bin/env bash
# A repo with a feature branch holding one commit on top of main.
set -euo pipefail
mkdir -p app
cat > app/pricing.py <<'P'
def price_with_tax(amount, rate):
    return amount * (1 + rate)
P
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git switch -q -c feat/discounts
cat >> app/pricing.py <<'P'


def apply_discount(amount, pct):
    return amount - amount * pct / 100
P
git -c user.name=eval -c user.email=eval@example.com commit -qam "feat: add discounts"
