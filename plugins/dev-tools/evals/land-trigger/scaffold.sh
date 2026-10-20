#!/usr/bin/env bash
# A tiny repo on a feature branch, as if PR 42 were open.
set -euo pipefail
echo "# app" > README.md
git init -q -b feat/json-flag && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "feat: add json flag"
