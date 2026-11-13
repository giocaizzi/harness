#!/usr/bin/env bash
# A bare repo with code and no CI, task runner or secret scan.
set -euo pipefail
printf 'def main():\n    print("acme")\n' > app.py
printf '# acme/app\n' > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
