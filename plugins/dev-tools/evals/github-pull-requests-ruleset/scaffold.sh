#!/usr/bin/env bash
# A Python repo whose CI workflow ends in an aggregate check job, with no branch rules set up.
set -euo pipefail
mkdir -p src/app tests .github/workflows
printf 'def total(items):\n    return sum(i["price"] for i in items)\n' > src/app/cart.py
printf 'from app.cart import total\n\n\ndef test_total():\n    assert total([{"price": 2}, {"price": 3}]) == 5\n' > tests/test_cart.py
cat > .github/workflows/ci.yml <<'YML'
name: CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pipx run ruff check .
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install pytest && PYTHONPATH=src pytest
  check:
    if: always()
    needs: [lint, test]
    runs-on: ubuntu-latest
    steps:
      - run: test "${{ contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') }}" = false
YML
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
