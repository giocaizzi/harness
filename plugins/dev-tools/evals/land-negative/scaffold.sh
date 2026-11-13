#!/usr/bin/env bash
# A repo on a feature branch with one commit ahead of main and no PR yet.
set -euo pipefail
mkdir -p src
printf 'def total(items):\n    return sum(items)\n' > src/cart.py
echo "# shop" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git switch -q -c feat/cart-discount
printf '\n\ndef discounted(items, pct):\n    return total(items) * (100 - pct) / 100\n' >> src/cart.py
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat: add percentage discount to cart total"
