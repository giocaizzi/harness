#!/usr/bin/env bash
# A plain Python CLI module with no web framework.
set -euo pipefail
printf '[project]\nname = "acme-cli"\nversion = "0.1.0"\n' > pyproject.toml
printf 'import sys\n\n\ndef main():\n    print(sys.argv[1:])\n' > cli.py
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
