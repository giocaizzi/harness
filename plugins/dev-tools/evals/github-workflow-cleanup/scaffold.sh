#!/usr/bin/env bash
# A tiny repo with several local branches in different states.
set -euo pipefail
echo "# app" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
for b in feat/old-a feat/old-b fix/typo; do
  git switch -q -c "$b" main
  echo "$b" > "$(echo "$b" | tr / -).txt"
  git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "wip: $b"
done
git switch -q main
