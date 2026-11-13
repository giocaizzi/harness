#!/usr/bin/env bash
# A repo with one failing test.
set -euo pipefail
printf 'def total(xs):\n    return sum(xs) + 1\n' > cart.py
printf 'from cart import total\n\n\ndef test_total():\n    assert total([1, 2]) == 3\n' > test_cart.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
