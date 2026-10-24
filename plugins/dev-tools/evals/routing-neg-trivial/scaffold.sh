#!/usr/bin/env bash
# An empty repo.
set -euo pipefail
printf "# scratch\n" > README.md
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
