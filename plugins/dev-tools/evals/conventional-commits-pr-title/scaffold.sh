#!/usr/bin/env bash
# A branch with one bug-fix commit.
set -euo pipefail
printf 'def greet(name):\n    return "hi " + name\n' > app.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git checkout -q -b fix/null-name
printf 'def greet(name):\n    return "hi " + (name or "there")\n' > app.py
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm wip
