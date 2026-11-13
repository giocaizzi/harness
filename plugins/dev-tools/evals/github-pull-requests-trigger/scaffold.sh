#!/usr/bin/env bash
# A tiny repo with a feature branch and committed-but-unpushed work.
set -euo pipefail
echo "# app" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
git switch -q -c feat/usage
echo "Run with app --help." >> README.md
git -c user.name=eval -c user.email=eval@example.com commit -qam "docs: add usage"
