#!/usr/bin/env bash
# A small library with a public function.
set -euo pipefail
printf 'def request(url):\n    return url\n' > lib.py
printf '[project]\nname = "lib"\nversion = "1.3.0"\n' > pyproject.toml
git init -q -b main && git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm init
