#!/usr/bin/env bash
# A repo with a feature branch holding two commits on top of main.
set -euo pipefail
mkdir -p app
echo 'def add(a, b):
    return a + b' > app/calc.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git switch -q -c feat/calc-ops
echo 'def sub(a, b):
    return a - b' >> app/calc.py
git -c user.name=eval -c user.email=eval@example.com commit -qam "feat: add sub"
echo 'def mul(a, b):
    return a * b' >> app/calc.py
git -c user.name=eval -c user.email=eval@example.com commit -qam "feat: add mul"
