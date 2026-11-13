#!/usr/bin/env bash
# A repo with one staged change.
set -euo pipefail
printf 'def add(a, b):\n    return a + b\n' > calc.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
printf 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n' > calc.py
git add calc.py
