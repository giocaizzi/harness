#!/usr/bin/env bash
# A tiny repo; the prompt asks a general concept question, not about machine health or leftovers.
set -euo pipefail
echo "# app" > README.md
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
