#!/usr/bin/env bash
# An empty repo with only a README.
set -euo pipefail
cat > README.md <<'MD'
# wordcount

Counts the words in files.
MD
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
