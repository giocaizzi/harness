#!/usr/bin/env bash
# A harness-made worktree branch, plus the base branch the brief names (one commit ahead of main).
set -euo pipefail
echo "# app" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git branch feat/notes-base
git switch -q feat/notes-base
echo "base" > BASE.md
git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat: base groundwork"
git switch -q -c worktree-agent-a1b2c3 main
