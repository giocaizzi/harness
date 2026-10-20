#!/usr/bin/env bash
# A tiny CLI repo on main.
set -euo pipefail
printf 'import sys\nprint(" ".join(sys.argv[1:]))\n' > cli.py
git init -q && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
