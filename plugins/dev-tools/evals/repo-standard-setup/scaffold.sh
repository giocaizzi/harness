#!/usr/bin/env bash
# A fresh repo with a single module.
set -euo pipefail
printf 'def main():\n    print("acme")\n' > app.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
