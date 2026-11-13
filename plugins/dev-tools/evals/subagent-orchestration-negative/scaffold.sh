#!/usr/bin/env bash
# A tiny repo with one file.
set -euo pipefail
echo '# app' > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
