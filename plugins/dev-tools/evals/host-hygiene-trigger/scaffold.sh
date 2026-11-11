#!/usr/bin/env bash
# A tiny repo with extra local branches left behind.
set -euo pipefail
echo "# app" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
for i in 1 2 3 4 5; do git branch "agent/leftover-$i"; done
