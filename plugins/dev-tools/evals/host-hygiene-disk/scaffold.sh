#!/usr/bin/env bash
# A tiny repo; the prompt describes a host problem.
set -euo pipefail
echo "# app" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
