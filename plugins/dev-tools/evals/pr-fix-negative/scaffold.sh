#!/usr/bin/env bash
# A feature branch with a commit and no PR.
set -euo pipefail
printf 'def total(xs):\n    return sum(xs)\n' > cart.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git checkout -q -b feat/cart-total
printf 'def total(xs):\n    return sum(xs) or 0\n' > cart.py
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat: cart total"
