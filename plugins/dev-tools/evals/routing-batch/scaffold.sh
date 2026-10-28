#!/usr/bin/env bash
# A small shop package with three modules a plan extends.
set -euo pipefail
mkdir -p src/shop tests
: > src/shop/__init__.py
printf '"""Prices."""\n' > src/shop/pricing.py
printf '"""Shipping."""\n' > src/shop/shipping.py
printf '"""Taxes."""\n\nRATES = {"IT": 0.22, "DE": 0.19, "FR": 0.20}\n' > src/shop/tax.py
printf '[pytest]\npythonpath = src\n' > pytest.ini
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
